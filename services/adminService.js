/**
 * Juragan Pulsa - Admin Service
 * services/adminService.js
 */

const db = require('../config/database');
const bcrypt = require('bcryptjs');
const { getActiveProviders, getAdapter, updateProviderBalance } = require('./providers/providerFactory');
const logger = require('../utils/logger');

const crypto = require('crypto');

/**
 * Verifikasi login admin
 */
function verifyLogin(username, password) {
  const admin = db.prepare('SELECT * FROM admins WHERE username = ? AND is_active = 1').get(String(username || ''));
  if (!admin) return null;

  const isMatch = bcrypt.compareSync(String(password || ''), admin.password);
  if (!isMatch) return null;

  db.prepare("UPDATE admins SET last_login = datetime('now','localtime') WHERE id = ?").run(admin.id);
  return {
    id: admin.id,
    username: admin.username,
    name: admin.name,
    role: admin.role,
  };
}

/**
 * Generate API token untuk admin
 */
function generateAdminToken(adminId) {
  const token = 'adm_' + crypto.randomBytes(32).toString('hex');
  db.prepare('UPDATE admins SET api_token = ? WHERE id = ?').run(token, adminId);
  return token;
}

/**
 * Ambil data admin berdasarkan API token
 */
function getAdminByApiToken(token) {
  if (!token) return null;
  return db.prepare('SELECT id, username, name, role, is_active FROM admins WHERE api_token = ?').get(token) || null;
}

/**
 * Revoke admin token (logout)
 */
function revokeAdminToken(adminId) {
  db.prepare('UPDATE admins SET api_token = NULL WHERE id = ?').run(adminId);
}

/**
 * Ambil admin by ID
 */
function getAdminById(id) {
  return db.prepare('SELECT id, username, name, role, is_active, last_login, created_at FROM admins WHERE id = ?').get(id) || null;
}

/**
 * Ambil ringkasan statistik untuk dashboard
 */
async function getDashboardStats() {
  const activeAgents = db.prepare('SELECT COUNT(*) as cnt FROM agents WHERE is_active = 1').get()?.cnt || 0;

  const todayStats = db.prepare(`
    SELECT
      COUNT(*) as total_trx,
      COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) as success_trx,
      COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending_trx,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed_trx,
      COALESCE(SUM(CASE WHEN status = 'success' THEN price_sell ELSE 0 END), 0) as omset,
      COALESCE(SUM(CASE WHEN status = 'success' THEN profit ELSE 0 END), 0) as profit
    FROM transactions
    WHERE DATE(created_at) = DATE('now','localtime')
  `).get() || {};

  const pendingDeposits = db.prepare("SELECT COUNT(*) as cnt FROM deposit_requests WHERE status = 'pending'").get()?.cnt || 0;
  const pendingTransactions = db.prepare("SELECT COUNT(*) as cnt FROM transactions WHERE status = 'pending'").get()?.cnt || 0;

  // Cek saldo provider aktif
  const providers = getActiveProviders();
  const providerBalances = [];

  for (const prov of providers) {
    try {
      if (prov.username && prov.api_key) {
        const adapter = getAdapter(prov.name);
        const bal = await adapter.checkBalance(prov);
        updateProviderBalance(prov.id, bal.deposit);
        providerBalances.push({
          id: prov.id,
          name: prov.name,
          label: prov.label,
          balance: bal.deposit,
          status: 'ok',
        });
      } else {
        providerBalances.push({
          id: prov.id,
          name: prov.name,
          label: prov.label,
          balance: prov.balance || 0,
          status: 'unconfigured',
        });
      }
    } catch (err) {
      providerBalances.push({
        id: prov.id,
        name: prov.name,
        label: prov.label,
        balance: prov.balance || 0,
        status: 'error',
        error: err.message,
      });
    }
  }

  return {
    active_agents: activeAgents,
    transactions_today: todayStats.total_trx || 0,
    success_today: todayStats.success_trx || 0,
    pending_today: todayStats.pending_trx || 0,
    failed_today: todayStats.failed_trx || 0,
    omset_today: todayStats.omset || 0,
    profit_today: todayStats.profit || 0,
    pending_deposits: pendingDeposits,
    pending_transactions: pendingTransactions,
    providers: providerBalances,
  };
}

/**
 * Data chart 7 hari terakhir
 */
function getWeeklyChartData() {
  const rows = db.prepare(`
    WITH RECURSIVE dates(date) AS (
      SELECT DATE('now', 'localtime', '-6 days')
      UNION ALL
      SELECT DATE(date, '+1 day')
      FROM dates
      WHERE date < DATE('now', 'localtime')
    )
    SELECT
      d.date,
      COALESCE(COUNT(t.id), 0) as total_trx,
      COALESCE(SUM(CASE WHEN t.status = 'success' THEN 1 ELSE 0 END), 0) as success_trx,
      COALESCE(SUM(CASE WHEN t.status = 'success' THEN t.price_sell ELSE 0 END), 0) as omset,
      COALESCE(SUM(CASE WHEN t.status = 'success' THEN t.profit ELSE 0 END), 0) as profit
    FROM dates d
    LEFT JOIN transactions t ON DATE(t.created_at) = d.date
    GROUP BY d.date
    ORDER BY d.date ASC
  `).all();

  return {
    labels: rows.map(r => {
      const d = new Date(r.date);
      return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
    }),
    transactions: rows.map(r => r.total_trx),
    success: rows.map(r => r.success_trx),
    omset: rows.map(r => r.omset),
    profit: rows.map(r => r.profit),
  };
}

/**
 * Transaksi terbaru
 */
function getRecentTransactions(limit = 10) {
  return db.prepare(`
    SELECT t.*, a.name as agent_name, a.username as agent_username
    FROM transactions t
    LEFT JOIN agents a ON a.id = t.agent_id
    ORDER BY t.created_at DESC
    LIMIT ?
  `).all(limit);
}

/**
 * Deposit terbaru yang pending
 */
function getRecentDeposits(limit = 5) {
  return db.prepare(`
    SELECT d.*, a.name as agent_name, a.username as agent_username, a.phone as agent_phone
    FROM deposit_requests d
    JOIN agents a ON a.id = d.agent_id
    WHERE d.status = 'pending'
    ORDER BY d.created_at DESC
    LIMIT ?
  `).all(limit);
}

/**
 * Ganti password admin
 */
function updateAdminPassword(adminId, oldPassword, newPassword) {
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(adminId);
  if (!admin) throw new Error('Admin tidak ditemukan');

  const isMatch = bcrypt.compareSync(oldPassword, admin.password);
  if (!isMatch) throw new Error('Password lama salah');

  if (!newPassword || newPassword.length < 6) {
    throw new Error('Password baru minimal 6 karakter');
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE admins SET password = ? WHERE id = ?').run(hash, adminId);
  return true;
}

module.exports = {
  verifyLogin,
  generateAdminToken,
  getAdminByApiToken,
  revokeAdminToken,
  getAdminById,
  getDashboardStats,
  getWeeklyChartData,
  getRecentTransactions,
  getRecentDeposits,
  updateAdminPassword,
};
