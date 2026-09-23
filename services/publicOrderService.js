/**
 * Juragan Pulsa - Public Order Service (Direct Top-Up / UniPin Style)
 * services/publicOrderService.js
 */

const db = require('../config/database');
const qrisUtil = require('../utils/qrisUtil');
const { getSetting } = require('../config/settingsManager');
const { getDefaultProvider, getAdapter } = require('./providers/providerFactory');
const { paginate } = require('../utils/helpers');
const logger = require('../utils/logger');

/**
 * Sync public order to transactions table (Unified Ledger)
 */
function syncPublicOrderToTransactions(order) {
  if (!order) return;
  try {
    const profit = Math.max(0, (order.total_amount || order.price_public) - order.price_modal);
    const exists = db.prepare('SELECT id FROM transactions WHERE ref_id = ?').get(order.invoice_code);
    if (exists) {
      db.prepare(`
        UPDATE transactions SET
          status = ?,
          sn = ?,
          message = ?,
          provider_ref_id = ?,
          price_modal = ?,
          price_sell = ?,
          profit = ?,
          updated_at = datetime('now','localtime')
        WHERE id = ?
      `).run(
        order.status,
        order.sn || '',
        order.message || '',
        order.provider_ref_id || '',
        order.price_modal || 0,
        order.total_amount || order.price_public || 0,
        profit,
        exists.id
      );
    } else {
      db.prepare(`
        INSERT INTO transactions (
          agent_id, provider_id, ref_id, provider_ref_id, product_sku, product_name,
          category, brand, target, price_modal, price_sell, profit, status, sn,
          message, channel, created_at, updated_at
        ) VALUES (
          NULL, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?,
          ?, 'web_public', ?, datetime('now','localtime')
        )
      `).run(
        order.provider_id || 1,
        order.invoice_code,
        order.provider_ref_id || '',
        order.product_sku,
        order.product_name,
        order.category || 'Pulsa',
        order.brand || '',
        order.target_combined,
        order.price_modal || 0,
        order.total_amount || order.price_public || 0,
        profit,
        order.status,
        order.sn || '',
        order.message || '',
        order.created_at || new Date().toISOString()
      );
    }
  } catch (e) {
    logger.warn(`[PublicOrder] Sync to transactions warning: ${e.message}`);
  }
}

/**
 * Generate unique 3-digit code (100 - 999) to avoid amount collision
 */
function generateUniqueCode(basePrice) {
  const stmtCheckPublic = db.prepare(`
    SELECT 1 FROM public_orders 
    WHERE total_amount = ? AND status = 'pending' AND datetime('now','localtime') < expired_at
  `);
  const stmtCheckDeposit = db.prepare(`
    SELECT 1 FROM deposit_requests 
    WHERE amount = ? AND status = 'pending'
  `);

  for (let i = 0; i < 60; i++) {
    const code = Math.floor(100 + Math.random() * 899); // 100 - 998
    const candidateAmount = basePrice + code;
    const existsPub = stmtCheckPublic.get(candidateAmount);
    const existsDep = stmtCheckDeposit.get(candidateAmount);
    if (!existsPub && !existsDep) {
      return code;
    }
  }
  return Math.floor(100 + Math.random() * 899);
}


/**
 * Create a new public order with dynamic QRIS
 */
