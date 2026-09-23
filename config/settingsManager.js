/**
 * Juragan Pulsa - Settings Manager
 * config/settingsManager.js
 * Read/write settings dari database dengan in-memory cache
 */

const db = require('./database');

// In-memory cache
let cache = null;
let cacheLoaded = false;

function loadCache() {
  if (cacheLoaded) return;
  try {
    const rows = db.prepare('SELECT key, value, type FROM settings').all();
    cache = {};
    for (const row of rows) {
      cache[row.key] = castValue(row.value, row.type);
    }
    cacheLoaded = true;
  } catch (e) {
    cache = {};
    cacheLoaded = false;
  }
}

function castValue(value, type) {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'number':  return Number(value);
    case 'boolean': return value === '1' || value === 'true';
    case 'json':    try { return JSON.parse(value); } catch { return value; }
    default:        return String(value);
  }
}

/**
 * Ambil nilai setting dari DB (dengan cache)
 * @param {string} key - Setting key
 * @param {*} defaultValue - Nilai default jika key tidak ada
 * @returns {*} Nilai setting
 */
function getSetting(key, defaultValue = null) {
  loadCache();
  if (cache && key in cache && cache[key] !== null && cache[key] !== '') {
    return cache[key];
  }
  return defaultValue;
}

/**
 * Simpan/update setting ke DB
 * @param {string} key
 * @param {*} value
 * @param {string} type - 'string', 'number', 'boolean', 'json'
 */
function setSetting(key, value, type = 'string') {
  const strVal = type === 'json' ? JSON.stringify(value) : String(value ?? '');
  db.prepare(`
    INSERT INTO settings (key, value, type, updated_at)
    VALUES (?, ?, ?, datetime('now','localtime'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      type = excluded.type,
      updated_at = datetime('now','localtime')
  `).run(key, strVal, type);

  // Update cache
  if (cache) {
    cache[key] = castValue(strVal, type);
  }
}

/**
 * Set banyak settings sekaligus
 * @param {Object} settingsObj - { key: value, ... }
 */
function setSettings(settingsObj) {
  const upsert = db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, datetime('now','localtime'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = datetime('now','localtime')
  `);
  const tx = db.transaction((obj) => {
    for (const [key, value] of Object.entries(obj)) {
      upsert.run(key, String(value ?? ''));
      if (cache) cache[key] = String(value ?? '');
    }
  });
  tx(settingsObj);
}

/**
 * Ambil semua settings sebagai object key-value
 * @returns {Object}
 */
function getAllSettings() {
  const rows = db.prepare('SELECT key, value, type FROM settings ORDER BY key').all();
  const result = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

/**
 * Hapus cache (paksa reload dari DB)
 */
function invalidateCache() {
  cache = null;
  cacheLoaded = false;
}

module.exports = {
  getSetting,
  setSetting,
  setSettings,
  getAllSettings,
  invalidateCache,
};
