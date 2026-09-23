'use strict';

const express = require('express');
const router = express.Router();
const { requireAdminLogin } = require('../../middleware/adminAuth');
const { formatRupiah, formatDateTime } = require('../../utils/helpers');

function getAdminService() {
  try {
    return require('../../services/adminService');
  } catch (e) {
    return null;
  }
}

// GET /admin/ — redirect ke dashboard
router.get('/', requireAdminLogin, (req, res) => {
  res.redirect('/admin/dashboard');
});

// GET /admin/dashboard
router.get('/dashboard', requireAdminLogin, async (req, res) => {
  try {
    const adminService = getAdminService();

    let stats = {
      totalAgentsActive: 0,
      transactionsToday: 0,
      revenueToday: 0,
      profitToday: 0,
      chart7Days: [],
    };
    let recentTransactions = [];
    let recentDeposits = [];
    let providerBalances = [];

    if (adminService) {
      if (typeof adminService.getDashboardStats === 'function') {
        stats = await adminService.getDashboardStats();
      }
      if (typeof adminService.getRecentTransactions === 'function') {
        recentTransactions = await adminService.getRecentTransactions(10);
      }
      if (typeof adminService.getRecentDeposits === 'function') {
        recentDeposits = await adminService.getRecentDeposits(5);
      }
      if (typeof adminService.getProviderBalances === 'function') {
        providerBalances = await adminService.getProviderBalances();
      }
    }

    res.render('admin/dashboard', {
      title: 'Dashboard',
      activeNav: 'dashboard',
      stats,
      recentTransactions,
      recentDeposits,
      providerBalances,
      formatRupiah,
      formatDateTime,
    });
  } catch (err) {
    console.error('[Admin Dashboard]', err);
    res.render('admin/dashboard', {
      title: 'Dashboard',
      activeNav: 'dashboard',
      stats: { totalAgentsActive: 0, transactionsToday: 0, revenueToday: 0, profitToday: 0, chart7Days: [] },
      recentTransactions: [],
      recentDeposits: [],
      providerBalances: [],
      error: 'Gagal memuat data dashboard: ' + err.message,
      formatRupiah,
      formatDateTime,
    });
  }
});

module.exports = router;
