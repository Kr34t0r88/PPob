/**
 * Juragan Pulsa - Agent REST API Balance & Deposit Router
 * routes/api/balance.js
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const { getAgentById, getBalanceMutations } = require('../../services/agentService');
const { createDepositRequest, getDepositQris, getDepositsByAgent, getBankAccounts } = require('../../services/depositService');
const { requireApiToken } = require('../../middleware/apiAuth');

// Setup multer for deposit proof upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '..', '..', 'public', 'uploads', 'deposits'));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const filename = `proof-${req.agent.id}-${Date.now()}${ext}`;
    cb(null, filename);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Hanya file gambar (JPG, PNG, WebP) yang diperbolehkan'));
  }
});

// GET /api/balance (Cek saldo agen)
router.get('/', requireApiToken, (req, res) => {
  const agent = getAgentById(req.agent.id);
  if (!agent) return res.status(404).json({ success: false, error: 'Agen tidak ditemukan' });

  return res.json({
    success: true,
    data: {
      balance: agent.balance,
      agent_id: agent.id,
      agent_name: agent.name,
    }
  });
});

// GET /api/balance/mutations (Riwayat mutasi saldo)
router.get('/mutations', requireApiToken, (req, res) => {
  const { page = 1, limit = 20 } = req.query;

  try {
    const result = getBalanceMutations(req.agent.id, {
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || 20,
    });

    return res.json({
      success: true,
      data: result.mutations,
      pagination: result.pagination,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/balance/deposit (Buat permohonan deposit + upload bukti)
router.post('/deposit', requireApiToken, (req, res) => {
  upload.single('proof_image')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ success: false, error: err.message });
    }

    const { amount, bank_name = '', transfer_to = '', notes = '' } = req.body;
    const numAmount = parseFloat(amount);

    if (!numAmount || numAmount < 10000) {
      return res.status(400).json({ success: false, error: 'Nominal deposit minimal Rp 10.000' });
    }

    try {
      const proofImage = req.file ? `/uploads/deposits/${req.file.filename}` : '';
      const deposit = await createDepositRequest(req.agent.id, numAmount, {
        bankName: bank_name,
        transferTo: transfer_to,
        proofImage,
        notes,
      });

      const bankAccounts = getBankAccounts(true);

      return res.status(201).json({
        success: true,
        message: 'Tiket deposit berhasil dibuat. Silakan transfer sesuai nominal unik tepat atau scan QRIS.',
        data: {
          id: deposit.id,
          deposit_code: deposit.deposit_code,
          base_amount: deposit.base_amount,
          transfer_amount: deposit.amount,
          unique_code: deposit.unique_code,
          status: deposit.status,
          qr_string: deposit.qr_string || '',
          qr_image: deposit.qr_image || '',
          qr_url: deposit.qr_url || '',
          bank_accounts: bankAccounts,
          created_at: deposit.created_at,
        }
      });
    } catch (e) {
      return res.status(400).json({ success: false, error: e.message });
    }
  });
});

// GET /api/balance/deposit/qris/:depositCode (Stream image PNG Dynamic QRIS)
router.get('/deposit/qris/:depositCode', async (req, res) => {
  try {
    const { depositCode } = req.params;
    const { buffer } = await getDepositQris(depositCode);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(buffer);
  } catch (err) {
    return res.status(404).json({ success: false, error: err.message });
  }
});

// GET /api/balance/deposits (Riwayat tiket deposit agen)
router.get('/deposits', requireApiToken, (req, res) => {
  const { page = 1, limit = 10 } = req.query;

  try {
    const result = getDepositsByAgent(req.agent.id, {
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || 10,
    });

    return res.json({
      success: true,
      data: result.deposits,
      pagination: result.pagination,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/balance/bank-accounts (Daftar rekening tujuan transfer)
router.get('/bank-accounts', requireApiToken, (req, res) => {
  try {
    const accounts = getBankAccounts(true);
    return res.json({
      success: true,
      data: accounts,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
