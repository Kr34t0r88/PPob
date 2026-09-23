/**
 * Juragan Pulsa - Ref ID & Deposit Code Generator
 * utils/generateRefId.js
 */

const { generateDigits } = require('./helpers');

/**
 * Generate unique ref_id untuk transaksi
 * Format: JP-{agentId}-{timestamp}-{random4digit}
 * Contoh: JP-12-1726466400000-4827
 *
 * @param {number|string} agentId
 * @returns {string}
 */
function generateRefId(agentId) {
  const ts = Date.now();
  const rand = generateDigits(4);
  return `JP-${agentId}-${ts}-${rand}`;
}

/**
 * Generate kode deposit unik untuk matching QRIS statis
 * Cara kerja: agen transfer dengan nominal unik (amount + kode)
 * Contoh: amount=100000, code=025 → transfer Rp 100.025
 *
 * Format deposit_code: DEP-{agentId}-{timestamp6digit}
 * Unique amount suffix: 3 digit terakhir timestamp
 *
 * @param {number|string} agentId
 * @param {number} amount - nominal deposit (Rp)
 * @returns {{ depositCode: string, uniqueAmount: number }}
 */
function generateDepositCode(agentId, amount) {
  const ts = Date.now();
  // Ambil 3 digit terakhir timestamp untuk kode unik (001-999)
  const suffix = String(ts % 1000).padStart(3, '0');
  const depositCode = `DEP-${agentId}-${ts}`;
  const uniqueAmount = parseInt(amount, 10) + parseInt(suffix, 10);

  return { depositCode, uniqueAmount, suffix };
}

/**
 * Generate token API yang aman untuk agen
 * @returns {string} 64-char hex token
 */
function generateApiToken() {
  const crypto = require('crypto');
  return crypto.randomBytes(32).toString('hex');
}

module.exports = {
  generateRefId,
  generateDepositCode,
  generateApiToken,
};
