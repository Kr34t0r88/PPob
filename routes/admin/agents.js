/**
 * Juragan Pulsa - Admin Agents Router
 * routes/admin/agents.js
 */

const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const {
  getAllAgents,
  getAgentById,
  getAgentByUsername,
  createAgent,
  updateAgent,
  toggleAgent,
  topupBalance,
  getBalanceMutations,
  getAgentTransactions
} = require('../../services/agentService');
const { requireAdminLogin } = require('../../middleware/adminAuth');
const { getSetting } = require('../../config/settingsManager');
const whatsappService = require('../../services/whatsappService');
const { formatRupiah, formatDateTime } = require('../../utils/helpers');
const logger = require('../../utils/logger');

const PER_PAGE = 20;

/**
 * Helper untuk mendapatkan URL dasar server (Public IP / Domain / Port)
 */
function resolveServerBaseUrl(req) {
  const configured = getSetting('app_url', '');
  if (configured && configured.trim()) {
    return configured.trim().replace(/\/+$/, '');
  }
  return `${req.protocol}://${req.get('host')}`.replace(/\/+$/, '');
}

/**
 * Helper untuk generate payload JSON pairing QR
 */
function generatePairingPayload(serverUrl, username, password = '') {
  const appName = getSetting('app_name', 'Juragan Pulsa');
  const payload = {
    app: appName,
    url: serverUrl,
    u: username,
    role: 'agent'
  };
  if (password) {
    payload.p = password;
  }
  return JSON.stringify(payload);
}

/**
 * Helper untuk generate wa.me share link
 */
function buildWhatsAppShareLink(phone, message) {
  const clean = whatsappService.normalizePhoneDigits(phone);
  if (!clean) return '';
  return `https://wa.me/${clean}?text=${encodeURIComponent(message)}`;
}

// GET /admin/agents — list agen
router.get('/agents', requireAdminLogin, async (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const search = req.query.search || '';
  const status = req.query.status || '';
  const serverUrl = resolveServerBaseUrl(req);
  const appName = getSetting('app_name', 'Juragan Pulsa');

  try {
    const result = getAllAgents({ page, limit: PER_PAGE, q: search, status });

    // Generate QR Pairing DataURL untuk setiap agen di halaman aktif
    const agentsWithQr = await Promise.all(result.agents.map(async (a) => {
      try {
        const payload = generatePairingPayload(serverUrl, a.username);
        const qrDataUrl = await QRCode.toDataURL(payload, { margin: 2, scale: 5 });
        const waText =
          `*📱 AKSES AKUN AGEN ${appName.toUpperCase()}*\n` +
          `• Server: ${serverUrl}\n` +
          `• Username: *${a.username}*\n` +
          `Buka aplikasi ${appName} dan scan QR Code atau login manual.`;
        const waShareLink = buildWhatsAppShareLink(a.phone, waText);
        return { ...a, qrDataUrl, waShareLink };
      } catch (_) {
        return { ...a, qrDataUrl: '', waShareLink: '' };
      }
    }));

    res.render('admin/agents', {
      title: 'Manajemen Agen',
      activeNav: 'agents',
      agents: agentsWithQr,
      total: result.pagination.total,
      page: result.pagination.page,
      totalPages: result.pagination.totalPages,
      search,
      status,
      serverUrl,
      appName,
      formatRupiah,
      formatDateTime,
    });
  } catch (err) {
    logger.error('[Admin Agents]', err);
    res.render('admin/agents', {
      title: 'Manajemen Agen',
      activeNav: 'agents',
      agents: [],
      total: 0,
      page: 1,
      totalPages: 0,
      search: '',
      status: '',
      serverUrl,
      appName,
      error: 'Gagal memuat data agen: ' + err.message,
      formatRupiah,
      formatDateTime,
    });
  }
});

