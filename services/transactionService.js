/**
 * Juragan Pulsa - Transaction Service
 * services/transactionService.js
 */

const db = require('../config/database');
const { getProductBySku, calculateAgentPrice } = require('./productService');
const { getAgentById, deductBalance, refundBalance } = require('./agentService');
const { getProviderById, getAdapter, getDefaultProvider } = require('./providers/providerFactory');
const { generateRefId } = require('../utils/generateRefId');
const { paginate } = require('../utils/helpers');
const logger = require('../utils/logger');

/**
 * Buat transaksi pembelian pulsa / PPOB
 * Flow:
 * 1. Cek ketersediaan produk & saldo agen
 * 2. Potong saldo agen secara atomik (SQLite transaction)
 * 3. Kirim request ke provider H2H
 * 4. Update status transaksi berdasarkan response provider
 * 5. Auto-refund jika vendor langsung merespon gagal
 */
async function createTransaction(agentId, { sku, target, channel = 'app' }) {
  if (!sku || !target) {
    throw new Error('SKU produk dan nomor tujuan wajib diisi');
  }

  const agent = getAgentById(agentId);
  if (!agent) throw new Error('Agen tidak ditemukan');
  if (!agent.is_active) throw new Error('Akun agen Anda sedang tidak aktif');

  const product = getProductBySku(sku);
  if (!product) throw new Error('Produk tidak ditemukan');
  if (!product.is_active) throw new Error('Produk sedang gangguan / tidak aktif');

  const provider = getProviderById(product.provider_id) || getDefaultProvider();
  if (!provider || !provider.is_active) throw new Error('Provider H2H sedang tidak aktif');

  const sellPrice = calculateAgentPrice(product, agent);
  const modalPrice = product.price_modal;
  const profit = Math.max(0, sellPrice - modalPrice);

  if (agent.balance < sellPrice) {
    throw new Error(`Saldo tidak mencukupi (Saldo: Rp ${agent.balance.toLocaleString('id-ID')}, Dibutuhkan: Rp ${sellPrice.toLocaleString('id-ID')})`);
  }

  const refId = generateRefId(agentId);

  // 1. Potong saldo & simpan initial pending transaction dalam satu atomic SQLite transaction
  const initialTx = db.transaction(() => {
    // Potong saldo
    deductBalance(agentId, sellPrice, refId, `Beli ${product.product_name} ke ${target}`);

    // Insert record transaksi pending
    const res = db.prepare(`
      INSERT INTO transactions (
        agent_id, provider_id, ref_id, product_sku, product_name,
        category, brand, target, price_modal, price_sell, profit,
        status, message, channel, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        'pending', 'Sedang diproses ke vendor', ?, datetime('now','localtime'), datetime('now','localtime')
      )
    `).run(
      agentId,
      provider.id,
      refId,
      product.sku,
      product.product_name,
      product.category,
      product.brand,
      String(target).trim(),
      modalPrice,
      sellPrice,
      profit,
      channel
    );

    return {
      id: res.lastInsertRowid,
      ref_id: refId,
    };
  });

  const created = initialTx();
  logger.info(`[Transaction] Created #${created.id} (Ref: ${refId}) by Agent #${agentId} for ${sku} -> ${target}`);

  // 2. Call API Provider H2H
  let vendorResult;
  try {
    const adapter = getAdapter(provider.name);
    vendorResult = await adapter.createTransaction(provider, {
      sku: product.sku,
      target: String(target).trim(),
      refId: refId,
    });
  } catch (err) {
    logger.error(`[Transaction] Error calling provider for Ref: ${refId} - ${err.message}`);
    // Jika provider error/timeout, status tetap pending atau failed jika error eksplisit
    vendorResult = {
      status: 'failed',
      message: err.message,
      sn: '',
      trx_id: '',
      raw: { error: err.message },
    };
  }

  // 3. Update transaksi dengan hasil dari vendor
  const finalStatus = vendorResult.status || 'pending';
  let isRefunded = 0;

  if (finalStatus === 'failed') {
    // Auto-refund
    logger.warn(`[Transaction] Failed for Ref: ${refId}. Melakukan auto-refund Rp ${sellPrice}`);
    refundBalance(agentId, sellPrice, refId, `Refund transaksi gagal: ${product.product_name} ke ${target}`);
    isRefunded = 1;
  }

  db.prepare(`
    UPDATE transactions SET
      provider_ref_id = ?,
      sn = ?,
      status = ?,
      message = ?,
      provider_response = ?,
      is_refunded = ?,
      updated_at = datetime('now','localtime')
    WHERE id = ?
  `).run(
    vendorResult.trx_id || '',
    vendorResult.sn || '',
    finalStatus,
    vendorResult.message || '',
    JSON.stringify(vendorResult.raw || {}),
    isRefunded,
    created.id
  );

  const updatedTx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(created.id);
  const updatedAgent = getAgentById(agentId);

  return {
    transaction: updatedTx,
    balanceAfter: updatedAgent.balance,
  };
}

/**
 * Cek status ulang transaksi ke provider
 */
