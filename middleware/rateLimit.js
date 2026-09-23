/**
 * Juragan Pulsa - Rate Limiters
 * middleware/rateLimit.js
 */

const rateLimit = require('express-rate-limit');

// Limiter untuk login (brute force protection)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 menit
  max: 15, // max 15 attempts
  message: {
    success: false,
    error: 'Terlalu banyak percobaan login. Silakan coba lagi setelah 15 menit.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Limiter untuk REST API endpoint agen
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 menit
  max: 120, // max 120 reqs/min
  message: {
    success: false,
    error: 'Terlalu banyak permintaan API. Harap tunggu sebentar.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// General global limiter
const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 menit
  max: 300, // 300 requests per minute
  message: 'Terlalu banyak permintaan dari IP Anda.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith('/public') || req.path.startsWith('/uploads'),
});

module.exports = {
  loginLimiter,
  apiLimiter,
  generalLimiter,
};
