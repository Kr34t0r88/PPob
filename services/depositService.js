/**
 * Juragan Pulsa - Deposit Service
 * services/depositService.js
 */

const db = require('../config/database');
const { topupBalance, getAgentById } = require('./agentService');
const { generateDepositCode } = require('../utils/generateRefId');
const { paginate } = require('../utils/helpers');
const { getSetting } = require('../config/settingsManager');
const qrisUtil = require('../utils/qrisUtil');
const logger = require('../utils/logger');

/**
 * Buat permintaan deposit saldo oleh agen
 * Menghasilkan nominal transfer unik (amount + kode unik) dan Dynamic QRIS jika diaktifkan
 */
async function createDepositRequest(agentId, amount, { bankName = '', transferTo = '', proofImage = '', notes = '' } = {}) {
  const safeAmount = Math.max(10000, parseFloat(amount) || 0);
  const agent = getAgentById(agentId);
  if (!agent) throw new Error('Agen tidak ditemukan');

  const { depositCode, uniqueAmount, suffix } = generateDepositCode(agentId, safeAmount);

  const res = db.prepare(`
    INSERT INTO deposit_requests (
      agent_id, amount, deposit_code, transfer_to, bank_name, proof_image, status, notes, created_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, 'pending', ?, datetime('now','localtime')
    )
  `).run(
    agentId,
    uniqueAmount,
    depositCode,
    String(transferTo),
    String(bankName),
    String(proofImage),
    String(notes)
  );

  const created = db.prepare('SELECT * FROM deposit_requests WHERE id = ?').get(res.lastInsertRowid);
  logger.info(`[Deposit] Created request #${created.id} (${depositCode}) for Agent #${agentId} with unique amount Rp ${uniqueAmount.toLocaleString('id-ID')}`);

  let qrString = '';
  let qrImage = '';
  const qrisEnabled = getSetting('qris_static_enabled', '1');
  const staticPayload = String(getSetting('qris_static_payload', '') || '').trim();

  if (qrisEnabled && staticPayload) {
    try {
      const qrisRes = await qrisUtil.generateDynamicQrisDataUrl(staticPayload, uniqueAmount);
      qrString = qrisRes.dynamicPayload;
      qrImage = qrisRes.dataUrl;
    } catch (e) {
      logger.warn(`[Deposit] Gagal generate dynamic QRIS: ${e.message}`);
    }
  }

  return {
    ...created,
    base_amount: safeAmount,
    unique_code: suffix,
    qr_string: qrString,
    qr_image: qrImage,
    qr_url: `/api/balance/deposit/qris/${depositCode}`
  };
}

/**
 * Dapatkan Dynamic QRIS buffer/data URL untuk tiket deposit tertentu
 */
async function getDepositQris(depositCodeOrId) {
  const deposit = typeof depositCodeOrId === 'number'
    ? db.prepare('SELECT * FROM deposit_requests WHERE id = ?').get(depositCodeOrId)
    : db.prepare('SELECT * FROM deposit_requests WHERE deposit_code = ? OR id = ?').get(depositCodeOrId, parseInt(depositCodeOrId, 10) || 0);

  if (!deposit) throw new Error('Tiket deposit tidak ditemukan');

  const staticPayload = String(getSetting('qris_static_payload', '') || '').trim();
  if (!staticPayload) throw new Error('Konfigurasi QRIS statis belum diatur oleh Admin');

  return await qrisUtil.generateDynamicQrisBuffer(staticPayload, deposit.amount);
}

/**
 * Approve deposit oleh Admin
 * Otomatis top up saldo agen dan catat riwayat mutasi
 */
function approveDeposit(depositId, adminUsername = 'admin', notes = '') {
  const deposit = db.prepare('SELECT * FROM deposit_requests WHERE id = ?').get(depositId);
  if (!deposit) throw new Error('Data deposit tidak ditemukan');
  if (deposit.status !== 'pending') throw new Error(`Deposit sudah berstatus ${deposit.status}`);

  const approvalTx = db.transaction(() => {
    // Top up saldo agen
    topupBalance(
      deposit.agent_id,
      deposit.amount,
      `Deposit disetujui (${deposit.deposit_code})${notes ? ': ' + notes : ''}`,
      adminUsername
    );

    // Update status request deposit
    db.prepare(`
      UPDATE deposit_requests SET
        status = 'approved',
        reviewed_by = ?,
        reviewed_at = datetime('now','localtime'),
        notes = CASE WHEN ? <> '' THEN ? ELSE notes END
      WHERE id = ?
    `).run(adminUsername, notes, notes, depositId);
  });

  approvalTx();
  logger.info(`[Deposit] Approved request #${depositId} for Agent #${deposit.agent_id} by ${adminUsername}`);
  return db.prepare('SELECT * FROM deposit_requests WHERE id = ?').get(depositId);
}

