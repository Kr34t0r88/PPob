/**
 * Juragan Pulsa - Agent REST API Transactions Router
 * routes/api/transactions.js
 */

const express = require('express');
const router = express.Router();
const {
  createTransaction,
  listTransactions,
  getTransactionById,
  checkTransactionStatus
} = require('../../services/transactionService');
const { requireApiToken } = require('../../middleware/apiAuth');
const { apiLimiter } = require('../../middleware/rateLimit');

// POST /api/transactions (Beli pulsa / paket data / PPOB)
router.post('/', requireApiToken, apiLimiter, async (req, res) => {
  const { sku, target } = req.body;

  if (!sku || !target) {
    return res.status(400).json({ success: false, error: 'SKU produk dan nomor tujuan wajib diisi' });
  }

  try {
    const result = await createTransaction(req.agent.id, {
      sku: String(sku).trim(),
      target: String(target).trim(),
      channel: 'app'
    });

    return res.status(201).json({
      success: true,
      message: result.transaction.status === 'success'
        ? 'Transaksi berhasil diproses'
        : result.transaction.status === 'pending'
          ? 'Transaksi sedang dalam antrean proses'
          : 'Transaksi gagal diproses oleh vendor',
      transaction: {
        id: result.transaction.id,
        ref_id: result.transaction.ref_id,
        product_name: result.transaction.product_name,
        target: result.transaction.target,
        price: result.transaction.price_sell,
        status: result.transaction.status,
        sn: result.transaction.sn,
        message: result.transaction.message,
        created_at: result.transaction.created_at,
      },
      balance_after: result.balanceAfter,
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// GET /api/transactions (Riwayat transaksi agen)
router.get('/', requireApiToken, (req, res) => {
  const { page = 1, limit = 20, status = '', category = '', date_from = '', date_to = '' } = req.query;

  try {
    const result = listTransactions({
      agentId: req.agent.id,
      status,
      category,
      dateFrom: date_from,
      dateTo: date_to,
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || 20,
    });

    const formatted = result.transactions.map(t => ({
      id: t.id,
      ref_id: t.ref_id,
      product_name: t.product_name,
      category: t.category,
      brand: t.brand,
      target: t.target,
      price: t.price_sell,
      status: t.status,
      sn: t.sn,
      message: t.message,
      created_at: t.created_at,
      updated_at: t.updated_at,
    }));

    return res.json({
      success: true,
      data: formatted,
      pagination: result.pagination,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/transactions/:id (Detail transaksi)
router.get('/:id', requireApiToken, (req, res) => {
  try {
    const tx = getTransactionById(req.params.id);
    if (!tx || tx.agent_id !== req.agent.id) {
      return res.status(404).json({ success: false, error: 'Transaksi tidak ditemukan' });
    }

    return res.json({
      success: true,
      data: {
        id: tx.id,
        ref_id: tx.ref_id,
        product_name: tx.product_name,
        category: tx.category,
        brand: tx.brand,
        target: tx.target,
        price: tx.price_sell,
        status: tx.status,
        sn: tx.sn,
        message: tx.message,
        created_at: tx.created_at,
        updated_at: tx.updated_at,
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/transactions/:id/recheck (Cek ulang transaksi pending)
router.post('/:id/recheck', requireApiToken, async (req, res) => {
  try {
    const tx = await checkTransactionStatus(req.params.id, req.agent.id);
    return res.json({
      success: true,
      data: {
        id: tx.id,
        ref_id: tx.ref_id,
        status: tx.status,
        sn: tx.sn,
        message: tx.message,
        updated_at: tx.updated_at,
      }
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