async function createPublicOrder({ sku, targetId, targetZone = '', buyerPhone = '', buyerEmail = '' }) {
  if (!sku) throw new Error('SKU produk harus dipilih');
  if (!targetId) throw new Error('ID atau Nomor Tujuan harus diisi');

  const cleanSku = String(sku).trim();
  const cleanTarget = String(targetId).trim().replace(/\s+/g, '');
  const cleanZone = String(targetZone || '').trim();
  const cleanPhone = String(buyerPhone || '').trim();
  const cleanEmail = String(buyerEmail || '').trim();

  // Ambil data produk
  const product = db.prepare('SELECT * FROM products WHERE sku = ? AND is_active = 1').get(cleanSku);
  if (!product) {
    throw new Error('Produk tidak ditemukan atau sedang dinonaktifkan');
  }

  const defaultPublicMarkup = parseInt(getSetting('public_store_markup', '3000'), 10) || 3000;
  const pricePublic = (product.price_public && product.price_public > 0)
    ? product.price_public
    : (product.price_modal + defaultPublicMarkup);

  // Bentuk target gabungan (jika ada Zone/Server ID untuk Game)
  const combinedTarget = cleanZone ? `${cleanTarget}${cleanZone}` : cleanTarget;

  // Generate kode unik dan total nominal
  const uniqueCode = generateUniqueCode(pricePublic);
  const totalAmount = pricePublic + uniqueCode;

  // Generate Invoice Code
  const timestamp = Date.now().toString(36).toUpperCase();
  const randomSuffix = Math.floor(1000 + Math.random() * 9000);
  const invoiceCode = `INV-${timestamp}-${randomSuffix}`;

  // Generate Dynamic QRIS
  const qrisStaticPayload = String(getSetting('qris_static_payload', '')).trim();
  if (!qrisStaticPayload) {
    throw new Error('QRIS Statis belum dikonfigurasi di Pengaturan Server');
  }

  const expiryMinutes = parseInt(getSetting('public_qris_expiry_minutes', '15'), 10) || 15;
  const { dynamicPayload, dataUrl } = await qrisUtil.generateDynamicQrisDataUrl(qrisStaticPayload, totalAmount);

  const provider = getDefaultProvider() || { id: 1 };

  // Simpan ke tabel public_orders
  const insertStmt = db.prepare(`
    INSERT INTO public_orders (
      invoice_code, provider_id, product_sku, product_name, category, brand,
      target_id, target_zone, target_combined, buyer_phone, buyer_email,
      price_modal, price_public, unique_code, total_amount, payment_method,
      qris_payload, status, expired_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, 'QRIS',
      ?, 'pending', datetime('now', '+${expiryMinutes} minutes', 'localtime')
    )
  `);

  const info = insertStmt.run(
    invoiceCode,
    provider.id,
    product.sku,
    product.product_name,
    product.category || 'Voucher',
    product.brand || '',
    cleanTarget,
    cleanZone,
    combinedTarget,
    cleanPhone,
    cleanEmail,
    product.price_modal,
    pricePublic,
    uniqueCode,
    totalAmount,
    dynamicPayload
  );

  const order = db.prepare('SELECT * FROM public_orders WHERE id = ?').get(info.lastInsertRowid);
  order.qr_image = dataUrl;

  // Sync to unified transactions ledger
  syncPublicOrderToTransactions(order);

  logger.info(`[PublicOrder] Order baru dibuat: ${invoiceCode} | ${product.product_name} -> ${combinedTarget} | Rp ${totalAmount.toLocaleString('id-ID')}`);

  // Kirim WhatsApp invoice jika no HP pembeli diisi
  if (cleanPhone) {
    try {
      const whatsappService = require('./whatsappService');
      const appUrl = getSetting('app_url', 'http://localhost:5000');
      const invoiceUrl = `${appUrl}/invoice/${invoiceCode}`;
      if (typeof whatsappService.notifyPublicInvoiceCreated === 'function') {
        whatsappService.notifyPublicInvoiceCreated(order, invoiceUrl).catch(e => {
          logger.warn(`[PublicOrder] Gagal kirim WA invoice: ${e.message}`);
        });
      }
    } catch (_) {}
  }

  return order;
}


/**
 * Get public order by invoice code with auto-expiry check
 */
function getOrderByInvoice(invoiceCode) {
  const cleanCode = String(invoiceCode || '').trim();
  const order = db.prepare('SELECT * FROM public_orders WHERE invoice_code = ?').get(cleanCode);
  if (!order) return null;

  // Cek apakah sudah expired
  if (order.status === 'pending') {
    const isExpired = db.prepare(`
      SELECT (datetime('now','localtime') > ?) as is_exp
    `).get(order.expired_at)?.is_exp;

    if (isExpired) {
      db.prepare("UPDATE public_orders SET status = 'expired' WHERE id = ?").run(order.id);
      order.status = 'expired';
    }
  }

  return order;
}