/**
 * Tolak request deposit
 */
function rejectDeposit(depositId, adminUsername = 'admin', notes = 'Bukti transfer tidak valid') {
  const deposit = db.prepare('SELECT * FROM deposit_requests WHERE id = ?').get(depositId);
  if (!deposit) throw new Error('Data deposit tidak ditemukan');
  if (deposit.status !== 'pending') throw new Error(`Deposit sudah berstatus ${deposit.status}`);

  db.prepare(`
    UPDATE deposit_requests SET
      status = 'rejected',
      reviewed_by = ?,
      reviewed_at = datetime('now','localtime'),
      notes = ?
    WHERE id = ?
  `).run(adminUsername, notes, depositId);

  logger.info(`[Deposit] Rejected request #${depositId} by ${adminUsername}: ${notes}`);
  return db.prepare('SELECT * FROM deposit_requests WHERE id = ?').get(depositId);
}

/**
 * List deposit requests (Admin)
 */
function getAllDeposits({ status = '', q = '', page = 1, limit = 20 } = {}) {
  const where = [];
  const params = [];

  if (status) {
    where.push('d.status = ?');
    params.push(status);
  }

  if (q) {
    where.push('(d.deposit_code LIKE ? OR a.name LIKE ? OR a.username LIKE ? OR a.phone LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM deposit_requests d
    JOIN agents a ON a.id = d.agent_id
    ${whereClause}
  `).get(...params)?.cnt || 0;

  const pg = paginate(total, page, limit);

  const deposits = db.prepare(`
    SELECT d.*, a.name as agent_name, a.username as agent_username, a.phone as agent_phone, a.balance as agent_balance
    FROM deposit_requests d
    JOIN agents a ON a.id = d.agent_id
    ${whereClause}
    ORDER BY CASE WHEN d.status = 'pending' THEN 0 ELSE 1 END, d.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pg.limit, pg.offset);

  return { deposits, pagination: pg };
}

/**
 * List deposit history per agent
 */
function getDepositsByAgent(agentId, { page = 1, limit = 10 } = {}) {
  const total = db.prepare('SELECT COUNT(*) as cnt FROM deposit_requests WHERE agent_id = ?').get(agentId)?.cnt || 0;
  const pg = paginate(total, page, limit);

  const deposits = db.prepare(`
    SELECT * FROM deposit_requests
    WHERE agent_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(agentId, pg.limit, pg.offset);

  return { deposits, pagination: pg };
}

/**
 * Get deposit by ID
 */
function getDepositById(id) {
  return db.prepare(`
    SELECT d.*, a.name as agent_name, a.username as agent_username, a.phone as agent_phone, a.balance as current_balance
    FROM deposit_requests d
    JOIN agents a ON a.id = d.agent_id
    WHERE d.id = ?
  `).get(id) || null;
}

// ── Bank Accounts Management ───────────────────────────────────────────────────

function getBankAccounts(activeOnly = true) {
  const sql = activeOnly
    ? 'SELECT * FROM bank_accounts WHERE is_active = 1 ORDER BY id ASC'
    : 'SELECT * FROM bank_accounts ORDER BY id ASC';
  return db.prepare(sql).all();
}

function addBankAccount({ bank_name, account_number, account_name, qris_image = '' }) {
  if (!bank_name || !account_number || !account_name) {
    throw new Error('Nama Bank, Nomor Rekening, dan Atas Nama wajib diisi');
  }
  return db.prepare(`
    INSERT INTO bank_accounts (bank_name, account_number, account_name, qris_image, is_active)
    VALUES (?, ?, ?, ?, 1)
  `).run(bank_name, account_number, account_name, qris_image);
}

function toggleBankAccount(id) {
  const account = db.prepare('SELECT is_active FROM bank_accounts WHERE id = ?').get(id);
  if (!account) throw new Error('Rekening tidak ditemukan');
  const newStatus = account.is_active ? 0 : 1;
  db.prepare('UPDATE bank_accounts SET is_active = ? WHERE id = ?').run(newStatus, id);
  return newStatus;
}

function deleteBankAccount(id) {
  return db.prepare('DELETE FROM bank_accounts WHERE id = ?').run(id);
}

module.exports = {
  createDepositRequest,
  getDepositQris,
  approveDeposit,
  rejectDeposit,
  getAllDeposits,
  getDepositsByAgent,
  getDepositById,
  getBankAccounts,
  addBankAccount,
  toggleBankAccount,
  deleteBankAccount,
};
