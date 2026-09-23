/**
 * Juragan Pulsa - Admin Public Orders Router
 * routes/admin/publicOrders.js
 */

const express = require('express');
const router = express.Router();
const { listPublicOrders, recheckPublicOrder, processPaymentSuccess } = require('../../services/publicOrderService');
const db = require('../../config/database');
const { requireAdminLogin } = require('../../middleware/adminAuth');
const { formatRupiah, formatDateTime } = require('../../utils/helpers');

// GET /admin/public-orders
router.get('/public-orders', requireAdminLogin, (req, res) => {
  const { status = '', q = '', date_from = '', date_to = '', page = 1 } = req.query;

  const result = listPublicOrders({
    status,
    q,
    dateFrom: date_from,
    dateTo: date_to,
    page: parseInt(page, 10) || 1,
    limit: 25
  });

  // Summary counts
  const stats = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_count,
      SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count,
      SUM(CASE WHEN status = 'success' THEN total_amount ELSE 0 END) as total_omset,
      SUM(CASE WHEN status = 'success' THEN (price_public - price_modal + unique_code) ELSE 0 END) as total_profit
    FROM public_orders
  `).get();

  res.render('admin/public_orders', {
    title: 'Transaksi Web Publik (Storefront)',
    activeNav: 'public_orders',
    orders: result.orders,
    pagination: result.pagination,
    stats: stats || {},
    filter: { status, q, date_from, date_to },
    formatRupiah,
    formatDateTime
  });
});

// POST /admin/public-orders/:id/recheck
router.post('/public-orders/:id/recheck', requireAdminLogin, async (req, res) => {
  try {
    const updated = await recheckPublicOrder(req.params.id);
    req.session.flash = {
      type: 'success',
      message: `Status pesanan ${updated.invoice_code} berhasil diperbarui: [${updated.status.toUpperCase()}] ${updated.message || ''}`
    };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin/public-orders');
});

// POST /admin/public-orders/:id/retry
router.post('/public-orders/:id/retry', requireAdminLogin, async (req, res) => {
  try {
    const updated = await processPaymentSuccess(req.params.id, 'Manual Admin Trigger');
    req.session.flash = {
      type: 'success',
      message: `Proses H2H untuk invoice ${updated.invoice_code} dijalankan: [${updated.status.toUpperCase()}] ${updated.message || ''}`
    };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin/public-orders');
});

// POST /admin/public-orders/:id/manual-success
router.post(['/public-orders/:id/manual-success', '/admin/public-orders/:id/manual-success'], requireAdminLogin, (req, res) => {
  const { sn, notes } = req.body;
  try {
    db.prepare(`
      UPDATE public_orders SET
        status = 'success',
        sn = ?,
        message = ?,
        completed_at = datetime('now','localtime')
      WHERE id = ?
    `).run(sn || 'MANUAL-OK', notes || 'Diselesaikan manual oleh admin', req.params.id);
    req.session.flash = { type: 'success', message: 'Status transaksi berhasil diset Sukses secara manual.' };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin/public-orders');
});

module.exports = router;