// GET /admin/agents/new — form tambah agen
router.get('/agents/new', requireAdminLogin, (req, res) => {
  const serverUrl = resolveServerBaseUrl(req);
  res.render('admin/agent-form', {
    title: 'Tambah Agen Baru',
    activeNav: 'agents',
    agent: null,
    serverUrl,
    action: '/admin/agents/new',
    isEdit: false,
  });
});

// POST /admin/agents/new — simpan agen baru
router.post('/agents/new', requireAdminLogin, async (req, res) => {
  const serverUrl = resolveServerBaseUrl(req);
  const appName = getSetting('app_name', 'Juragan Pulsa');

  try {
    const { name, username, phone, email, password, initial_balance } = req.body;
    createAgent({
      name,
      username,
      phone,
      email,
      password,
      balance: parseFloat(initial_balance) || 0
    });

    const newAgent = getAgentByUsername(username);

    // Kirim notifikasi selamat datang & QR Pairing otomatis via Baileys jika terhubung
    let waSent = false;
    if (newAgent && phone) {
      try {
        waSent = await whatsappService.sendAgentWelcomeMessage({
          agent: newAgent,
          plainPassword: password,
          serverUrl
        });
      } catch (waErr) {
        logger.warn('[Admin Agents New] Gagal kirim WA otomatis: ' + waErr.message);
      }
    }

    // Simpan credential sementara di session untuk ditampilkan di modal sukses / halaman detail
    const pairingPayload = generatePairingPayload(serverUrl, username, password);
    const pairingQrDataUrl = await QRCode.toDataURL(pairingPayload, { margin: 2, scale: 6 });

    const waMsgText =
      `*🎉 SELAMAT DATANG DI ${appName.toUpperCase()}*\n` +
      `Halo *${name}*, Akun Agen Anda telah aktif!\n\n` +
      `📋 *Data Login:*\n` +
      `• Server: ${serverUrl}\n` +
      `• Username: *${username}*\n` +
      `• Password: *${password}*\n` +
      `• Saldo: ${formatRupiah(parseFloat(initial_balance) || 0)}\n\n` +
      `Silakan buka aplikasi ${appName} dan scan QR Code atau login manual.`;

    const waLink = buildWhatsAppShareLink(phone, waMsgText);

    req.session.newAgentPairing = {
      agentId: newAgent ? newAgent.id : null,
      username,
      plainPassword: password,
      serverUrl,
      pairingQrDataUrl,
      waLink,
      waSent
    };

    req.session.flash = {
      type: 'success',
      message: `Agen ${name} berhasil ditambahkan! ${waSent ? '✅ Notifikasi & QR Login telah dikirim ke WhatsApp agen.' : 'ℹ️ Silakan bagikan QR Pairing login ke agen.'}`
    };

    if (newAgent) {
      res.redirect(`/admin/agents/${newAgent.id}?new=1`);
    } else {
      res.redirect('/admin/agents');
    }
  } catch (err) {
    logger.error('[Admin Agents New]', err);
    res.render('admin/agent-form', {
      title: 'Tambah Agen Baru',
      activeNav: 'agents',
      agent: req.body,
      serverUrl,
      action: '/admin/agents/new',
      isEdit: false,
      error: err.message || 'Gagal menyimpan agen.',
    });
  }
});

