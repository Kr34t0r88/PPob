/**
 * Juragan Pulsa - Agent Service
 * services/agentService.js
 */

const db = require('../config/database');
const bcrypt = require('bcryptjs');
const { generateApiToken } = require('../utils/generateRefId');
const { paginate } = require('../utils/helpers');
const logger = require('../utils/logger');

/**
 * Ambil semua agen
 */
function getAllAgents({ page = 1, limit = 20, q = '', status = '' } = {}) {
  const conditions = [];
  const params = [];

  if (q) {
    conditions.push('(name LIKE ? OR username LIKE ? OR phone LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (status === 'active') { conditions.push('is_active = 1'); }
  else if (status === 'inactive') { conditions.push('is_active = 0'); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM agents ${where}`).get(...params)?.cnt || 0;
  const pg = paginate(total, page, limit);

  const agents = db.prepare(`
    SELECT id, username, name, phone, email, balance, markup_group,
           is_active, last_login, created_at
    FROM agents ${where}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, pg.limit, pg.offset);

  return { agents, pagination: pg };
}

/**
 * Ambil agen by ID
 */
function getAgentById(id) {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id) || null;
}

/**
 * Ambil agen by username
 */
function getAgentByUsername(username) {
  return db.prepare('SELECT * FROM agents WHERE username = ?').get(String(username || '')) || null;
}

/**
 * Ambil agen by API token
 */
function getAgentByApiToken(token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM agents WHERE api_token = ? AND is_active = 1').get(String(token)) || null;
}

/**
 * Buat agen baru
 */
function createAgent(data) {
  const { username, password, name, phone, email = '', address = '', markup_group = 'default' } = data;
  if (!username || !password || !name || !phone) {
    throw new Error('Field wajib: username, password, name, phone');
  }
  if (getAgentByUsername(username)) {
    throw new Error('Username sudah digunakan');
  }

  const initialBal = Math.max(0, parseFloat(data.balance !== undefined ? data.balance : data.initial_balance) || 0);
  const hash = bcrypt.hashSync(String(password), 10);

  const insertAgent = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO agents (username, password, name, phone, email, address, markup_group, balance)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(username).trim(),
      hash,
      String(name).trim(),
      String(phone).trim(),
      String(email).trim(),
      String(address).trim(),
      String(markup_group).trim(),
      initialBal
    );

    if (initialBal > 0) {
      db.prepare(`
        INSERT INTO balance_mutations
          (agent_id, type, amount, balance_before, balance_after, notes, created_by)
        VALUES (?, 'deposit', ?, 0, ?, 'Saldo awal pendaftaran agen', 'admin')
      `).run(result.lastInsertRowid, initialBal, initialBal);
    }

    return result;
  });

  return insertAgent();
}

/**
 * Update data agen
 */
function updateAgent(id, data) {
  const existing = getAgentById(id);
  if (!existing) throw new Error('Agen tidak ditemukan');

  const fields = [];
  const params = [];

  if (data.name !== undefined) { fields.push('name = ?'); params.push(String(data.name).trim()); }
  if (data.phone !== undefined) { fields.push('phone = ?'); params.push(String(data.phone).trim()); }
  if (data.email !== undefined) { fields.push('email = ?'); params.push(String(data.email).trim()); }
  if (data.address !== undefined) { fields.push('address = ?'); params.push(String(data.address).trim()); }
  if (data.markup_group !== undefined) { fields.push('markup_group = ?'); params.push(String(data.markup_group)); }
  if (data.password !== undefined && data.password) {
    fields.push('password = ?');
    params.push(bcrypt.hashSync(String(data.password), 10));
  }
  if (data.pin !== undefined) {
    fields.push('pin = ?');
    params.push(data.pin ? bcrypt.hashSync(String(data.pin), 10) : '');
  }

  if (!fields.length) return existing;
  params.push(id);
  db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return getAgentById(id);
}

/**
 * Toggle status aktif/nonaktif agen
 */
function toggleAgent(id) {
  const agent = getAgentById(id);
  if (!agent) throw new Error('Agen tidak ditemukan');
  const newStatus = agent.is_active ? 0 : 1;
  db.prepare('UPDATE agents SET is_active = ? WHERE id = ?').run(newStatus, id);
  return newStatus;
}

/**
 * Top-up saldo agen (oleh admin)
 * @param {number} agentId
 * @param {number} amount
 * @param {string} notes
 * @param {string} createdBy - username admin
 */
function topupBalance(agentId, amount, notes = '', createdBy = 'admin') {
  const agent = getAgentById(agentId);
  if (!agent) throw new Error('Agen tidak ditemukan');

  const safeAmount = Math.max(0, parseFloat(amount) || 0);
  if (safeAmount <= 0) throw new Error('Nominal tidak valid');

  const topup = db.transaction(() => {
    const before = agent.balance;
    const after = before + safeAmount;

    db.prepare('UPDATE agents SET balance = ? WHERE id = ?').run(after, agentId);
    db.prepare(`
      INSERT INTO balance_mutations
        (agent_id, type, amount, balance_before, balance_after, notes, created_by)
      VALUES (?, 'deposit', ?, ?, ?, ?, ?)
    `).run(agentId, safeAmount, before, after, String(notes), String(createdBy));

    return { before, after, amount: safeAmount };
  });

  return topup();
}

