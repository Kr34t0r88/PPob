/**
 * Juragan Pulsa - API Token Authentication Middleware
 * middleware/apiAuth.js
 */

const { getAgentByApiToken } = require('../services/agentService');
const { getAdminByApiToken } = require('../services/adminService');

/**
 * Middleware untuk otentikasi Agent via Bearer Token
 */
function requireApiToken(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  let token = '';

  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else if (req.query.token) {
    token = String(req.query.token).trim();
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Token otentikasi tidak disertakan (Authorization: Bearer <token>)'
    });
  }

  try {
    const agent = getAgentByApiToken(token);
    if (!agent) {
      // Cek apakah token admin
      const admin = getAdminByApiToken(token);
      if (admin && admin.is_active) {
        req.admin = admin;
        req.adminId = admin.id;
        req.role = 'admin';
        return next();
      }

      return res.status(401).json({
        success: false,
        error: 'Sesi kedaluwarsa atau token tidak valid. Silakan login kembali.'
      });
    }

    if (!agent.is_active) {
      return res.status(403).json({
        success: false,
        error: 'Akun agen Anda sedang dinonaktifkan. Hubungi admin.'
      });
    }

    // Attach agent to request
    req.agent = agent;
    req.agentId = agent.id;
    req.role = 'agent';
    next();
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Gagal memverifikasi token: ' + err.message
    });
  }
}

/**
 * Middleware khusus untuk otentikasi Admin via Bearer Token
 */
function requireAdminApiToken(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  let token = '';

  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else if (req.query.token) {
    token = String(req.query.token).trim();
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Akses khusus administrator. Token tidak disertakan.'
    });
  }

  try {
    const admin = getAdminByApiToken(token);
    if (!admin) {
      return res.status(401).json({
        success: false,
        error: 'Akses ditolak. Token admin tidak valid atau sesi telah berakhir.'
      });
    }

    if (!admin.is_active) {
      return res.status(403).json({
        success: false,
        error: 'Akun administrator Anda sedang dinonaktifkan.'
      });
    }

    req.admin = admin;
    req.adminId = admin.id;
    req.role = 'admin';
    next();
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Gagal memverifikasi token admin: ' + err.message
    });
  }
}

module.exports = {
  requireApiToken,
  requireAdminApiToken,
};