/**
 * Process successful payment (Auto-Trigger Digiflazz H2H)
 */
async function processPaymentSuccess(orderId, paymentSource = 'Auto Gateway') {
  const order = db.prepare('SELECT * FROM public_orders WHERE id = ?').get(orderId);
  if (!order) throw new Error('Order publik tidak ditemukan');

  if (order.status !== 'pending') {
    logger.info(`[PublicOrder] Order ${order.invoice_code} sudah berstatus '${order.status}', skip proses.`);
    return order;
  }

  // Tandai paid & processing
  db.prepare(`
    UPDATE public_orders SET
      status = 'processing',
      paid_at = datetime('now','localtime'),
      message = ?
    WHERE id = ?
  `).run(`Pembayaran diterima via ${paymentSource}. Mengirimkan pesanan ke provider...`, order.id);

  const provider = getDefaultProvider();
  if (!provider) {
    logger.error(`[PublicOrder] Gagal proses ${order.invoice_code}: Provider default tidak ditemukan`);
    db.prepare("UPDATE public_orders SET status = 'failed', message = 'Provider server tidak aktif' WHERE id = ?").run(order.id);
    return db.prepare('SELECT * FROM public_orders WHERE id = ?').get(order.id);
  }

  const adapter = getAdapter(provider.name);
  logger.info(`[PublicOrder] Menembak Digiflazz untuk invoice ${order.invoice_code} (SKU: ${order.product_sku}, Target: ${order.target_combined})...`);

  try {
    const result = await adapter.createTransaction(provider, {
      sku: order.product_sku,
      target: order.target_combined,
      refId: order.invoice_code
    });

    const isSuccess = result.status === 'success' || result.rc === '00';
    const isPending = result.status === 'pending' || result.rc === '03';

    let finalStatus = 'processing';
    let finalMsg = result.message || 'Transaksi sedang diproses oleh vendor';

    if (isSuccess) {
      finalStatus = 'success';
      finalMsg = result.message || 'Transaksi Sukses';
    } else if (!isPending) {
      finalStatus = 'failed';
      finalMsg = result.message || `Gagal dari vendor (RC: ${result.rc})`;
    }

    db.prepare(`
      UPDATE public_orders SET
        status = ?,
        sn = ?,
        provider_ref_id = ?,
        message = ?,
        completed_at = CASE WHEN ? = 'success' THEN datetime('now','localtime') ELSE NULL END
      WHERE id = ?
    `).run(
      finalStatus,
      result.sn || '',
      result.trx_id || '',
      finalMsg,
      finalStatus,
      order.id
    );

    const updated = db.prepare('SELECT * FROM public_orders WHERE id = ?').get(order.id);
    logger.info(`[PublicOrder] Hasil proses ${order.invoice_code}: [${finalStatus}] SN: ${result.sn || '-'}`);

    // Sync to unified transactions ledger
    syncPublicOrderToTransactions(updated);

    // Kirim notifikasi WhatsApp ke pembeli
    if (updated.buyer_phone) {
      try {
        const whatsappService = require('./whatsappService');
        if (finalStatus === 'success' && typeof whatsappService.notifyPublicOrderSuccess === 'function') {
          whatsappService.notifyPublicOrderSuccess(updated).catch(() => {});
        } else if (finalStatus === 'failed' && typeof whatsappService.notifyPublicOrderFailed === 'function') {
          whatsappService.notifyPublicOrderFailed(updated).catch(() => {});
        }
      } catch (_) {}
    }

    return updated;
  } catch (err) {
    logger.error(`[PublicOrder] Error eksekusi H2H untuk ${order.invoice_code}: ${err.message}`);
    db.prepare(`
      UPDATE public_orders SET
        status = 'failed',
        message = ?
      WHERE id = ?
    `).run(`Gagal memproses H2H: ${err.message}`, order.id);

    const failedOrder = db.prepare('SELECT * FROM public_orders WHERE id = ?').get(order.id);
    syncPublicOrderToTransactions(failedOrder);

    if (failedOrder.buyer_phone) {
      try {
        const whatsappService = require('./whatsappService');
        if (typeof whatsappService.notifyPublicOrderFailed === 'function') {
          whatsappService.notifyPublicOrderFailed(failedOrder).catch(() => {});
        }
      } catch (_) {}
    }
    return failedOrder;
  }
}

