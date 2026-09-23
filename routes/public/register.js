/**
 * Juragan Pulsa - Public Agent Registration Router
 * routes/public/register.js
 */

'use strict';

const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const db = require('../../config/database');
const { getSetting } = require('../../config/settingsManager');
const { createAgent, getAgentByUsername } = require('../../services/agentService');
const whatsappService = require('../../services/whatsappService');
const telegramService = require('../../services/telegramService');
const { formatRupiah, formatDateTime, formatWaNumber } = require('../../utils/helpers');
const logger = require('../../utils/logger');

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
 * Helper untuk normalisasi nomor telepon
 */
function cleanPhoneNumber(phone) {
  if (!phone) return '';
  let digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('62')) digits = '0' + digits.slice(2);
  else if (digits.startsWith('8')) digits = '08' + digits.slice(1);
  return digits;
}

/**
 * GET /register & GET /daftar — Halaman Formulir Pendaftaran Agen
 */
router.get(['/register', '/daftar'], (req, res) => {
  const isRegEnabled = getSetting('public_agent_registration_enabled', '1') === '1' || getSetting('public_agent_registration_enabled', true) === true;
  const appName = getSetting('app_name', 'Juragan Pulsa');
  const storeName = getSetting('public_store_name', appName);
  const csWhatsapp = getSetting('public_cs_whatsapp', getSetting('app_phone', '081947215703'));
  const appDownloadUrl = getSetting('app_download_url', '/downloads/juragan-pulsa.apk');
  const logo = getSetting('public_store_logo', '');

  res.render('public/register', {
    title: `Daftar Jadi Agen Mitra - ${storeName}`,
    appName,
    storeName,
    csWhatsapp,
    appDownloadUrl,
    logo,
    isRegEnabled,
    error: req.query.error || null,
    formData: {}
  });
});

/**
 * POST /register & POST /daftar — Proses Pendaftaran Agen Mandiri
 */
