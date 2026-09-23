/**
 * Juragan Pulsa - Session Auth Middleware
 * middleware/auth.js
 */

const { requireAdminLogin, setFlash, flashMessage } = require('./adminAuth');

function requireAgentLogin(req, res, next) {
  if (req.session && req.session.agentId) {
    return next();
  }
  req.session.returnTo = req.originalUrl;
  res.redirect('/agent/login');
}

module.exports = {
  requireAdminLogin,
  requireAgentLogin,
  setFlash,
  flashMessage,
};
