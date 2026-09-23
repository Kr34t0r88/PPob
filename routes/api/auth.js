/**
 * Juragan Pulsa - Agent REST API Authentication Router
 * routes/api/auth.js
 */

const express = require('express');
const router = express.Router();
const { verifyLogin, generateToken, revokeToken, getAgentById, updateAgent } = require('../../services/agentService');
const { requireApiToken } = require('../../middleware/apiAuth');
const { loginLimiter } = require('../../middleware/rateLimit');
const bcrypt = require('bcryptjs');

// POST /api/auth/login
router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Username dan password wajib diisi' });
  }

  try {
    // 1. Cek login agen
    const agent = verifyLogin(username, password);
    if (agent) {
      if (!agent.is_active) {
        return res.status(403).json({ success: false, error: 'Akun agen Anda sedang dinonaktifkan oleh admin' });
      }

      const token = generateToken(agent.id);

      return res.json({
        success: true,
        role: 'agent',
        token,
        agent: {
          id: agent.id,
          name: agent.name,
          username: agent.username,
          phone: agent.phone,
          email: agent.email || '',
          balance: agent.balance,
          markup_group: agent.markup_group,
          created_at: agent.created_at,
        }
      });
    }

    // 2. Cek login admin
    const { verifyLogin: verifyAdminLogin, generateAdminToken } = require('../../services/adminService');
    const admin = verifyAdminLogin(username, password);
    if (admin) {
      const token = generateAdminToken(admin.id);
      return res.json({
        success: true,
        role: 'admin',
        token,
        admin: {
          id: admin.id,
          name: admin.name,
          username: admin.username,
          role: 'admin'
        }
      });
    }

    return res.status(401).json({ success: false, error: 'Username atau password salah' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/auth/logout
router.post('/logout', requireApiToken, (req, res) => {
  try {
    revokeToken(req.agent.id);
    return res.json({ success: true, message: 'Berhasil keluar' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/auth/profile
router.get('/profile', requireApiToken, (req, res) => {
  const agent = getAgentById(req.agent.id);
  if (!agent) return res.status(404).json({ success: false, error: 'Agen tidak ditemukan' });

  return res.json({
    success: true,
    agent: {
      id: agent.id,
      name: agent.name,
      username: agent.username,
      phone: agent.phone,
      email: agent.email,
      address: agent.address,
      balance: agent.balance,
      markup_group: agent.markup_group,
      created_at: agent.created_at,
    }
  });
});

// PUT /api/auth/profile
router.put('/profile', requireApiToken, (req, res) => {
  const { name, phone, email, address } = req.body;

  try {
    const updated = updateAgent(req.agent.id, { name, phone, email, address });
    return res.json({
      success: true,
      agent: {
        id: updated.id,
        name: updated.name,
        username: updated.username,
        phone: updated.phone,
        email: updated.email,
        address: updated.address,
        balance: updated.balance,
      }
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// PUT /api/auth/change-password
router.put('/change-password', requireApiToken, (req, res) => {
  const { old_password, new_password } = req.body;
  if (!old_password || !new_password) {
    return res.status(400).json({ success: false, error: 'Password lama dan baru wajib diisi' });
  }

  if (new_password.length < 6) {
    return res.status(400).json({ success: false, error: 'Password baru minimal 6 karakter' });
  }

  const agent = getAgentById(req.agent.id);
  const isMatch = bcrypt.compareSync(old_password, agent.password);
  if (!isMatch) {
    return res.status(400).json({ success: false, error: 'Password lama tidak cocok' });
  }

  try {
    updateAgent(req.agent.id, { password: new_password });
    return res.json({ success: true, message: 'Password berhasil diubah' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
