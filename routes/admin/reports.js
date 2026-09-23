/**
 * Juragan Pulsa - Admin Reports Router
 * routes/admin/reports.js
 */

const express = require('express');
const router = express.Router();
const {
  getSummaryReport,
  getCategoryReport,
  getAgentReport,
  exportTransactionsCSV
} = require('../../services/reportService');
const { getAllAgents } = require('../../services/agentService');
const { listCategories } = require('../../services/productService');
const { requireAdminLogin } = require('../../middleware/adminAuth');
const { formatRupiah, formatDateTime } = require('../../utils/helpers');

// GET /admin/reports
router.get('/reports', requireAdminLogin, (req, res) => {
  const { date_from = '', date_to = '', agent_id = '', category = '', page = 1 } = req.query;

  const summary = getSummaryReport({
    dateFrom: date_from,
    dateTo: date_to,
    agentId: agent_id,
    category,
  });

  const categoryReport = getCategoryReport({
    dateFrom: date_from,
    dateTo: date_to,
  });

  const agentReport = getAgentReport({
    dateFrom: date_from,
    dateTo: date_to,
    page: parseInt(page, 10) || 1,
    limit: 10,
  });

  const agentsList = getAllAgents({ limit: 100 }).agents;
  const categoriesList = listCategories();

  res.render('admin/reports', {
    title: 'Laporan & Keuangan',
    activeNav: 'reports',
    summary,
    categoryReport,
    agentReport: agentReport.agents,
    pagination: agentReport.pagination,
    agentsList,
    categoriesList,
    filter: { date_from, date_to, agent_id, category },
    formatRupiah,
    formatDateTime,
  });
});

// GET /admin/reports/export/csv
router.get('/reports/export/csv', requireAdminLogin, (req, res) => {
  const { date_from = '', date_to = '', agent_id = '', status = '' } = req.query;

  try {
    const csvData = exportTransactionsCSV({
      dateFrom: date_from,
      dateTo: date_to,
      agentId: agent_id,
      status,
    });

    const filename = `transaksi-${date_from || 'all'}-sd-${date_to || 'all'}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csvData);
  } catch (err) {
    req.session.flash = { type: 'error', message: `Gagal export CSV: ${err.message}` };
    res.redirect('/admin/reports');
  }
});

module.exports = router;
