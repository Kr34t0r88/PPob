/**
 * Juragan Pulsa - Admin REST API Router for Android APK
 * routes/api/admin.js
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const { requireAdminApiToken } = require('../../middleware/apiAuth');
const {
  getDashboardStats,
  getRecentTransactions,
  getRecentDeposits,
  updateAdminPassword
} = require('../../services/adminService');

const {
  getAllAgents,
  getAgentById,
  createAgent,
  updateAgent,
  toggleAgent,
  topupBalance
} = require('../../services/agentService');

const {
  getAllDeposits,
  approveDeposit,
  rejectDeposit
} = require('../../services/depositService');

const {
  listProducts,
  syncProductsFromProvider,
  setMarkup,
  toggleProduct,
  listCategories,
  listBrands
} = require('../../services/productService');

const {
  getAllSettings,
  setSetting,
  getSetting
} = require('../../config/settingsManager');

const {
  getAdapter,
  getActiveProviders,
  getProviderById,
  updateProviderBalance
} = require('../../services/providers/providerFactory');

const whatsappService = require('../../services/whatsappService');
const qrisUtil = require('../../utils/qrisUtil');
const logger = require('../../utils/logger');

// Setup multer for QRIS upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', '..', 'public', 'uploads', 'qris');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `qris_admin_${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Hanya file gambar (.jpg, .jpeg, .png, .webp) yang diizinkan'));
    }
  }
});

// Protect all admin endpoints with requireAdminApiToken
router.use(requireAdminApiToken);

// ─────────────────────────────────────────────────────────────────────────────
// 1. DASHBOARD & RINGKASAN
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/admin/dashboard
router.get('/dashboard', async (req, res) => {
  try {
    const stats = await getDashboardStats();
    const recentTransactions = getRecentTransactions(10);
    const recentDeposits = getRecentDeposits(5);

    return res.json({
      success: true,
      data: {
        stats,
        recent_transactions: recentTransactions,
        recent_deposits: recentDeposits
      }
    });
  } catch (err) {
    logger.error('[API Admin] Error get dashboard:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. MITRA AGEN
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/admin/agents
router.get('/agents', (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 50;
    const q = (req.query.q || '').trim();
    const status = (req.query.status || '').trim();

    const result = getAllAgents({ page, limit, q, status });
    return res.json({
      success: true,
      data: result.agents,
      pagination: result.pagination
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/agents/new
router.post('/agents/new', (req, res) => {
  try {
    const { name, username, phone, email, password, markup_group, balance } = req.body;
    if (!name || !username || !phone || !password) {
      return res.status(400).json({ success: false, error: 'Nama, username, nomor HP, dan password wajib diisi' });
    }

    const agent = createAgent({
      name,
      username,
      phone,
      email: email || '',
      password,
      markup_group: markup_group || 'default',
      balance: parseFloat(balance) || 0
    });

    // Otomatis kirim welcome WhatsApp jika bot aktif
    try {
      if (whatsappService && typeof whatsappService.sendAgentWelcomeMessage === 'function') {
        const serverUrl = req.body.server_url || getSetting('app_url', 'http://' + req.headers.host);
        whatsappService.sendAgentWelcomeMessage(agent, password, serverUrl).catch(e => {
          logger.warn('[API Admin] WA Welcome notification failed:', e.message);
        });
      }
    } catch (_) {}

    return res.json({
      success: true,
      message: 'Agen berhasil didaftarkan',
      agent
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/admin/agents/:id/topup
router.post('/agents/:id/topup', (req, res) => {
  try {
    const agentId = parseInt(req.params.id, 10);
    const amount = parseFloat(req.body.amount) || 0;
    const notes = req.body.notes || 'Top Up Manual oleh Admin';

    if (amount <= 0) {
      return res.status(400).json({ success: false, error: 'Nominal top up harus lebih dari 0' });
    }

    const mutation = topupBalance(agentId, amount, notes, req.admin.username);
    const agent = getAgentById(agentId);

    return res.json({
      success: true,
      message: `Berhasil menambahkan saldo Rp ${amount.toLocaleString('id-ID')}`,
      balance: agent ? agent.balance : 0,
      mutation
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/admin/agents/:id/toggle
router.post('/agents/:id/toggle', (req, res) => {
  try {
    const agentId = parseInt(req.params.id, 10);
    const agent = toggleAgent(agentId);
    return res.json({
      success: true,
      message: `Status agen berhasil diubah menjadi ${agent.is_active ? 'Aktif' : 'Nonaktif'}`,
      is_active: agent.is_active
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/admin/agents/:id/send-pairing
router.post('/agents/:id/send-pairing', async (req, res) => {
  try {
    const agentId = parseInt(req.params.id, 10);
    const agent = getAgentById(agentId);
    if (!agent) return res.status(404).json({ success: false, error: 'Agen tidak ditemukan' });

    const serverUrl = req.body.server_url || getSetting('app_url', 'http://' + req.headers.host);
    const customPassword = req.body.password || '';

    if (whatsappService && typeof whatsappService.sendAgentWelcomeMessage === 'function') {
      const result = await whatsappService.sendAgentWelcomeMessage(agent, customPassword, serverUrl);
      return res.json({
        success: true,
        message: 'QR Code & Kredensial pairing berhasil dikirim ke WhatsApp agen',
        result
      });
    } else {
      return res.status(503).json({ success: false, error: 'Layanan WhatsApp belum aktif' });
    }
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. DEPOSIT & TIKET
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/admin/deposits
router.get('/deposits', (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 50;
    const status = (req.query.status || '').trim();
    const q = (req.query.q || '').trim();

    const result = getAllDeposits({ status, q, page, limit });
    return res.json({
      success: true,
      data: result.deposits,
      pagination: result.pagination
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/deposits/:id/approve
router.post('/deposits/:id/approve', (req, res) => {
  try {
    const depositId = parseInt(req.params.id, 10);
    const notes = req.body.notes || '';
    const updated = approveDeposit(depositId, req.admin.username, notes);

    // Kirim notifikasi WA ke agen
    try {
      const agent = getAgentById(updated.agent_id);
      if (agent && whatsappService && typeof whatsappService.notifyDepositApproved === 'function') {
        whatsappService.notifyDepositApproved(agent, updated).catch(e => {
          logger.warn('[API Admin] WA deposit approved notif error:', e.message);
        });
      }
    } catch (_) {}

    return res.json({
      success: true,
      message: 'Deposit berhasil disetujui & saldo telah ditambahkan',
      deposit: updated
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/admin/deposits/:id/reject
router.post('/deposits/:id/reject', (req, res) => {
  try {
    const depositId = parseInt(req.params.id, 10);
    const notes = req.body.notes || 'Ditolak oleh admin';
    const updated = rejectDeposit(depositId, req.admin.username, notes);

    return res.json({
      success: true,
      message: 'Deposit berhasil ditolak',
      deposit: updated
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. PRODUK & DIGIFLAZZ H2H
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/admin/products
router.get('/products', (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 50;
    const category = req.query.category || '';
    const brand = req.query.brand || '';
    const q = req.query.q || '';
    const includeInactive = req.query.include_inactive !== '0';

    const result = listProducts({ q, category, brand, includeInactive, page, limit });
    return res.json({
      success: true,
      data: result.products,
      pagination: result.pagination
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/products/sync
router.post('/products/sync', async (req, res) => {
  try {
    const providerId = req.body.provider_id || 1;
    const result = await syncProductsFromProvider(providerId);

    return res.json({
      success: true,
      message: `Sync selesai: ${result.total} produk diperiksa (${result.inserted} baru, ${result.updated} diperbarui)`,
      result
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Gagal sync produk: ' + err.message });
  }
});

// POST /api/admin/products/:sku/markup
router.post('/products/:sku/markup', (req, res) => {
  try {
    const sku = req.params.sku;
    const markup = parseInt(req.body.markup, 10);

    if (isNaN(markup) || markup < 0) {
      return res.status(400).json({ success: false, error: 'Markup harus berupa angka positif' });
    }

    const updated = setMarkup(sku, markup);
    return res.json({
      success: true,
      message: `Markup SKU ${sku} berhasil diubah menjadi Rp ${markup.toLocaleString('id-ID')}`,
      product: updated
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/admin/products/:sku/toggle
router.post('/products/:sku/toggle', (req, res) => {
  try {
    const sku = req.params.sku;
    const isActive = req.body.is_active !== undefined ? (req.body.is_active ? 1 : 0) : undefined;
    const updated = toggleProduct(sku, isActive);

    return res.json({
      success: true,
      message: `Produk ${sku} berhasil di-${updated.is_active ? 'aktifkan' : 'nonaktifkan'}`,
      product: updated
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. SETTINGS & PENGATURAN SISTEM
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/admin/settings
router.get('/settings', (req, res) => {
  try {
    const settings = getAllSettings();
    const providers = getActiveProviders();

    return res.json({
      success: true,
      settings,
      providers
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/settings
router.post('/settings', (req, res) => {
  try {
    const updates = req.body;
    for (const [key, value] of Object.entries(updates)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        setSetting(key, String(value));
      }
    }

    return res.json({
      success: true,
      message: 'Pengaturan berhasil disimpan',
      settings: getAllSettings()
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/settings/password
router.post('/settings/password', (req, res) => {
  try {
    const { old_password, new_password } = req.body;
    if (!old_password || !new_password) {
      return res.status(400).json({ success: false, error: 'Password lama dan baru wajib diisi' });
    }

    updateAdminPassword(req.admin.id, old_password, new_password);
    return res.json({ success: true, message: 'Password admin berhasil diubah' });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. WHATSAPP BOT MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/admin/whatsapp/status
router.get('/whatsapp/status', (req, res) => {
  try {
    const status = whatsappService ? whatsappService.getConnectionStatus() : { connection: 'disabled' };
    return res.json({
      success: true,
      status: status.connection,
      isConnected: status.connection === 'open',
      qr: status.qr,
      qrImage: status.qrImage,
      user: status.user,
      lastUpdate: status.lastUpdate
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/whatsapp/start
router.post('/whatsapp/start', async (req, res) => {
  try {
    if (!whatsappService) {
      return res.status(503).json({ success: false, error: 'WhatsApp service tidak tersedia' });
    }

    setSetting('whatsapp_enabled', '1');
    whatsappService.startBot().catch(e => logger.warn('[API Admin] WA start err:', e.message));

    return res.json({
      success: true,
      message: 'Inisialisasi bot WhatsApp sedang berjalan...'
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/whatsapp/test
router.post('/whatsapp/test', async (req, res) => {
  try {
    const { target, message } = req.body;
    if (!target) {
      return res.status(400).json({ success: false, error: 'Nomor tujuan WhatsApp wajib diisi' });
    }

    const testMsg = message || `Halo! Ini adalah pesan uji coba dari *${getSetting('app_name', 'Juragan Pulsa')}* 🚀\nSistem WhatsApp Gateway berjalan dengan baik.`;

    if (!whatsappService) {
      return res.status(503).json({ success: false, error: 'WhatsApp service tidak tersedia' });
    }

    const result = await whatsappService.sendWhatsAppMessage(target, testMsg);
    return res.json({
      success: true,
      message: `Pesan uji coba berhasil dikirim ke ${target}`,
      result
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/whatsapp/reset
router.post('/whatsapp/reset', async (req, res) => {
  try {
    if (!whatsappService) {
      return res.status(503).json({ success: false, error: 'WhatsApp service tidak tersedia' });
    }

    await whatsappService.resetSession();
    return res.json({
      success: true,
      message: 'Sesi WhatsApp berhasil direset. Silakan scan QR ulang.'
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. PROVIDER DIGIFLAZZ LIVE BALANCE
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/admin/providers/:id/check-balance
router.post('/providers/:id/check-balance', async (req, res) => {
  try {
    const providerId = parseInt(req.params.id, 10);
    const prov = getProviderById(providerId);
    if (!prov) return res.status(404).json({ success: false, error: 'Provider tidak ditemukan' });

    const adapter = getAdapter(prov.name);
    const bal = await adapter.checkBalance(prov);
    updateProviderBalance(prov.id, bal.deposit);

    return res.json({
      success: true,
      message: `Saldo ${prov.label} saat ini: Rp ${bal.deposit.toLocaleString('id-ID')}`,
      balance: bal.deposit,
      raw: bal
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. QRIS STATIC IMAGE UPLOAD & PARSING
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/admin/qris/upload
router.post('/qris/upload', upload.single('qris_image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'File gambar QRIS wajib diunggah' });
    }

    const filePath = req.file.path;
    const fileUrl = `/uploads/qris/${path.basename(filePath)}`;

    // Decode QR Code from image if possible
    let decodedPayload = '';
    try {
      decodedPayload = await qrisUtil.decodeQrisImage(filePath);
      if (decodedPayload) {
        setSetting('qris_static_payload', decodedPayload);
        setSetting('qris_static_enabled', '1');
      }
    } catch (e) {
      logger.warn('[API Admin] Gagal decode QRIS string dari image:', e.message);
    }

    return res.json({
      success: true,
      message: decodedPayload ? 'Gambar QRIS berhasil diunggah dan payload terbaca otomatis!' : 'Gambar QRIS berhasil diunggah',
      file_url: fileUrl,
      payload: decodedPayload
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