/**
 * Potong saldo agen untuk transaksi
 * Atomic: potong + catat mutasi dalam satu SQLite transaction
 * @returns {{ before, after }}
 */
function deductBalance(agentId, amount, refId = '', notes = '') {
  const agent = db.prepare('SELECT id, balance FROM agents WHERE id = ? AND is_active = 1').get(agentId);
  if (!agent) throw new Error('Agen tidak ditemukan atau tidak aktif');

  const safeAmount = parseFloat(amount) || 0;
  if (agent.balance < safeAmount) {
    throw new Error(`Saldo tidak cukup (saldo: Rp ${agent.balance.toLocaleString('id-ID')}, dibutuhkan: Rp ${safeAmount.toLocaleString('id-ID')})`);
  }

  const deduct = db.transaction(() => {
    const before = agent.balance;
    const after = before - safeAmount;

    db.prepare('UPDATE agents SET balance = ? WHERE id = ?').run(after, agentId);
    db.prepare(`
      INSERT INTO balance_mutations
        (agent_id, type, amount, balance_before, balance_after, ref_id, notes)
      VALUES (?, 'debit', ?, ?, ?, ?, ?)
    `).run(agentId, safeAmount, before, after, String(refId), String(notes));

    return { before, after };
  });

  return deduct();
}

/**
 * Refund saldo agen setelah transaksi gagal
 * @returns {{ before, after }}
 */
function refundBalance(agentId, amount, refId = '', notes = 'Refund transaksi gagal') {
  const agent = db.prepare('SELECT id, balance FROM agents WHERE id = ?').get(agentId);
  if (!agent) throw new Error('Agen tidak ditemukan');

  const safeAmount = parseFloat(amount) || 0;
  if (safeAmount <= 0) return { before: agent.balance, after: agent.balance };

  const refund = db.transaction(() => {
    const before = agent.balance;
    const after = before + safeAmount;

    db.prepare('UPDATE agents SET balance = ? WHERE id = ?').run(after, agentId);
    db.prepare(`
      INSERT INTO balance_mutations
        (agent_id, type, amount, balance_before, balance_after, ref_id, notes)
      VALUES (?, 'refund', ?, ?, ?, ?, ?)
    `).run(agentId, safeAmount, before, after, String(refId), String(notes));

    return { before, after };
  });

  return refund();
}

/**
 * Verifikasi login agen
 * @returns {Object|null} agent row atau null
 */
function verifyLogin(username, password) {
  const agent = db.prepare('SELECT * FROM agents WHERE username = ? AND is_active = 1').get(String(username || ''));
  if (!agent) return null;
  if (!bcrypt.compareSync(String(password || ''), agent.password)) return null;

  // Update last_login
  db.prepare("UPDATE agents SET last_login = datetime('now','localtime') WHERE id = ?").run(agent.id);
  return agent;
}

/**
 * Generate & simpan API token untuk agen
 * @returns {string} token
 */
function generateToken(agentId) {
  const token = generateApiToken();
  db.prepare('UPDATE agents SET api_token = ? WHERE id = ?').run(token, agentId);
  return token;
}

/**
 * Hapus API token (logout)
 */
function revokeToken(agentId) {
  db.prepare('UPDATE agents SET api_token = NULL WHERE id = ?').run(agentId);
}

/**
 * Riwayat mutasi saldo agen
 */
function getBalanceMutations(agentId, { page = 1, limit = 20 } = {}) {
  const total = db.prepare('SELECT COUNT(*) as cnt FROM balance_mutations WHERE agent_id = ?').get(agentId)?.cnt || 0;
  const pg = paginate(total, page, limit);

  const mutations = db.prepare(`
    SELECT * FROM balance_mutations
    WHERE agent_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(agentId, pg.limit, pg.offset);

  return { mutations, pagination: pg };
}

/**
 * Statistik per agen
 */
function getAgentStats(agentId) {
  return db.prepare(`
    SELECT
      COUNT(*) as total_trx,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_trx,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_trx,
      SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) as failed_trx,
      SUM(CASE WHEN status = 'success' THEN price_sell ELSE 0 END) as total_omset,
      SUM(CASE WHEN status = 'success' THEN profit     ELSE 0 END) as total_profit
    FROM transactions
    WHERE agent_id = ?
  `).get(agentId) || {};
}

function getAgentTransactions(agentId, limit = 20) {
  return db.prepare(`
    SELECT * FROM transactions
    WHERE agent_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(agentId, limit);
}

function getAgentMutations(agentId, limit = 20, offset = 0) {
  return db.prepare(`
    SELECT * FROM balance_mutations
    WHERE agent_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(agentId, limit, offset);
}

function listAgents({ page = 1, perPage = 20, search = '', status = '' } = {}) {
  const res = getAllAgents({ page, limit: perPage, q: search, status });
  return {
    agents: res.agents,
    total: res.pagination.total,
    totalPages: res.pagination.totalPages,
  };
}

module.exports = {
  getAllAgents,
  listAgents,
  getAgentById,
  getAgentByUsername,
  getAgentByApiToken,
  createAgent,
  updateAgent,
  toggleAgent,
  topupBalance,
  deductBalance,
  refundBalance,
  verifyLogin,
  generateToken,
  revokeToken,
  getBalanceMutations,
  getAgentStats,
  getAgentTransactions,
  getAgentMutations,
};