async function checkTransactionStatus(transactionId, agentId = null) {
  let sql = 'SELECT t.*, p.name as provider_name FROM transactions t JOIN providers p ON p.id = t.provider_id WHERE t.id = ?';
  const params = [transactionId];
  if (agentId) {
    sql += ' AND t.agent_id = ?';
    params.push(agentId);
  }

  const tx = db.prepare(sql).get(...params);
  if (!tx) throw new Error('Transaksi tidak ditemukan');

  const provider = getProviderById(tx.provider_id);
  if (!provider) throw new Error('Provider tidak ditemukan');

  const adapter = getAdapter(provider.name);
  const checkResult = await adapter.checkTransaction(provider, tx.ref_id, tx.product_sku, tx.target);

  const newStatus = checkResult.status || tx.status;
  let isRefunded = tx.is_refunded;

  // Jika sebelumnya pending dan sekarang failed, lakukan refund
  if (tx.status === 'pending' && newStatus === 'failed' && !isRefunded && tx.agent_id) {
    logger.warn(`[Transaction] Check status #${tx.id} berubah ke FAILED. Refund balance Rp ${tx.price_sell}`);
    refundBalance(tx.agent_id, tx.price_sell, tx.ref_id, `Refund transaksi gagal (${tx.ref_id})`);
    isRefunded = 1;
  }

  db.prepare(`
    UPDATE transactions SET
      provider_ref_id = COALESCE(NULLIF(?, ''), provider_ref_id),
      sn = COALESCE(NULLIF(?, ''), sn),
      status = ?,
      message = ?,
      provider_response = ?,
      is_refunded = ?,
      updated_at = datetime('now','localtime')
    WHERE id = ?
  `).run(
    checkResult.trx_id || '',
    checkResult.sn || '',
    newStatus,
    checkResult.message || tx.message,
    JSON.stringify(checkResult.raw || {}),
    isRefunded,
    tx.id
  );

  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
}

/**
 * Handle update status dari Webhook
 */
function processWebhookUpdate({ refId, status, sn = '', message = '', trxId = '', rawPayload = {} }) {
  const tx = db.prepare('SELECT * FROM transactions WHERE ref_id = ?').get(refId);
  if (!tx) {
    logger.warn(`[Webhook] Transaksi tidak ditemukan untuk ref_id: ${refId}`);
    return null;
  }

  let isRefunded = tx.is_refunded;

  // Auto refund jika transaksi gagal dan belum di-refund
  if (status === 'failed' && !isRefunded && tx.agent_id) {
    logger.warn(`[Webhook] Transaksi #${tx.id} (${refId}) GAGAL. Melakukan auto-refund Rp ${tx.price_sell}`);
    refundBalance(tx.agent_id, tx.price_sell, refId, `Refund transaksi gagal dari webhook (${refId})`);
    isRefunded = 1;
  }

  db.prepare(`
    UPDATE transactions SET
      provider_ref_id = COALESCE(NULLIF(?, ''), provider_ref_id),
      sn = COALESCE(NULLIF(?, ''), sn),
      status = ?,
      message = ?,
      provider_response = ?,
      is_refunded = ?,
      updated_at = datetime('now','localtime')
    WHERE id = ?
  `).run(
    trxId,
    sn,
    status,
    message || tx.message,
    JSON.stringify(rawPayload),
    isRefunded,
    tx.id
  );

  logger.info(`[Webhook] Sukses update status transaksi #${tx.id} (${refId}) menjadi ${status}`);
  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(tx.id);
}

/**
 * List transaksi dengan pagination dan filter
 */
function listTransactions({ agentId = null, status = '', category = '', channel = '', dateFrom = '', dateTo = '', q = '', page = 1, limit = 20 } = {}) {
  const where = [];
  const params = [];

  if (agentId) {
    where.push('t.agent_id = ?');
    params.push(agentId);
  }

  if (status) {
    where.push('t.status = ?');
    params.push(status);
  }

  if (category) {
    where.push('t.category = ?');
    params.push(category);
  }

  if (channel) {
    where.push('t.channel = ?');
    params.push(channel);
  }

  if (dateFrom) {
    where.push('DATE(t.created_at) >= DATE(?)');
    params.push(dateFrom);
  }


  if (dateTo) {
    where.push('DATE(t.created_at) <= DATE(?)');
    params.push(dateTo);
  }

  if (q) {
    where.push('(t.ref_id LIKE ? OR t.target LIKE ? OR t.product_name LIKE ? OR a.name LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM transactions t
    LEFT JOIN agents a ON a.id = t.agent_id
    ${whereClause}
  `).get(...params)?.cnt || 0;

  const pg = paginate(total, page, limit);

  const transactions = db.prepare(`
    SELECT t.*, a.name as agent_name, a.username as agent_username, a.phone as agent_phone, pr.label as provider_label
    FROM transactions t
    LEFT JOIN agents a ON a.id = t.agent_id
    LEFT JOIN providers pr ON pr.id = t.provider_id
    ${whereClause}
    ORDER BY t.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pg.limit, pg.offset);

  return { transactions, pagination: pg };
}

/**
 * Get transaction by ID
 */
function getTransactionById(id) {
  return db.prepare(`
    SELECT t.*, a.name as agent_name, a.username as agent_username, a.phone as agent_phone, pr.label as provider_label
    FROM transactions t
    LEFT JOIN agents a ON a.id = t.agent_id
    LEFT JOIN providers pr ON pr.id = t.provider_id
    WHERE t.id = ?
  `).get(id) || null;
}

/**
 * Get transaction by ref_id
 */
function getTransactionByRefId(refId) {
  return db.prepare(`
    SELECT t.*, a.name as agent_name, a.username as agent_username, pr.label as provider_label
    FROM transactions t
    LEFT JOIN agents a ON a.id = t.agent_id
    LEFT JOIN providers pr ON pr.id = t.provider_id
    WHERE t.ref_id = ?
  `).get(refId) || null;
}

module.exports = {
  createTransaction,
  checkTransactionStatus,
  processWebhookUpdate,
  listTransactions,
  getTransactionById,
  getTransactionByRefId,
};