// GET /admin/agents/:id — detail agen
router.get('/agents/:id', requireAdminLogin, async (req, res) => {
  try {
    const { id } = req.params;
    const agent = getAgentById(id);

    if (!agent) {
      req.session.flash = { type: 'error', message: 'Agen tidak ditemukan.' };
      return res.redirect('/admin/agents');
    }

    const serverUrl = resolveServerBaseUrl(req);
    const appName = getSetting('app_name', 'Juragan Pulsa');

    // Cek apakah ada data pairing agen baru yang baru saja dibuat
    let newPairing = null;
    if (req.session.newAgentPairing && req.session.newAgentPairing.agentId == id) {
      newPairing = req.session.newAgentPairing;
      // Jangan hapus langsung jika query param ?new=1 ada
      if (!req.query.new) {
        delete req.session.newAgentPairing;
      }
    }

    // Default QR pairing (URL + Username)
    const pairingPayload = generatePairingPayload(serverUrl, agent.username);
    const pairingQrDataUrl = await QRCode.toDataURL(pairingPayload, { margin: 2, scale: 6 });

    const waText =
      `*📱 DATA LOGIN AGEN ${appName.toUpperCase()}*\n` +
      `Yth. *${agent.name}* (@${agent.username}),\n\n` +
      `Berikut konfigurasi server untuk login di aplikasi Android:\n` +
      `• *Server URL:* ${serverUrl}\n` +
      `• *Username:* \`${agent.username}\`\n\n` +
      `Buka aplikasi ${appName} lalu pilih *Scan QR Code Akun* untuk masuk otomatis.`;

    const waShareLink = buildWhatsAppShareLink(agent.phone, waText);

    const transactions = getAgentTransactions(id, 20);
    const mutationsResult = getBalanceMutations(id, { page: 1, limit: 10 });

    res.render('admin/agent-detail', {
      title: `Detail Agen: ${agent.name}`,
      activeNav: 'agents',
      agent,
      serverUrl,
      appName,
      pairingQrDataUrl,
      waShareLink,
      newPairing,
      transactions,
      mutations: mutationsResult.mutations,
      formatRupiah,
      formatDateTime,
    });
  } catch (err) {
    logger.error('[Admin Agent Detail]', err);
    req.session.flash = { type: 'error', message: 'Gagal memuat detail agen.' };
    res.redirect('/admin/agents');
  }
});

// POST /admin/agents/:id/send-whatsapp-qr — Kirim QR Code Akun ke WhatsApp Agen
router.post('/agents/:id/send-whatsapp-qr', requireAdminLogin, async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;
    const agent = getAgentById(id);

    if (!agent) {
      req.session.flash = { type: 'error', message: 'Agen tidak ditemukan.' };
      return res.redirect('/admin/agents');
    }

    const serverUrl = resolveServerBaseUrl(req);
    const sent = await whatsappService.sendAgentWelcomeMessage({
      agent,
      plainPassword: password || '',
      serverUrl
    });

    if (sent) {
      req.session.flash = { type: 'success', message: `QR Code dan kredensial login berhasil dikirim ke WhatsApp ${agent.phone}.` };
    } else {
      req.session.flash = { type: 'warning', message: 'WhatsApp belum terhubung ke sistem. Gunakan tombol link wa.me untuk mengirim secara manual.' };
    }

    res.redirect(`/admin/agents/${id}`);
  } catch (err) {
    logger.error('[Admin Send WA QR]', err);
    req.session.flash = { type: 'error', message: 'Gagal kirim QR WhatsApp: ' + err.message };
    res.redirect(`/admin/agents/${req.params.id}`);
  }
});

// POST /admin/agents/:id/reset-password — Reset password agen + Kirim QR Baru
router.post('/agents/:id/reset-password', requireAdminLogin, async (req, res) => {
  try {
    const { id } = req.params;
    const { new_password, send_whatsapp } = req.body;
    const agent = getAgentById(id);

    if (!agent) {
      req.session.flash = { type: 'error', message: 'Agen tidak ditemukan.' };
      return res.redirect('/admin/agents');
    }

    if (!new_password || new_password.trim().length < 4) {
      throw new Error('Password baru minimal 4 karakter.');
    }

    updateAgent(id, { password: new_password.trim() });
    const serverUrl = resolveServerBaseUrl(req);

    let waSent = false;
    if (send_whatsapp === '1' && agent.phone) {
      waSent = await whatsappService.sendAgentWelcomeMessage({
        agent,
        plainPassword: new_password.trim(),
        serverUrl
      });
    }

    const pairingPayload = generatePairingPayload(serverUrl, agent.username, new_password.trim());
    const pairingQrDataUrl = await QRCode.toDataURL(pairingPayload, { margin: 2, scale: 6 });

    req.session.newAgentPairing = {
      agentId: agent.id,
      username: agent.username,
      plainPassword: new_password.trim(),
      serverUrl,
      pairingQrDataUrl,
      waLink: buildWhatsAppShareLink(agent.phone, `Password akun @${agent.username} telah direset ke: ${new_password.trim()}`),
      waSent
    };

    req.session.flash = {
      type: 'success',
      message: `Password agen ${agent.name} berhasil diubah! ${waSent ? 'Notifikasi telah dikirim ke WhatsApp.' : ''}`
    };

    res.redirect(`/admin/agents/${id}?new=1`);
  } catch (err) {
    logger.error('[Admin Reset Password]', err);
    req.session.flash = { type: 'error', message: err.message || 'Gagal mereset password.' };
    res.redirect(`/admin/agents/${req.params.id}`);
  }
});

