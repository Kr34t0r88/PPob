'use strict';

const express = require('express');
const router = express.Router();
const { flashMessage } = require('../../middleware/adminAuth');

// Lazy-load adminService to avoid circular deps
function getAdminService() {
  try {
    return require('../../services/adminService');
  } catch (e) {
    return null;
  }
}

// GET /login & /admin/login
router.get(['/login', '/admin/login'], (req, res) => {
  if (req.session && req.session.adminId) {
    return res.redirect('/admin/dashboard');
  }
  const error = req.query.error || null;
  res.render('auth/login', { title: 'Login Admin', error, layout: false });
});

// POST /login & /admin/login
router.post(['/login', '/admin/login'], async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.render('auth/login', {
        title: 'Login Admin',
        error: 'Username dan password wajib diisi.',
        layout: false,
      });
    }

    const adminService = getAdminService();
    let admin = null;

    if (adminService && typeof adminService.verifyLogin === 'function') {
      admin = await adminService.verifyLogin(username, password);
    } else {
      // Fallback: hardcoded untuk development jika service belum ada
      if (username === 'admin' && password === 'admin123') {
        admin = { id: 1, username: 'admin', name: 'Administrator' };
      }
    }

    if (!admin) {
      return res.render('auth/login', {
        title: 'Login Admin',
        error: 'Username atau password salah.',
        layout: false,
      });
    }

    req.session.adminId = admin.id;
    req.session.adminUser = { id: admin.id, username: admin.username, name: admin.name || admin.username };

    const returnTo = req.session.returnTo || '/admin/dashboard';
    delete req.session.returnTo;

    flashMessage(req, 'success', `Selamat datang, ${admin.name || admin.username}!`);
    res.redirect(returnTo);
  } catch (err) {
    console.error('[Admin Auth] Login error:', err);
    res.render('auth/login', {
      title: 'Login Admin',
      error: 'Terjadi kesalahan server. Silakan coba lagi.',
      layout: false,
    });
  }
});

// GET /logout & /admin/logout
router.get(['/logout', '/admin/logout'], (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error('[Admin Auth] Session destroy error:', err);
    res.redirect('/login');
  });
});

module.exports = router;
