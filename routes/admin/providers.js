/**
 * Juragan Pulsa - Admin Providers Router
 * routes/admin/providers.js
 */

const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const { getAdapter, updateProviderBalance, getProviderById } = require('../../services/providers/providerFactory');
const { requireAdminLogin } = require('../../middleware/adminAuth');
const { formatRupiah, formatDateTime } = require('../../utils/helpers');

// GET /admin/providers
router.get('/providers', requireAdminLogin, (req, res) => {
  const providers = db.prepare('SELECT * FROM providers ORDER BY is_default DESC, id ASC').all();

  // Ambil data statistik per provider
  const stats = {};
  for (const p of providers) {
    const productStats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active
      FROM products 
      WHERE provider_id = ?
    `).get(p.id) || { total: 0, active: 0 };

    const trxStats = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM transactions 
      WHERE provider_id = ?
    `).get(p.id) || { total: 0, success: 0, pending: 0, failed: 0 };

    const lastSync = db.prepare(`
      SELECT * FROM product_sync_logs 
      WHERE provider_id = ? 
      ORDER BY id DESC LIMIT 1
    `).get(p.id) || null;

    stats[p.id] = {
      products: productStats,
      transactions: trxStats,
      lastSync
    };
  }

  // Ambil 5 log webhook terakhir
  const recentWebhooks = db.prepare(`
    SELECT * FROM webhook_logs 
    ORDER BY id DESC LIMIT 5
  `).all();

  // Total keseluruhan produk & transaksi
  const totalProductsAll = db.prepare('SELECT COUNT(*) as count FROM products').get()?.count || 0;
  const totalTrxAll = db.prepare("SELECT COUNT(*) as count, SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success FROM transactions").get() || { count: 0, success: 0 };

  res.render('admin/providers', {
    title: 'Manajemen Provider H2H',
    activeNav: 'providers',
    providers,
    stats,
    recentWebhooks,
    totalProductsAll,
    totalTrxAll,
    formatRupiah,
    formatDateTime,
  });
});

// POST /admin/providers/:id/edit
router.post('/providers/:id/edit', requireAdminLogin, (req, res) => {
  const { label, api_url, username, api_key, webhook_secret, is_active, is_default } = req.body;
  const id = req.params.id;

  try {
    if (is_default === '1') {
      db.prepare('UPDATE providers SET is_default = 0').run();
    }

    db.prepare(`
      UPDATE providers SET
        label = ?,
        api_url = ?,
        username = ?,
        api_key = ?,
        webhook_secret = ?,
        is_active = ?,
        is_default = ?
      WHERE id = ?
    `).run(
      String(label).trim(),
      String(api_url).trim(),
      String(username).trim(),
      String(api_key).trim(),
      String(webhook_secret).trim(),
      is_active === '1' ? 1 : 0,
      is_default === '1' ? 1 : 0,
      id
    );

    req.session.flash = { type: 'success', message: 'Kredensial provider berhasil diperbarui.' };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }

  res.redirect('/admin/providers');
});

// POST /admin/providers/:id/check-balance
router.post('/providers/:id/check-balance', requireAdminLogin, async (req, res) => {
  const id = req.params.id;
  const provider = getProviderById(id);

  if (!provider) {
    req.session.flash = { type: 'error', message: 'Provider tidak ditemukan' };
    return res.redirect('/admin/providers');
  }

  try {
    const adapter = getAdapter(provider.name);
    const result = await adapter.checkBalance(provider);
    updateProviderBalance(provider.id, result.deposit);

    req.session.flash = {
      type: 'success',
      message: `Saldo ${provider.label} saat ini: ${formatRupiah(result.deposit)}`
    };
  } catch (err) {
    req.session.flash = { type: 'error', message: `Gagal cek saldo: ${err.message}` };
  }

  const returnUrl = req.headers.referer || '/admin/providers';
  res.redirect(returnUrl);
});

module.exports = router;
