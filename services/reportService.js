/**
 * Juragan Pulsa - Report & Financial Analytics Service
 * services/reportService.js
 */

const db = require('../config/database');
const { paginate } = require('../utils/helpers');

/**
 * Ringkasan laporan transaksi & keuntungan berdasarkan filter
 */
function getSummaryReport({ dateFrom = '', dateTo = '', agentId = '', category = '' } = {}) {
  const where = [];
  const params = [];

  if (dateFrom) {
    where.push('DATE(t.created_at) >= DATE(?)');
    params.push(dateFrom);
  }
  if (dateTo) {
    where.push('DATE(t.created_at) <= DATE(?)');
    params.push(dateTo);
  }
  if (agentId) {
    where.push('t.agent_id = ?');
    params.push(agentId);
  }
  if (category) {
    where.push('t.category = ?');
    params.push(category);
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const summary = db.prepare(`
    SELECT
      COUNT(*) as total_trx,
      COALESCE(SUM(CASE WHEN t.status = 'success' THEN 1 ELSE 0 END), 0) as success_trx,
      COALESCE(SUM(CASE WHEN t.status = 'pending' THEN 1 ELSE 0 END), 0) as pending_trx,
      COALESCE(SUM(CASE WHEN t.status = 'failed'  THEN 1 ELSE 0 END), 0) as failed_trx,
      COALESCE(SUM(CASE WHEN t.status = 'success' THEN t.price_modal ELSE 0 END), 0) as total_modal,
      COALESCE(SUM(CASE WHEN t.status = 'success' THEN t.price_sell  ELSE 0 END), 0) as total_omset,
      COALESCE(SUM(CASE WHEN t.status = 'success' THEN t.profit      ELSE 0 END), 0) as total_profit
    FROM transactions t
    ${whereClause}
  `).get(...params) || {};

  return summary;
}

/**
 * Laporan per kategori produk
 */
function getCategoryReport({ dateFrom = '', dateTo = '' } = {}) {
  const where = ["t.status = 'success'"];
  const params = [];

  if (dateFrom) {
    where.push('DATE(t.created_at) >= DATE(?)');
    params.push(dateFrom);
  }
  if (dateTo) {
    where.push('DATE(t.created_at) <= DATE(?)');
    params.push(dateTo);
  }

  const whereClause = 'WHERE ' + where.join(' AND ');

  return db.prepare(`
    SELECT
      COALESCE(NULLIF(t.category, ''), 'Lainnya') as category,
      COUNT(*) as total_trx,
      SUM(t.price_sell) as omset,
      SUM(t.profit) as profit
    FROM transactions t
    ${whereClause}
    GROUP BY t.category
    ORDER BY omset DESC
  `).all(...params);
}

/**
 * Laporan performa per agen
 */
function getAgentReport({ dateFrom = '', dateTo = '', page = 1, limit = 20 } = {}) {
  const where = [];
  const params = [];

  if (dateFrom) {
    where.push('DATE(t.created_at) >= DATE(?)');
    params.push(dateFrom);
  }
  if (dateTo) {
    where.push('DATE(t.created_at) <= DATE(?)');
    params.push(dateTo);
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const total = db.prepare(`
    SELECT COUNT(DISTINCT a.id) as cnt
    FROM agents a
    JOIN transactions t ON t.agent_id = a.id
    ${whereClause}
  `).get(...params)?.cnt || 0;

  const pg = paginate(total, page, limit);

  const agents = db.prepare(`
    SELECT
      a.id,
      a.name,
      a.username,
      a.phone,
      a.balance,
      COUNT(t.id) as total_trx,
      COALESCE(SUM(CASE WHEN t.status = 'success' THEN 1 ELSE 0 END), 0) as success_trx,
      COALESCE(SUM(CASE WHEN t.status = 'success' THEN t.price_sell ELSE 0 END), 0) as total_omset,
      COALESCE(SUM(CASE WHEN t.status = 'success' THEN t.profit ELSE 0 END), 0) as total_profit
    FROM agents a
    JOIN transactions t ON t.agent_id = a.id
    ${whereClause}
    GROUP BY a.id
    ORDER BY total_omset DESC
    LIMIT ? OFFSET ?
  `).all(...params, pg.limit, pg.offset);

  return { agents, pagination: pg };
}

/**
 * Export data transaksi ke format CSV string
 */
function exportTransactionsCSV({ dateFrom = '', dateTo = '', agentId = '', status = '' } = {}) {
  const where = [];
  const params = [];

  if (dateFrom) {
    where.push('DATE(t.created_at) >= DATE(?)');
    params.push(dateFrom);
  }
  if (dateTo) {
    where.push('DATE(t.created_at) <= DATE(?)');
    params.push(dateTo);
  }
  if (agentId) {
    where.push('t.agent_id = ?');
    params.push(agentId);
  }
  if (status) {
    where.push('t.status = ?');
    params.push(status);
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT
      t.id,
      t.ref_id,
      t.created_at,
      a.name as agent_name,
      a.phone as agent_phone,
      t.product_name,
      t.category,
      t.target,
      t.price_modal,
      t.price_sell,
      t.profit,
      t.status,
      t.sn,
      t.message
    FROM transactions t
    LEFT JOIN agents a ON a.id = t.agent_id
    ${whereClause}
    ORDER BY t.created_at DESC
  `).all(...params);

  // Build CSV
  const header = ['ID', 'Ref ID', 'Waktu', 'Agen', 'HP Agen', 'Produk', 'Kategori', 'Tujuan', 'Modal', 'Harga Jual', 'Profit', 'Status', 'SN', 'Pesan'];
  const lines = [header.join(',')];

  for (const r of rows) {
    const values = [
      r.id,
      `"${r.ref_id}"`,
      `"${r.created_at}"`,
      `"${r.agent_name || '-'}"`,
      `"${r.agent_phone || '-'}"`,
      `"${(r.product_name || '').replace(/"/g, '""')}"`,
      `"${r.category || '-'}"`,
      `"'${r.target}"`, // prepend single quote to preserve leading zero in Excel
      r.price_modal,
      r.price_sell,
      r.profit,
      `"${r.status}"`,
      `"'${r.sn || ''}"`,
      `"${(r.message || '').replace(/"/g, '""')}"`
    ];
    lines.push(values.join(','));
  }

  return lines.join('\n');
}

module.exports = {
  getSummaryReport,
  getCategoryReport,
  getAgentReport,
  exportTransactionsCSV,
};
