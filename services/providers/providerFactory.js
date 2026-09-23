/**
 * Juragan Pulsa - Provider Factory
 * services/providers/providerFactory.js
 * Factory pattern untuk load adapter H2H provider
 */

const db = require('../../config/database');
const logger = require('../../utils/logger');

// Registry adapter yang tersedia
const adapters = {
  digiflazz: require('./digiflazzAdapter'),
  // Tambah provider lain di sini:
  // vionet: require('./vionetAdapter'),
};

/**
 * Ambil adapter berdasarkan nama provider
 * @param {string} providerName
 * @returns {Object} adapter
 */
function getAdapter(providerName) {
  const adapter = adapters[String(providerName || '').toLowerCase()];
  if (!adapter) {
    throw new Error(`Provider adapter '${providerName}' tidak ditemukan`);
  }
  return adapter;
}

/**
 * Ambil provider default dari database
 * @returns {Object|null}
 */
function getDefaultProvider() {
  return db.prepare('SELECT * FROM providers WHERE is_default = 1 AND is_active = 1 LIMIT 1').get() || null;
}

/**
 * Ambil provider by ID dari database
 * @param {number} id
 * @returns {Object|null}
 */
function getProviderById(id) {
  return db.prepare('SELECT * FROM providers WHERE id = ?').get(id) || null;
}

/**
 * Ambil semua provider aktif
 * @returns {Array}
 */
function getActiveProviders() {
  return db.prepare('SELECT * FROM providers WHERE is_active = 1 ORDER BY is_default DESC').all();
}

/**
 * Ambil adapter untuk provider default
 * @returns {{ adapter: Object, provider: Object }}
 */
function getDefaultAdapter() {
  const provider = getDefaultProvider();
  if (!provider) throw new Error('Tidak ada provider aktif yang dikonfigurasi');
  const adapter = getAdapter(provider.name);
  return { adapter, provider };
}

/**
 * Update saldo provider di DB
 * @param {number} providerId
 * @param {number} balance
 */
function updateProviderBalance(providerId, balance) {
  db.prepare(`
    UPDATE providers
    SET balance = ?, balance_updated_at = datetime('now','localtime')
    WHERE id = ?
  `).run(balance, providerId);
}

module.exports = {
  getAdapter,
  getDefaultProvider,
  getProviderById,
  getActiveProviders,
  getDefaultAdapter,
  updateProviderBalance,
};