// POST /admin/agents/:id/edit — update agen
router.post('/agents/:id/edit', requireAdminLogin, (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, email } = req.body;
    updateAgent(id, { name, phone, email });

    req.session.flash = { type: 'success', message: 'Data agen berhasil diperbarui.' };
    res.redirect(`/admin/agents/${id}`);
  } catch (err) {
    logger.error('[Admin Agent Edit]', err);
    req.session.flash = { type: 'error', message: err.message || 'Gagal memperbarui agen.' };
    res.redirect(`/admin/agents/${req.params.id}`);
  }
});

// POST /admin/agents/:id/topup — top-up saldo manual
router.post('/agents/:id/topup', requireAdminLogin, (req, res) => {
  try {
    const { id } = req.params;
    const { amount, note } = req.body;
    const adminUser = (req.session.adminUser && req.session.adminUser.name) || 'admin';

    if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
      throw new Error('Nominal topup tidak valid.');
    }

    topupBalance(id, parseFloat(amount), note || 'Topup manual admin', adminUser);

    req.session.flash = {
      type: 'success',
      message: `Topup ${formatRupiah(amount)} berhasil ditambahkan.`
    };
    res.redirect(`/admin/agents/${id}`);
  } catch (err) {
    logger.error('[Admin Agent Topup]', err);
    req.session.flash = { type: 'error', message: err.message || 'Gagal melakukan topup.' };
    res.redirect(`/admin/agents/${req.params.id}`);
  }
});

// POST /admin/agents/:id/toggle — aktif/nonaktif
router.post('/agents/:id/toggle', requireAdminLogin, (req, res) => {
  try {
    const { id } = req.params;
    toggleAgent(id);

    req.session.flash = { type: 'success', message: 'Status agen berhasil diubah.' };
    res.redirect(req.headers.referer || '/admin/agents');
  } catch (err) {
    logger.error('[Admin Agent Toggle]', err);
    req.session.flash = { type: 'error', message: err.message || 'Gagal mengubah status agen.' };
    res.redirect(req.headers.referer || '/admin/agents');
  }
});

// GET /admin/agents/:id/mutations — riwayat mutasi saldo
router.get('/agents/:id/mutations', requireAdminLogin, (req, res) => {
  try {
    const { id } = req.params;
    const page = parseInt(req.query.page, 10) || 1;
    const agent = getAgentById(id);

    if (!agent) {
      req.session.flash = { type: 'error', message: 'Agen tidak ditemukan.' };
      return res.redirect('/admin/agents');
    }

    const result = getBalanceMutations(id, { page, limit: PER_PAGE });

    res.render('admin/agent-mutations', {
      title: `Mutasi Saldo: ${agent.name}`,
      activeNav: 'agents',
      agent,
      mutations: result.mutations,
      total: result.pagination.total,
      page: result.pagination.page,
      totalPages: result.pagination.totalPages,
      formatRupiah,
      formatDateTime,
    });
  } catch (err) {
    logger.error('[Admin Agent Mutations]', err);
    req.session.flash = { type: 'error', message: 'Gagal memuat riwayat mutasi.' };
    res.redirect(`/admin/agents/${req.params.id}`);
  }
});

module.exports = router;
