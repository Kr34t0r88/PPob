'use strict';

/**
 * Middleware: requireAdminLogin
 * Redirect to /admin/login if admin session not found
 */
function requireAdminLogin(req, res, next) {
  if (req.session && req.session.adminId) {
    return next();
  }
  req.session.returnTo = req.originalUrl;
  res.redirect('/login');
}

const db = require('../config/database');
const { formatRupiah } = require('../utils/helpers');

/**
 * Middleware: setFlash
 * Expose flash messages and Digiflazz balance from session to res.locals
 */
function setFlash(req, res, next) {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.adminUser = req.session.adminUser || null;

  // Expose Saldo Digiflazz ke semua EJS admin template
  try {
    const digi = db.prepare("SELECT balance, balance_updated_at FROM providers WHERE name = 'digiflazz' LIMIT 1").get();
    res.locals.digiBalance = digi ? (digi.balance || 0) : 0;
    res.locals.digiBalanceUpdated = digi ? digi.balance_updated_at : null;
    res.locals.formatRupiah = formatRupiah;
  } catch (_) {
    res.locals.digiBalance = 0;
    res.locals.digiBalanceUpdated = null;
  }

  next();
}

/**
 * Helper: set flash message in session
 */
function flashMessage(req, type, message) {
  req.session.flash = { type, message };
}

module.exports = { requireAdminLogin, setFlash, flashMessage };