router.post(['/register', '/daftar'], async (req, res) => {
  const isRegEnabled = getSetting('public_agent_registration_enabled', '1') === '1' || getSetting('public_agent_registration_enabled', true) === true;
  const appName = getSetting('app_name', 'Juragan Pulsa');
  const storeName = getSetting('public_store_name', appName);
  const csWhatsapp = getSetting('public_cs_whatsapp', getSetting('app_phone', '081947215703'));
  const appDownloadUrl = getSetting('app_download_url', '/downloads/juragan-pulsa.apk');
  const logo = getSetting('public_store_logo', '');
  const serverUrl = resolveServerBaseUrl(req);

  if (!isRegEnabled) {
    return res.status(403).render('public/register', {
      title: `Pendaftaran Ditutup - ${storeName}`,
      appName,
      storeName,
      csWhatsapp,
      appDownloadUrl,
      logo,
      isRegEnabled: false,
      error: 'Mohon maaf, pendaftaran agen mandiri saat ini sedang ditutup. Silakan hubungi Customer Service untuk pendaftaran manual.',
      formData: req.body || {}
    });
  }

  const { name, phone, username, password, address } = req.body;
  const cleanName = String(name || '').trim();
  const rawPhone = String(phone || '').trim();
  const cleanPhone = cleanPhoneNumber(rawPhone);
  const cleanUsername = String(username || '').trim().toLowerCase();
  const cleanPassword = String(password || '').trim();
  const cleanAddress = String(address || '').trim();

  // Validasi Input
  if (!cleanName || cleanName.length < 3) {
    return res.render('public/register', {
      title: `Daftar Jadi Agen Mitra - ${storeName}`,
      appName,
      storeName,
      csWhatsapp,
      appDownloadUrl,
      logo,
      isRegEnabled: true,
      error: 'Nama lengkap / nama konter minimal 3 karakter.',
      formData: req.body
    });
  }

  if (!cleanPhone || cleanPhone.length < 10 || cleanPhone.length > 15) {
    return res.render('public/register', {
      title: `Daftar Jadi Agen Mitra - ${storeName}`,
      appName,
      storeName,
      csWhatsapp,
      appDownloadUrl,
      logo,
      isRegEnabled: true,
      error: 'Nomor WhatsApp tidak valid (minimal 10 digit, contoh: 08123456789).',
      formData: req.body
    });
  }

  if (!cleanUsername || !/^[a-z0-9_]{3,20}$/.test(cleanUsername)) {
    return res.render('public/register', {
      title: `Daftar Jadi Agen Mitra - ${storeName}`,
      appName,
      storeName,
      csWhatsapp,
      appDownloadUrl,
      logo,
      isRegEnabled: true,
      error: 'Username hanya boleh huruf kecil, angka, garis bawah (3-20 karakter tanpa spasi).',
      formData: req.body
    });
  }

  if (!cleanPassword || cleanPassword.length < 4) {
    return res.render('public/register', {
      title: `Daftar Jadi Agen Mitra - ${storeName}`,
      appName,
      storeName,
      csWhatsapp,
      appDownloadUrl,
      logo,
      isRegEnabled: true,
      error: 'Password / PIN minimal 4 karakter.',
      formData: req.body
    });
  }

  try {
    // Periksa keunikan username
    const existingUser = getAgentByUsername(cleanUsername);
    if (existingUser) {
      return res.render('public/register', {
        title: `Daftar Jadi Agen Mitra - ${storeName}`,
        appName,
        storeName,
        csWhatsapp,
        appDownloadUrl,
        logo,
        isRegEnabled: true,
        error: `Username "${cleanUsername}" sudah digunakan oleh orang lain. Silakan pilih username yang berbeda.`,
        formData: req.body
      });
    }

    // Periksa keunikan nomor HP
    const existingPhone = db.prepare('SELECT id, username FROM agents WHERE phone = ? LIMIT 1').get(cleanPhone);
    if (existingPhone) {
      return res.render('public/register', {
        title: `Daftar Jadi Agen Mitra - ${storeName}`,
        appName,
        storeName,
        csWhatsapp,
        appDownloadUrl,
        logo,
        isRegEnabled: true,
        error: `Nomor WhatsApp ${cleanPhone} sudah terdaftar dengan username "${existingPhone.username}". Silakan gunakan nomor lain atau hubungi CS jika lupa password.`,
        formData: req.body
      });
    }

    // 1. Buat Akun Agen Baru di Database
    createAgent({
      name: cleanName,
      username: cleanUsername,
      phone: cleanPhone,
      email: '',
      password: cleanPassword,
      address: cleanAddress,
      balance: 0,
      markup_group: 'default',
      pin: cleanPassword.length <= 6 && /^\d+$/.test(cleanPassword) ? cleanPassword : '1234'
    });

    const newAgent = getAgentByUsername(cleanUsername);

    // 2. Buat QR Code Pairing Login untuk APK Android
    const pairingPayload = generatePairingPayload(serverUrl, cleanUsername, cleanPassword);
    const qrDataUrl = await QRCode.toDataURL(pairingPayload, {
      margin: 2,
      scale: 7,
      color: {
        dark: '#0284c7',
        light: '#ffffff'
      }
    });

    // 3. Kirim Notifikasi WhatsApp Otomatis ke Agen (jika Baileys terhubung)
    let waSent = false;
    if (newAgent) {
      try {
        waSent = await whatsappService.sendAgentWelcomeMessage({
          agent: newAgent,
          plainPassword: cleanPassword,
          serverUrl
        });
      } catch (waErr) {
        logger.warn(`[Public Register] Gagal kirim WA sambutan ke ${cleanPhone}: ${waErr.message}`);
      }
    }

    // 4. Kirim Notifikasi Telegram ke Admin/CS
    try {
      const { chatId } = telegramService.getCredentials();
      if (chatId) {
        const teleMsg =
          `🎉 <b>[PENDAFTARAN AGEN BARU]</b>\n` +
          `────────────────────────────\n` +
          `• <b>Nama:</b> ${telegramService.escapeHtml(cleanName)}\n` +
          `• <b>Username:</b> <code>${cleanUsername}</code>\n` +
          `• <b>WhatsApp:</b> <code>${cleanPhone}</code>\n` +
          `• <b>Domisili:</b> ${telegramService.escapeHtml(cleanAddress || '-')}\n` +
          `• <b>Status:</b> 🟢 Aktif (Saldo: Rp 0)\n` +
          `• <b>Waktu:</b> ${new Date().toLocaleString('id-ID')}\n` +
          `────────────────────────────\n` +
          `<i>Akun otomatis dibuat dan QR Code Login telah diserahkan ke agen.</i>`;
        await telegramService.sendMessage(chatId, teleMsg);
      }
    } catch (teleErr) {
      logger.warn(`[Public Register] Gagal kirim notif Telegram ke Admin: ${teleErr.message}`);
    }

    // 5. Tampilkan Halaman Bukti Pendaftaran & QR Code Login
    res.render('public/register_success', {
      title: `Pendaftaran Berhasil - ${storeName}`,
      appName,
      storeName,
      csWhatsapp,
      appDownloadUrl,
      logo,
      serverUrl,
      agent: {
        id: newAgent ? newAgent.id : null,
        name: cleanName,
        username: cleanUsername,
        phone: cleanPhone,
        address: cleanAddress,
        password: cleanPassword
      },
      qrDataUrl,
      waSent,
      formatRupiah
    });

  } catch (err) {
    logger.error('[Public Register Error]', err);
    res.render('public/register', {
      title: `Daftar Jadi Agen Mitra - ${storeName}`,
      appName,
      storeName,
      csWhatsapp,
      appDownloadUrl,
      logo,
      isRegEnabled: true,
      error: 'Terjadi kesalahan sistem saat memproses pendaftaran. Silakan coba lagi atau hubungi CS: ' + err.message,
      formData: req.body
    });
  }
});

module.exports = router;
