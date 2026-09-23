/**
 * Juragan Pulsa - Admin Transactions Router
 * routes/admin/transactions.js
 */

const express = require('express');
const router = express.Router();
const { listTransactions, getTransactionById, checkTransactionStatus } = require('../../services/transactionService');
const { requireAdminLogin } = require('../../middleware/adminAuth');
const { formatRupiah, formatDateTime } = require('../../utils/helpers');

// GET /admin/transactions
router.get('/transactions', requireAdminLogin, (req, res) => {
  const { status = '', category = '', channel = '', date_from = '', date_to = '', q = '', page = 1 } = req.query;

  const result = listTransactions({
    status,
    category,
    channel,
    dateFrom: date_from,
    dateTo: date_to,
    q,
    page: parseInt(page, 10) || 1,
    limit: 20,
  });

  res.render('admin/transactions', {
    title: 'Manajemen Transaksi',
    activeNav: 'transactions',
    transactions: result.transactions,
    pagination: result.pagination,
    filter: { status, category, channel, date_from, date_to, q },
    formatRupiah,
    formatDateTime,
  });
});


// GET /admin/transactions/:id
router.get('/transactions/:id', requireAdminLogin, (req, res) => {
  const tx = getTransactionById(req.params.id);
  if (!tx) {
    req.session.flash = { type: 'error', message: 'Transaksi tidak ditemukan' };
    return res.redirect('/admin/transactions');
  }

  res.render('admin/transaction_detail', {
    title: `Detail Transaksi #${tx.id}`,
    activeNav: 'transactions',
    tx,
    formatRupiah,
    formatDateTime,
  });
});

// POST /admin/transactions/:id/recheck
router.post('/transactions/:id/recheck', requireAdminLogin, async (req, res) => {
  try {
    const updated = await checkTransactionStatus(req.params.id);
    req.session.flash = {
      type: 'success',
      message: `Status transaksi berhasil diperbarui: ${updated.status.toUpperCase()} (${updated.message || '-'})`
    };
  } catch (err) {
    req.session.flash = { type: 'error', message: `Gagal periksa transaksi: ${err.message}` };
  }
  res.redirect(`/admin/transactions/${req.params.id}`);
});

module.exports = router;