/**
 * Recheck public order status with Digiflazz
 */
async function recheckPublicOrder(orderId) {
  const order = db.prepare('SELECT * FROM public_orders WHERE id = ?').get(orderId);
  if (!order) throw new Error('Order publik tidak ditemukan');

  const provider = getDefaultProvider();
  if (!provider) throw new Error('Provider tidak ditemukan');

  const adapter = getAdapter(provider.name);
  const result = await adapter.checkTransaction(provider, order.invoice_code);

  const isSuccess = result.status === 'success' || result.rc === '00';
  const isPending = result.status === 'pending' || result.rc === '03';

  let finalStatus = order.status;
  if (isSuccess) finalStatus = 'success';
  else if (!isPending) finalStatus = 'failed';

  db.prepare(`
    UPDATE public_orders SET
      status = ?,
      sn = CASE WHEN ? <> '' THEN ? ELSE sn END,
      message = ?,
      completed_at = CASE WHEN ? = 'success' THEN datetime('now','localtime') ELSE completed_at END
    WHERE id = ?
  `).run(
    finalStatus,
    result.sn || '',
    result.sn || '',
    result.message || order.message,
    finalStatus,
    order.id
  );

  const updated = db.prepare('SELECT * FROM public_orders WHERE id = ?').get(order.id);
  syncPublicOrderToTransactions(updated);

  if (isSuccess && order.status !== 'success' && updated.buyer_phone) {
    try {
      const whatsappService = require('./whatsappService');
      if (typeof whatsappService.notifyPublicOrderSuccess === 'function') {
        whatsappService.notifyPublicOrderSuccess(updated).catch(() => {});
      }
    } catch (_) {}
  }

  return updated;
}


/**
 * List public orders for admin dashboard
 */
function listPublicOrders({ page = 1, limit = 25, status = '', q = '', dateFrom = '', dateTo = '' } = {}) {
  const where = [];
  const params = [];

  if (status && status !== 'all') {
    where.push('status = ?');
    params.push(status);
  }

  if (q) {
    where.push('(invoice_code LIKE ? OR product_name LIKE ? OR target_combined LIKE ? OR buyer_phone LIKE ? OR sn LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }

  if (dateFrom) {
    where.push('date(created_at) >= ?');
    params.push(dateFrom);
  }

  if (dateTo) {
    where.push('date(created_at) <= ?');
    params.push(dateTo);
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM public_orders ${whereClause}`).get(...params)?.cnt || 0;
  const pg = paginate(total, page, limit);

  const orders = db.prepare(`
    SELECT * FROM public_orders
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pg.limit, pg.offset);

  return { orders, pagination: pg };
}

/**
 * Expire old pending orders
 */
function expireOldPendingOrders() {
  const res = db.prepare(`
    UPDATE public_orders
    SET status = 'expired'
    WHERE status = 'pending' AND datetime('now','localtime') > expired_at
  `).run();
  return res.changes;
}

/**
 * Backfill existing public orders into unified transactions table
 */
function backfillPublicOrdersToTransactions() {
  try {
    const orders = db.prepare('SELECT * FROM public_orders').all();
    for (const o of orders) {
      syncPublicOrderToTransactions(o);
    }
  } catch (err) {
    logger.warn(`[PublicOrder] Backfill warning: ${err.message}`);
  }
}


// Auto-run backfill on startup
try {
  backfillPublicOrdersToTransactions();
} catch (_) {}

module.exports = {
  createPublicOrder,
  getOrderByInvoice,
  processPaymentSuccess,
  recheckPublicOrder,
  listPublicOrders,
  expireOldPendingOrders,
  generateUniqueCode,
  syncPublicOrderToTransactions,
  backfillPublicOrdersToTransactions,
};

