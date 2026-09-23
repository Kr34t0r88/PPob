/**
 * Juragan Pulsa - Helper Utilities
 * utils/helpers.js
 */

/**
 * Format angka ke format Rupiah
 * @param {number} amount
 * @returns {string} contoh: "Rp 150.000"
 */
function formatRupiah(amount) {
  const num = parseInt(amount || 0, 10);
  return 'Rp ' + num.toLocaleString('id-ID');
}

/**
 * Format tanggal ke format Indonesia
 * @param {string|Date} date
 * @returns {string} contoh: "16 Sep 2026"
 */
function formatDate(date) {
  if (!date) return '-';
  const d = new Date(date);
  if (isNaN(d.getTime())) return String(date);
  return d.toLocaleDateString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });
}

/**
 * Format datetime ke format Indonesia
 * @param {string|Date} date
 * @returns {string} contoh: "16 Sep 2026 08:30"
 */
function formatDateTime(date) {
  if (!date) return '-';
  const d = new Date(date);
  if (isNaN(d.getTime())) return String(date);
  return d.toLocaleDateString('id-ID', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Sensor nomor HP
 * @param {string} phone
 * @returns {string} contoh: "0812****5678"
 */
function maskPhone(phone) {
  const p = String(phone || '').replace(/\D/g, '');
  if (p.length < 8) return phone;
  const prefix = p.slice(0, 4);
  const suffix = p.slice(-4);
  const masked = '*'.repeat(Math.max(4, p.length - 8));
  return prefix + masked + suffix;
}

/**
 * Generate random alphanumeric code
 * @param {number} length
 * @returns {string}
 */
function generateCode(length = 6) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Generate random number string
 * @param {number} digits
 * @returns {string}
 */
function generateDigits(digits = 4) {
  const max = Math.pow(10, digits);
  const min = Math.pow(10, digits - 1);
  return String(Math.floor(Math.random() * (max - min) + min));
}

/**
 * Promise-based delay
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Normalisasi nomor HP Indonesia ke format 08xxxxxxxxxx
 * @param {string} phone
 * @returns {string}
 */
function normalizePhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('62')) digits = '0' + digits.slice(2);
  if (!digits.startsWith('0')) digits = '0' + digits;
  return digits;
}

/**
 * Normalisasi nomor HP ke format WhatsApp internasional (628xxxxxxxx)
 * @param {string} phone
 * @returns {string} contoh: "6281947215703"
 */
function formatWaNumber(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) {
    digits = '62' + digits.slice(1);
  } else if (digits.startsWith('8')) {
    digits = '62' + digits;
  } else if (!digits.startsWith('62') && digits.length >= 8) {
    digits = '62' + digits;
  }
  return digits;
}


/**
 * Truncate string
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
function truncate(str, maxLen = 50) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}

/**
 * Escape HTML untuk prevent XSS di EJS
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Parse JSON safely
 * @param {string} str
 * @param {*} defaultVal
 * @returns {*}
 */
function parseJSON(str, defaultVal = {}) {
  try {
    return JSON.parse(str) || defaultVal;
  } catch {
    return defaultVal;
  }
}

/**
 * Pagination helper
 * @param {number} total
 * @param {number} page
 * @param {number} limit
 * @returns {{ offset, page, limit, totalPages, hasPrev, hasNext }}
 */
function paginate(total, page = 1, limit = 20) {
  const safePage = Math.max(1, parseInt(page) || 1);
  const safeLimit = Math.min(1000, Math.max(1, parseInt(limit) || 20));
  const totalPages = Math.ceil(total / safeLimit);
  const offset = (safePage - 1) * safeLimit;
  return {
    offset,
    page: safePage,
    limit: safeLimit,
    total,
    totalPages,
    hasPrev: safePage > 1,
    hasNext: safePage < totalPages,
  };
}

module.exports = {
  formatRupiah,
  formatDate,
  formatDateTime,
  maskPhone,
  generateCode,
  generateDigits,
  sleep,
  normalizePhone,
  formatWaNumber,
  truncate,
  escapeHtml,
  parseJSON,
  paginate,
};

