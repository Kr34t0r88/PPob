/**
 * Juragan Pulsa - Admin Deposits & Bank Accounts Router
 * routes/admin/deposits.js
 */

const express = require('express');
const router = express.Router();
const {
  getAllDeposits,
  getDepositById,
  approveDeposit,
  rejectDeposit,
  getBankAccounts,
  addBankAccount,
  toggleBankAccount,
  deleteBankAccount
} = require('../../services/depositService');
const { requireAdminLogin } = require('../../middleware/adminAuth');
const { formatRupiah, formatDateTime } = require('../../utils/helpers');

// GET /admin/deposits
router.get('/deposits', requireAdminLogin, (req, res) => {
  const { status = '', q = '', page = 1 } = req.query;

  const result = getAllDeposits({
    status,
    q,
    page: parseInt(page, 10) || 1,
    limit: 20,
  });

  const bankAccounts = getBankAccounts(false);

  res.render('admin/deposits', {
    title: 'Manajemen Deposit & Rekening',
    activeNav: 'deposits',
    deposits: result.deposits,
    pagination: result.pagination,
    bankAccounts,
    filter: { status, q },
    formatRupiah,
    formatDateTime,
  });
});

// POST /admin/deposits/:id/approve
router.post('/deposits/:id/approve', requireAdminLogin, (req, res) => {
  const { notes = '' } = req.body;
  const adminName = (req.session.adminUser && req.session.adminUser.name) || 'admin';

  try {
    const deposit = approveDeposit(req.params.id, adminName, notes);
    req.session.flash = {
      type: 'success',
      message: `Deposit #${deposit.deposit_code} sebesar ${formatRupiah(deposit.amount)} telah disetujui.`
    };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }

  res.redirect('/admin/deposits');
});

// POST /admin/deposits/:id/reject
router.post('/deposits/:id/reject', requireAdminLogin, (req, res) => {
  const { notes = 'Bukti transfer tidak valid' } = req.body;
  const adminName = (req.session.adminUser && req.session.adminUser.name) || 'admin';

  try {
    const deposit = rejectDeposit(req.params.id, adminName, notes);
    req.session.flash = {
      type: 'warning',
      message: `Deposit #${deposit.deposit_code} telah ditolak.`
    };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }

  res.redirect('/admin/deposits');
});

// POST /admin/bank-accounts
router.post('/bank-accounts', requireAdminLogin, (req, res) => {
  const { bank_name, account_number, account_name, qris_image } = req.body;
  try {
    addBankAccount({ bank_name, account_number, account_name, qris_image });
    req.session.flash = { type: 'success', message: 'Rekening baru berhasil ditambahkan.' };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin/deposits');
});

// POST /admin/bank-accounts/:id/toggle
router.post('/bank-accounts/:id/toggle', requireAdminLogin, (req, res) => {
  try {
    toggleBankAccount(req.params.id);
    req.session.flash = { type: 'success', message: 'Status rekening berhasil diubah.' };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin/deposits');
});

// POST /admin/bank-accounts/:id/delete
router.post('/bank-accounts/:id/delete', requireAdminLogin, (req, res) => {
  try {
    deleteBankAccount(req.params.id);
    req.session.flash = { type: 'success', message: 'Rekening berhasil dihapus.' };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin/deposits');
});

module.exports = router;
