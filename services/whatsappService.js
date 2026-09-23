/**
 * Juragan Pulsa - WhatsApp Baileys Interactive Bot & Notification Service
 * services/whatsappService.js
 * 
 * Implementasi Baileys WhatsApp Socket, Dynamic QR Code Pairing,
 * serta Bot Interaktif Transaksi Pulsa/PPOB/Deposit untuk Agen dan Admin.
 * Mengikuti pola arsitektur dari referensi D:\billing-rtrw-radius
 */

'use strict';

const path = require('path');
const fs = require('fs');
const pino = require('pino');
const QRCodeNode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.default || baileys;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = baileys;

const db = require('../config/database');
const logger = require('../utils/logger');
const { getSetting } = require('../config/settingsManager');
const { formatRupiah, formatDateTime, formatDate } = require('../utils/helpers');
const qrisUtil = require('../utils/qrisUtil');

const authDir = path.join(__dirname, '..', 'auth_info_baileys');
if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

// State status koneksi real-time
const whatsappStatus = {
  connection: 'close', // 'open' | 'qr' | 'connecting' | 'close' | 'loggedOut'
  qr: null,
  qrImage: null,
  user: null,
  lastUpdate: new Date().toISOString()
};

let currentSock = null;
let isStarting = false;

// Simple Cache Store untuk Baileys Retry & Keys
class BaileysCacheStore {
  constructor(ttlMs = 600000, maxSize = 3000) {
    this.cache = new Map();
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
  }
  get(key) {
    const item = this.cache.get(key);
    if (!item) return undefined;
    if (Date.now() - item.time > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }
    return item.val;
  }
  set(key, val) {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, { val, time: Date.now() });
  }
  del(key) {
    this.cache.delete(key);
  }
  flushAll() {
    this.cache.clear();
  }
}

const msgRetryCounterCache = new BaileysCacheStore(600000);
const userDevicesCache = new BaileysCacheStore(3600000);
const rateLimitMap = new Map(); // Anti-spam in-memory per phone

/**
 * Normalisasi nomor HP ke format digit standar Indonesia (628xxx)
 */
function normalizePhoneDigits(phone) {
  if (!phone) return '';
  let digits = String(phone).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) digits = '62' + digits.slice(1);
  else if (digits.startsWith('8')) digits = '62' + digits;
  else if (!digits.startsWith('62')) digits = '62' + digits;
  return digits;
}

/**
 * Ambil daftar nomor HP admin dari settings dan database
 */
function getAdminPhoneNumbers() {
  const list = [];
  const rawSetting = String(getSetting('whatsapp_admin_numbers', '') || '').trim();
  if (rawSetting) {
    rawSetting.split(',').forEach(s => {
      const d = normalizePhoneDigits(s);
      if (d && d.length >= 9) list.push(d);
    });
  }

  // Juga ambil dari no HP app_phone jika ada
  const appPhone = normalizePhoneDigits(getSetting('app_phone', ''));
  if (appPhone) list.push(appPhone);

  return Array.from(new Set(list));
}

/**
 * Cek apakah sebuah nomor HP merupakan Administrator
 */
function isAdminPhone(phoneDigits) {
  if (!phoneDigits) return false;
  const adminList = getAdminPhoneNumbers();
  return adminList.includes(phoneDigits);
}

/**
 * Cari agen berdasarkan nomor HP
 */
function findAgentByPhone(phoneDigits) {
  if (!phoneDigits) return null;
  const clean62 = phoneDigits;
  const clean08 = clean62.startsWith('62') ? '0' + clean62.slice(2) : clean62;
  const clean8 = clean62.startsWith('62') ? clean62.slice(2) : clean62;

  return db.prepare(`
    SELECT * FROM agents 
    WHERE is_active = 1 
      AND (
        phone = ? OR phone = ? OR phone = ? 
        OR phone LIKE ? OR phone LIKE ?
      )
    LIMIT 1
  `).get(clean62, clean08, clean8, `%${clean8}%`, `%${clean08}%`) || null;
}

/**
 * Kirim efek mengetik (typing indicator)
 */
async function simulateTyping(sock, jid, durationMs = 1200) {
  if (!sock || !jid) return;
  try {
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise(r => setTimeout(r, durationMs));
    await sock.sendPresenceUpdate('paused', jid);
  } catch (_) {}
}

/**
 * Inisialisasi & Hubungkan Socket WhatsApp Bot Baileys
 */
async function startBot() {
  if (isStarting) {
    logger.info('[WhatsApp] startBot sedang berjalan, melewati pemanggilan duplikat.');
    return currentSock;
  }

  isStarting = true;
  whatsappStatus.connection = 'connecting';
  whatsappStatus.lastUpdate = new Date().toISOString();

  try {
    // Tutup socket lama jika ada
    if (currentSock) {
      try {
        logger.info('[WhatsApp] Menutup socket lama sebelum inisialisasi ulang...');
        currentSock.ev.removeAllListeners();
        currentSock.end();
      } catch (e) {
        logger.warn('[WhatsApp] Gagal menutup socket lama: ' + e.message);
      }
      currentSock = null;
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    let version = [2, 3000, 1043857760]; // Fallback version
    try {
      const latest = await fetchLatestBaileysVersion();
      if (latest && latest.version) {
        version = latest.version;
      }
    } catch (err) {
      logger.warn(`[WhatsApp] Gagal fetch latest version Baileys: ${err.message}. Menggunakan fallback version.`);
    }

    const sock = makeWASocket({
      version,
      auth: state,
      browser: Browsers.ubuntu('Chrome'),
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: false,
      msgRetryCounterCache,
      userDevicesCache,
      retryRequestDelayMs: 250,
      maxMsgRetryCount: 5,
      keepAliveIntervalMs: 30000,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000
    });

    currentSock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      whatsappStatus.lastUpdate = new Date().toISOString();

      if (qr) {
        whatsappStatus.qr = qr;
        whatsappStatus.connection = 'qr';
        logger.info(`[WhatsApp] QR Code baru dihasilkan (${qr.slice(0, 25)}...)`);

        // Tampilkan di terminal
        try {
          qrcodeTerminal.generate(qr, { small: true });
        } catch (_) {}

        // Generate base64 Data URL untuk render langsung di frontend
        try {
          const url = await QRCodeNode.toDataURL(qr, { margin: 2, scale: 6 });
          whatsappStatus.qrImage = url;
        } catch (err) {
          logger.error('[WhatsApp] Gagal generate qrImage DataURL: ' + err.message);
          whatsappStatus.qrImage = null;
        }
      }

      if (connection === 'close') {
        whatsappStatus.qr = null;
        whatsappStatus.qrImage = null;
        whatsappStatus.user = null;

        const code = lastDisconnect?.error?.output?.statusCode;
        const errorMsg = lastDisconnect?.error?.message || '';
        const shouldReconnect = code !== DisconnectReason.loggedOut;

        whatsappStatus.connection = code === DisconnectReason.loggedOut ? 'loggedOut' : 'close';

        logger.warn(`[WhatsApp] Koneksi terputus (kode ${code || 'Unknown'}: ${errorMsg}). Reconnect: ${shouldReconnect}`);

        if (shouldReconnect) {
          const delay = code === DisconnectReason.restartRequired ? 1000 : 5000;
          setTimeout(() => {
            const enabled = getSetting('whatsapp_enabled', '0');
            if (enabled === '1') {
              startBot().catch(e => logger.error('[WhatsApp] Reconnect error: ' + e.message));
            }
          }, delay);
        }
      } else if (connection === 'open') {
        whatsappStatus.qr = null;
        whatsappStatus.qrImage = null;
        whatsappStatus.connection = 'open';
        whatsappStatus.user = sock.user;

        const botPhone = sock.user?.id ? sock.user.id.split(':')[0] : 'Unknown';
        logger.info(`✅ [WhatsApp] Bot berhasil terhubung! Akun JID: ${botPhone}`);
      }
    });

    // ── Listener Pesan Masuk & Handler Transaksi Bot ──────────────────────────
    sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify' || !Array.isArray(m.messages)) return;

      for (const msg of m.messages) {
        try {
          if (!msg.message) continue;
          if (msg.key.fromMe) continue; // Jangan proses pesan yang dikirim bot sendiri

          // Ambil teks dari berbagai jenis pesan
          const text = (
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            ''
          ).trim();

          if (!text) continue;

          const remoteJid = msg.key.remoteJid || '';
          if (!remoteJid) continue;

          // Ekstrak nomor HP pengirim
          let senderPhone = '';
          if (remoteJid.endsWith('@s.whatsapp.net')) {
            senderPhone = remoteJid.split('@')[0];
          } else if (msg.key.participant && msg.key.participant.endsWith('@s.whatsapp.net')) {
            senderPhone = msg.key.participant.split('@')[0];
          }

          const senderDigits = normalizePhoneDigits(senderPhone);
          if (!senderDigits) continue;

          // Cek rate limiting sederhana (maks 15 pesan per 30 detik)
          const now = Date.now();
          const userRate = rateLimitMap.get(senderDigits) || { count: 0, resetAt: now + 30000 };
          if (now > userRate.resetAt) {
            userRate.count = 1;
            userRate.resetAt = now + 30000;
          } else {
            userRate.count++;
          }
          rateLimitMap.set(senderDigits, userRate);

          if (userRate.count > 15) {
            logger.warn(`[WhatsApp Bot] Rate limit triggered for ${senderDigits}`);
            continue;
          }

          // Proses command
          await handleIncomingCommand(sock, remoteJid, senderDigits, text, msg);
        } catch (err) {
          logger.error(`[WhatsApp Bot] Error handling message: ${err.message}`);
        }
      }
    });

    return sock;
  } catch (err) {
    whatsappStatus.connection = 'close';
    whatsappStatus.qr = null;
    whatsappStatus.qrImage = null;
    logger.error('[WhatsApp] Gagal inisialisasi Baileys bot: ' + err.message);
  } finally {
    isStarting = false;
  }
}

/**
 * Router & Processor Command WhatsApp (Agent & Admin)
 */
async function handleIncomingCommand(sock, jid, senderDigits, text, rawMsg) {
  const appName = getSetting('app_name', 'Juragan Pulsa');
  const isAdmin = isAdminPhone(senderDigits);
  const agent = findAgentByPhone(senderDigits);

  // Helper balas pesan teks
  const reply = async (msgText) => {
    await simulateTyping(sock, jid, 800);
    return await sock.sendMessage(jid, { text: msgText }, { quoted: rawMsg });
  };

  // Parsing kata pertama sebagai perintah (bersihkan simbol !, /, #, .)
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return;

  const rawFirst = parts[0];
  const cleanCmd = rawFirst.replace(/^[\/!#\.]/, '').toLowerCase();
  const args = parts.slice(1);

  logger.info(`[WhatsApp Bot] Command: "${cleanCmd}" from ${senderDigits} (isAdmin=${isAdmin}, isAgent=${!!agent})`);

  // ── 1. MENU / BANTUAN ───────────────────────────────────────────────────────
  if (['menu', 'bantuan', 'help', 'info', 'halo', 'hai', 'p'].includes(cleanCmd)) {
    if (isAdmin && !agent) {
      return await reply(
        `👑 *MENU ADMINISTRATOR — ${appName}*\n` +
        `────────────────────────────\n` +
        `Berikut daftar perintah khusus Admin:\n\n` +
        `📊 *Informasi & Laporan:*\n` +
        `• \`saldodigi\` — Cek saldo deposit Digiflazz H2H\n` +
        `• \`ringkasan\` — Rekap transaksi & omset hari ini\n` +
        `• \`syncproduk\` — Trigger sinkronisasi produk Digiflazz\n\n` +
        `💰 *Manajemen Saldo Agen:*\n` +
        `• \`topup <username/id> <nominal>\` — Topup saldo agen\n` +
        `  _Contoh: \`topup budicell 50000\`_\n` +
        `• \`appdeposit <kode_deposit>\` — Setujui tiket deposit agen\n` +
        `  _Contoh: \`appdeposit DEP-1-172600000\`_\n` +
        `• \`rejdeposit <kode_deposit> [alasan]\` — Tolak tiket deposit\n\n` +
        `🔍 *Pengecekan:*\n` +
        `• \`cektrx <ref_id>\` — Cek status & detail transaksi\n` +
        `────────────────────────────\n` +
        `_Ketik salah satu perintah di atas._`
      );
    }

    if (agent) {
      return await reply(
        `📱 *MENU TRANSAKSI AGEN — ${appName}*\n` +
        `────────────────────────────\n` +
        `Yth. *${agent.name}* (@${agent.username})\n` +
        `💰 Saldo Anda: *${formatRupiah(agent.balance)}*\n\n` +
        `⚡ *Format Transaksi Pulsa/PPOB:*\n` +
        `• \`pulsa <sku> <nomor_tujuan>\`\n` +
        `  _Contoh: \`pulsa TSEL10 081234567890\`_\n` +
        `  _Contoh: \`pulsa PLN20 14223344556\`_\n\n` +
        `🔍 *Cek Status & Saldo:*\n` +
        `• \`saldo\` — Cek sisa saldo akun\n` +
        `• \`cekpulsa <ref_id>\` — Cek status transaksi terakhir\n` +
        `• \`mutasi\` — Cek 5 mutasi saldo terakhir\n\n` +
        `💳 *Isi Saldo (Deposit QRIS/Bank):*\n` +
        `• \`deposit <nominal>\`\n` +
        `  _Contoh: \`deposit 50000\`_\n\n` +
        `📋 *Cek Katalog Harga:*\n` +
        `• \`harga <operator/kategori>\`\n` +
        `  _Contoh: \`harga tsel\` atau \`harga pln\`_\n` +
        `────────────────────────────\n` +
        `_Transaksi aman, cepat, dan otomatis 24 Jam._`
      );
    }

    return await reply(
      `👋 Halo! Selamat datang di *${appName}*.\n\n` +
      `Nomor WhatsApp ini (*${senderDigits}*) belum terdaftar sebagai Agen di sistem kami.\n\n` +
      `Silakan hubungi Admin atau buka aplikasi *${appName}* untuk melakukan pendaftaran agen pulsa H2H.`
    );
  }

  // ── 2. CEK SALDO (AGENT & ADMIN) ───────────────────────────────────────────
  if (['saldo', 'ceksaldo', 'saldomenu', 'mysaldo'].includes(cleanCmd)) {
    if (agent) {
      const fresh = db.prepare('SELECT * FROM agents WHERE id = ?').get(agent.id) || agent;
      return await reply(
        `💳 *INFORMASI SALDO AGEN*\n` +
        `────────────────────────────\n` +
        `👤 Agen: *${fresh.name}* (@${fresh.username})\n` +
        `📞 No. HP: *${fresh.phone}*\n` +
        `🏷️ Grup Harga: *${fresh.markup_group || 'Standar'}*\n` +
        `💰 *Sisa Saldo: ${formatRupiah(fresh.balance)}*\n` +
        `────────────────────────────\n` +
        `💡 _Ketik \`deposit 50000\` untuk request isi saldo QRIS/Bank._\n` +
        `💡 _Ketik \`pulsa <sku> <tujuan>\` untuk bertransaksi._`
      );
    }

    if (isAdmin) {
      try {
        const digiAdapter = require('./providers/digiflazzAdapter');
        const provider = db.prepare('SELECT * FROM providers WHERE name = "digiflazz"').get();
        const res = await digiAdapter.checkBalance(provider);
        return await reply(
          `🏦 *SALDO DIGIFLAZZ (ADMIN)*\n` +
          `────────────────────────────\n` +
          `💳 Saldo Deposit Vendor: *${formatRupiah(res.balance)}*\n` +
          `⏱️ Waktu Pengecekan: ${formatDateTime(new Date())}\n` +
          `────────────────────────────\n` +
          `_Nomor Anda teridentifikasi sebagai Administrator._`
        );
      } catch (e) {
        return await reply(`❌ Gagal cek saldo vendor: ${e.message}`);
      }
    }

    return await reply('❌ Nomor WhatsApp Anda belum terdaftar sebagai Agen aktif.');
  }

  // ── 3. TRANSAKSI PULSA / PPOB (AGENT) ──────────────────────────────────────
  if (['pulsa', 'beli', 'order', 'trx'].includes(cleanCmd)) {
    if (!agent) {
      return await reply('❌ Transaksi hanya dapat dilakukan oleh nomor WhatsApp yang terdaftar sebagai Agen.');
    }

    if (args.length < 2) {
      return await reply(
        `❌ *Format Perintah Kurang Lengkap:*\n` +
        `\`pulsa <sku_produk> <nomor_tujuan>\`\n\n` +
        `💡 *Contoh:*\n` +
        `• \`pulsa TSEL10 081234567890\`\n` +
        `• \`pulsa PLN20 14223344556\`\n` +
        `• \`pulsa DANA25 085712345678\``
      );
    }

    const sku = args[0].toUpperCase();
    const target = args[1].replace(/[^\d]/g, '');

    if (!target) {
      return await reply('❌ Nomor tujuan transaksi tidak valid.');
    }

    try {
      await simulateTyping(sock, jid, 1500);
      const transactionService = require('./transactionService');
      const result = await transactionService.createTransaction(agent.id, {
        sku,
        target,
        channel: 'whatsapp'
      });

      const tx = result.transaction;
      const statusUpper = String(tx.status || 'pending').toUpperCase();
      const statusIcon = tx.status === 'success' ? '✅' : tx.status === 'failed' ? '❌' : '⏳';

      return await reply(
        `${statusIcon} *STATUS TRANSAKSI: ${statusUpper}*\n` +
        `────────────────────────────\n` +
        `🏢 *${appName}*\n` +
        `────────────────────────────\n` +
        `👤 Agen: *${agent.name}* (@${agent.username})\n` +
        `📦 Produk: *${tx.product_name || tx.product_sku}*\n` +
        `🎯 No. Tujuan: \`${tx.target}\`\n` +
        `🧾 Ref ID: \`${tx.ref_id}\`\n` +
        `💵 Harga: *${formatRupiah(tx.price_sell)}*\n` +
        `🔢 *SN / Token:* \`${tx.sn || '-'}\`\n` +
        `💬 Keterangan: ${tx.message || '-'}\n` +
        `────────────────────────────\n` +
        `💰 *Sisa Saldo: ${formatRupiah(result.balanceAfter)}*\n` +
        (tx.status === 'pending' ? `\n_Status masih diproses operator. Ketik \`cekpulsa ${tx.ref_id}\` untuk cek status._` : '')
      );
    } catch (err) {
      return await reply(`❌ *Transaksi Gagal:* ${err.message}`);
    }
  }

  // ── 4. CEK STATUS TRANSAKSI (AGENT & ADMIN) ────────────────────────────────
  if (['cekpulsa', 'status', 'cektrx'].includes(cleanCmd)) {
    const refId = args[0] ? args[0].trim() : '';

    let tx = null;
    if (refId) {
      tx = db.prepare('SELECT * FROM transactions WHERE ref_id = ? OR id = ?').get(refId, parseInt(refId, 10) || 0);
    } else if (agent) {
      // Ambil transaksi terakhir agen
      tx = db.prepare('SELECT * FROM transactions WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1').get(agent.id);
    }

    if (!tx) {
      return await reply('❌ Transaksi tidak ditemukan. Cantumkan Ref ID: `cekpulsa JP-xxx`');
    }

    // Jika agen lain mencoba cek transaksi bukan miliknya
    if (agent && !isAdmin && tx.agent_id !== agent.id) {
      return await reply('❌ Anda tidak memiliki akses ke transaksi ini.');
    }

    try {
      const transactionService = require('./transactionService');
      const updated = await transactionService.checkTransactionStatus(tx.id);
      const statusIcon = updated.status === 'success' ? '✅' : updated.status === 'failed' ? '❌' : '⏳';

      return await reply(
        `${statusIcon} *DETAIL TRANSAKSI*\n` +
        `────────────────────────────\n` +
        `🧾 Ref ID: \`${updated.ref_id}\`\n` +
        `📦 Produk: *${updated.product_name}*\n` +
        `🎯 Tujuan: \`${updated.target}\`\n` +
        `💵 Harga: *${formatRupiah(updated.price_sell)}*\n` +
        `📡 Status: *${updated.status.toUpperCase()}*\n` +
        `🔢 *SN:* \`${updated.sn || '-'}\`\n` +
        `💬 Pesan: ${updated.message || '-'}\n` +
        `⏱️ Waktu: ${formatDateTime(updated.created_at)}`
      );
    } catch (e) {
      return await reply(`❌ Gagal cek status: ${e.message}`);
    }
  }

  // ── 5. REQUEST DEPOSIT (AGENT) ─────────────────────────────────────────────
  if (['deposit', 'depo', 'isisaldo', 'topupme'].includes(cleanCmd)) {
    if (!agent) {
      return await reply('❌ Request deposit hanya untuk nomor yang terdaftar sebagai Agen.');
    }

    const amountRaw = args[0] ? args[0].replace(/[^\d]/g, '') : '';
    const amountNum = parseFloat(amountRaw);

    if (!amountNum || amountNum < 10000) {
      return await reply(
        `❌ *Nominal Tidak Valid!*\n\n` +
        `Format: \`deposit <nominal>\` (minimal Rp 10.000)\n` +
        `💡 Contoh: \`deposit 50000\``
      );
    }

    try {
      await simulateTyping(sock, jid, 1200);
      const depositService = require('./depositService');
      const deposit = await depositService.createDepositRequest(agent.id, amountNum, {
        notes: 'Request via WhatsApp Bot'
      });

      const bankAccounts = depositService.getBankAccounts(true);
      let bankListStr = '';
      bankAccounts.forEach((b, idx) => {
        bankListStr += `• *${b.bank_name}*: \`${b.account_number}\` (a.n ${b.account_name})\n`;
      });

      const qrisEnabled = getSetting('qris_static_enabled', '1') === '1' || getSetting('qris_static_enabled', '1') === 1;
      const staticPayload = String(getSetting('qris_static_payload', '') || '').trim();

      const msgContent =
        `💳 *TIKET DEPOSIT SALDO DIBUAT*\n` +
        `────────────────────────────\n` +
        `👤 Agen: *${agent.name}* (@${agent.username})\n` +
        `📋 Kode Tiket: \`${deposit.deposit_code}\`\n` +
        `💰 *NOMINAL TRANSFER TEPAT:*\n` +
        `👉 *${formatRupiah(deposit.amount)}*\n` +
        `_(Nominal pokok ${formatRupiah(deposit.base_amount)} + Kode Unik ${deposit.unique_code})_\n\n` +
        `🏦 *Pilihan Rekening Bank Tujuan:*\n` +
        (bankListStr || '• Hubungi Admin untuk rekening bank\n') +
        `\n⚠️ *PENTING:* Transfer HARUS sesuai dengan nominal tepat *${formatRupiah(deposit.amount)}* sampai 3 digit terakhir agar saldo dapat diverifikasi dengan cepat!\n` +
        `────────────────────────────\n` +
        (qrisEnabled && staticPayload ? `📱 *QRIS Dinamis sedang dikirim di bawah...*` : `_Setelah transfer, saldo akan diverifikasi oleh Admin._`);

      // Kirim teks rincian deposit
      await reply(msgContent);

      // Jika QRIS aktif, kirim gambar dynamic QRIS langsung ke WhatsApp!
      if (qrisEnabled && staticPayload) {
        try {
          const { buffer } = await qrisUtil.generateDynamicQrisBuffer(staticPayload, deposit.amount);
          await sock.sendMessage(jid, {
            image: buffer,
            caption: `📲 *QRIS DINAMIS — ${formatRupiah(deposit.amount)}*\n\nScan QRIS di atas menggunakan aplikasi Mobile Banking / E-Wallet Anda (BCA, Mandiri, BRI, DANA, GoPay, OVO, ShopeePay, dll). Nominal akan otomatis terisi ${formatRupiah(deposit.amount)}.`
          }, { quoted: rawMsg });
        } catch (qrErr) {
          logger.warn(`[WhatsApp Bot] Gagal kirim QRIS image ke WA: ${qrErr.message}`);
        }
      }

      return true;
    } catch (err) {
      return await reply(`❌ Gagal membuat deposit: ${err.message}`);
    }
  }

  // ── 6. KATALOG HARGA PRODUK (AGENT & ADMIN) ────────────────────────────────
  if (['harga', 'produk', 'list', 'katalog'].includes(cleanCmd)) {
    const keyword = args.join(' ').toLowerCase();

    const sql = `
      SELECT p.sku, p.product_name, p.category, p.brand, p.price_sell, p.is_active
      FROM products p
      WHERE p.is_active = 1
        ${keyword ? 'AND (LOWER(p.sku) LIKE ? OR LOWER(p.product_name) LIKE ? OR LOWER(p.brand) LIKE ? OR LOWER(p.category) LIKE ?)' : ''}
      ORDER BY p.category ASC, p.price_sell ASC
      LIMIT 15
    `;

    const params = keyword ? [`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`] : [];
    const products = db.prepare(sql).all(...params);

    if (products.length === 0) {
      return await reply(`❌ Tidak ditemukan produk aktif untuk kata kunci "*${keyword}*".`);
    }

    let out = `📦 *KATALOG PRODUK (${products.length} Item)*\n────────────────────────────\n`;
    products.forEach((p, idx) => {
      out += `${idx + 1}. \`${p.sku}\` — *${p.product_name}*\n   💵 Harga: *${formatRupiah(p.price_sell)}*\n`;
    });
    out += `────────────────────────────\n💡 _Format beli: \`pulsa <sku> <nomor_tujuan>\`_`;

    return await reply(out);
  }

  // ── 7. MUTASI SALDO TERAKHIR (AGENT) ───────────────────────────────────────
  if (['mutasi', 'rekapagen', 'riwayat'].includes(cleanCmd)) {
    if (!agent) {
      return await reply('❌ Perintah mutasi hanya untuk Agen.');
    }

    const mutations = db.prepare(`
      SELECT * FROM balance_mutations
      WHERE agent_id = ?
      ORDER BY created_at DESC
      LIMIT 5
    `).all(agent.id);

    if (mutations.length === 0) {
      return await reply('📋 Belum ada riwayat mutasi saldo pada akun Anda.');
    }

    let out = `📋 *5 MUTASI SALDO TERAKHIR*\n────────────────────────────\n`;
    mutations.forEach(m => {
      const typeSign = m.type === 'credit' ? '🟢 +' : '🔴 -';
      out += `${typeSign} *${formatRupiah(m.amount)}* (${m.type.toUpperCase()})\n` +
             `   📝 ${m.notes || '-'}\n` +
             `   💳 Sisa: ${formatRupiah(m.balance_after)} | ⏱️ ${formatDateTime(m.created_at)}\n\n`;
    });

    return await reply(out.trim());
  }

  // ── 8. ADMIN: SALDO DIGIFLAZZ ──────────────────────────────────────────────
  if (isAdmin && ['saldodigi', 'ceksaldodigi', 'digisaldo'].includes(cleanCmd)) {
    try {
      const digiAdapter = require('./providers/digiflazzAdapter');
      const provider = db.prepare('SELECT * FROM providers WHERE name = "digiflazz"').get();
      const res = await digiAdapter.checkBalance(provider);
      return await reply(
        `🏦 *SALDO DIGIFLAZZ (H2H VENDOR)*\n` +
        `────────────────────────────\n` +
        `💳 Deposit Tersedia: *${formatRupiah(res.balance)}*\n` +
        `⏱️ Update Terakhir: ${formatDateTime(new Date())}\n` +
        `────────────────────────────`
      );
    } catch (e) {
      return await reply(`❌ Gagal cek saldo Digiflazz: ${e.message}`);
    }
  }

  // ── 9. ADMIN: TOP UP SALDO AGEN ────────────────────────────────────────────
  if (isAdmin && ['topup', 'topupagent', 'tfagent'].includes(cleanCmd)) {
    if (args.length < 2) {
      return await reply(
        `❌ *Format Perintah Kurang:*\n` +
        `\`topup <username/nohp/id_agent> <nominal> [catatan]\`\n\n` +
        `💡 Contoh: \`topup budicell 50000 Saldo awal\``
      );
    }

    const targetKey = args[0].replace(/^@/, '');
    const amount = parseFloat(args[1].replace(/[^\d]/g, ''));
    const notes = args.slice(2).join(' ') || 'Topup via WhatsApp Admin';

    if (!amount || amount <= 0) {
      return await reply('❌ Nominal topup tidak valid.');
    }

    const agentSvc = require('./agentService');
    const targetAgent = db.prepare(`
      SELECT * FROM agents 
      WHERE username = ? OR id = ? OR phone LIKE ?
    `).get(targetKey, parseInt(targetKey, 10) || 0, `%${targetKey}%`);

    if (!targetAgent) {
      return await reply(`❌ Agen "*${targetKey}*" tidak ditemukan di sistem.`);
    }

    try {
      const result = agentSvc.topupBalance(targetAgent.id, amount, notes, `WA Admin (${senderDigits})`);
      
      // Kirim notifikasi ke admin
      await reply(
        `✅ *TOP UP SALDO AGEN BERHASIL*\n` +
        `────────────────────────────\n` +
        `👤 Agen: *${targetAgent.name}* (@${targetAgent.username})\n` +
        `📞 No. HP: *${targetAgent.phone}*\n` +
        `💸 Nominal: *${formatRupiah(amount)}*\n` +
        `💳 Saldo: ${formatRupiah(result.before)} ➔ *${formatRupiah(result.after)}*\n` +
        `📝 Catatan: ${notes}\n` +
        `────────────────────────────`
      );

      // Notifikasi ke nomor WhatsApp agen bersangkutan jika ada
      if (targetAgent.phone) {
        sendWhatsAppMessage(targetAgent.phone,
          `*✅ SALDO ANDA TELAH DITAMBAHKAN*\n` +
          `────────────────────────────\n` +
          `Yth. Agen *${targetAgent.name}*,\n\n` +
          `Saldo sebesar *${formatRupiah(amount)}* telah ditambahkan oleh Admin.\n` +
          `📝 Catatan: ${notes}\n` +
          `💰 Total Saldo Sekarang: *${formatRupiah(result.after)}*\n` +
          `────────────────────────────\n` +
          `_Selamat bertransaksi di ${appName}!_`
        ).catch(() => {});
      }
      return true;
    } catch (e) {
      return await reply(`❌ Gagal topup: ${e.message}`);
    }
  }

  // ── 10. ADMIN: APPROVE DEPOSIT ─────────────────────────────────────────────
  if (isAdmin && ['appdeposit', 'acc', 'approvedepo'].includes(cleanCmd)) {
    if (args.length < 1) {
      return await reply('❌ Format: `appdeposit <deposit_code/id>`\nContoh: `appdeposit DEP-1-172600000`');
    }

    const depositKey = args[0].trim();
    const deposit = db.prepare('SELECT * FROM deposit_requests WHERE deposit_code = ? OR id = ?').get(depositKey, parseInt(depositKey, 10) || 0);

    if (!deposit) {
      return await reply(`❌ Tiket deposit "*${depositKey}*" tidak ditemukan.`);
    }

    try {
      const depositService = require('./depositService');
      const approved = depositService.approveDeposit(deposit.id, `WA Admin (${senderDigits})`);
      const targetAgent = db.prepare('SELECT * FROM agents WHERE id = ?').get(deposit.agent_id);

      await reply(
        `✅ *TIKET DEPOSIT DISETUJUI*\n` +
        `────────────────────────────\n` +
        `📋 Kode: \`${approved.deposit_code}\`\n` +
        `👤 Agen: *${targetAgent ? targetAgent.name : '-'}*\n` +
        `💰 Nominal: *${formatRupiah(approved.amount)}*\n` +
        `💳 Saldo Agen Sekarang: *${formatRupiah(targetAgent ? targetAgent.balance : 0)}*\n` +
        `────────────────────────────`
      );

      if (targetAgent && targetAgent.phone) {
        notifyDepositApproved(approved, targetAgent).catch(() => {});
      }
      return true;
    } catch (e) {
      return await reply(`❌ Gagal approve deposit: ${e.message}`);
    }
  }

  // ── 11. ADMIN: REJECT DEPOSIT ──────────────────────────────────────────────
  if (isAdmin && ['rejdeposit', 'rejectdepo', 'tolakdepo'].includes(cleanCmd)) {
    if (args.length < 1) {
      return await reply('❌ Format: `rejdeposit <deposit_code/id> [alasan]`');
    }

    const depositKey = args[0].trim();
    const reason = args.slice(1).join(' ') || 'Bukti transfer tidak sesuai';
    const deposit = db.prepare('SELECT * FROM deposit_requests WHERE deposit_code = ? OR id = ?').get(depositKey, parseInt(depositKey, 10) || 0);

    if (!deposit) {
      return await reply(`❌ Tiket deposit "*${depositKey}*" tidak ditemukan.`);
    }

    try {
      const depositService = require('./depositService');
      const rejected = depositService.rejectDeposit(deposit.id, `WA Admin (${senderDigits})`, reason);
      return await reply(
        `🚫 *TIKET DEPOSIT DITOLAK*\n` +
        `────────────────────────────\n` +
        `📋 Kode: \`${rejected.deposit_code}\`\n` +
        `📝 Alasan: ${reason}\n` +
        `────────────────────────────`
      );
    } catch (e) {
      return await reply(`❌ Gagal reject deposit: ${e.message}`);
    }
  }

  // ── 12. ADMIN: RINGKASAN REKAP HARIAN ──────────────────────────────────────
  if (isAdmin && ['ringkasan', 'rekap', 'omset'].includes(cleanCmd)) {
    try {
      const adminService = require('./adminService');
      const stats = adminService.getDashboardStats();

      return await reply(
        `📊 *RINGKASAN SERVER — ${appName}*\n` +
        `────────────────────────────\n` +
        `📅 Tanggal: ${formatDate(new Date())}\n\n` +
        `👥 Agen Aktif: *${stats.active_agents}*\n` +
        `📋 Transaksi Hari Ini: *${stats.today_transactions}* (Sukses: ${stats.today_success})\n` +
        `⏳ Transaksi Pending: *${stats.pending_transactions}*\n` +
        `💵 Omset Hari Ini: *${formatRupiah(stats.today_revenue)}*\n` +
        `📈 Gross Profit: *${formatRupiah(stats.today_profit)}*\n` +
        `🏦 Saldo Provider: *${formatRupiah(stats.provider_balance)}*\n` +
        `────────────────────────────`
      );
    } catch (e) {
      return await reply(`❌ Gagal mengambil ringkasan: ${e.message}`);
    }
  }

  // ── 13. ADMIN: SYNC PRODUK DIGIFLAZZ ───────────────────────────────────────
  if (isAdmin && ['syncproduk', 'syncprice'].includes(cleanCmd)) {
    try {
      await reply('⏳ Memulai sinkronisasi produk Digiflazz, mohon tunggu sebentar...');
      const productService = require('./productService');
      const res = await productService.syncProductsFromProvider();
      return await reply(
        `✅ *SINKRONISASI PRODUK SELESAI*\n` +
        `────────────────────────────\n` +
        `📦 Total Produk: *${res.total}*\n` +
        `➕ Produk Baru: *${res.inserted}*\n` +
        `🔄 Diperbarui: *${res.updated}*\n` +
        `🟢 Status Aktif: *${res.active}*\n` +
        `🔴 Status Nonaktif: *${res.inactive}*\n` +
        `────────────────────────────`
      );
    } catch (e) {
      return await reply(`❌ Gagal sinkronisasi produk: ${e.message}`);
    }
  }

  // Perintah tidak dikenal
  if (agent || isAdmin) {
    return await reply(
      `❓ Perintah \`${cleanCmd}\` tidak dikenali.\n` +
      `Ketik *menu* untuk melihat daftar format perintah yang tersedia.`
    );
  }
}

/**
 * Hapus seluruh data sesi Baileys dan mulai ulang bot untuk QR baru
 */
async function resetSession() {
  try {
    if (currentSock) {
      try {
        currentSock.ev.removeAllListeners();
        currentSock.end();
      } catch (_) {}
      currentSock = null;
    }

    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
      fs.mkdirSync(authDir, { recursive: true });
      logger.info(`[WhatsApp] Sesi ${authDir} berhasil direset.`);
    }

    whatsappStatus.connection = 'connecting';
    whatsappStatus.qr = null;
    whatsappStatus.qrImage = null;
    whatsappStatus.user = null;

    // Mulai ulang pembuatan socket & QR
    setTimeout(() => {
      startBot().catch(e => logger.error('[WhatsApp] Restart after reset error: ' + e.message));
    }, 1000);

    return true;
  } catch (err) {
    logger.error('[WhatsApp] Gagal reset sesi: ' + err.message);
    throw err;
  }
}

/**
 * Kirim pesan WhatsApp ke nomor HP tujuan
 */
async function sendWhatsAppMessage(phone, messageText) {
  if (!currentSock || whatsappStatus.connection !== 'open') {
    logger.warn(`[WhatsApp] Tidak dapat mengirim pesan (WhatsApp belum terhubung) ke: ${phone}`);
    return false;
  }

  try {
    const cleanDigits = normalizePhoneDigits(phone);
    if (!cleanDigits) {
      throw new Error('Format nomor telepon tidak valid: ' + phone);
    }

    const targetJid = `${cleanDigits}@s.whatsapp.net`;
    const res = await currentSock.sendMessage(targetJid, { text: messageText });
    logger.info(`[WhatsApp] Pesan notifikasi berhasil dikirim ke ${cleanDigits}`);
    return !!res;
  } catch (err) {
    logger.error(`[WhatsApp] Gagal mengirim pesan ke ${phone}: ${err.message}`);
    return false;
  }
}

/**
 * Notifikasi transaksi pulsa/PPOB sukses ke agen
 */
async function notifyTransactionSuccess(tx, agent) {
  if (!agent || !agent.phone) return;
  const appName = getSetting('app_name', 'Juragan Pulsa');

  const msg = `*🎉 TRANSAKSI BERHASIL*
────────────────────────────
🏢 *${appName}*
────────────────────────────
Yth. Agen *${agent.name || agent.username}*,

Transaksi pembelian Anda telah sukses diproses oleh server.

📋 *Detail Transaksi:*
• *Ref ID:* \`${tx.ref_id}\`
• *Produk:* ${tx.product_name || tx.product_sku}
• *Tujuan:* ${tx.target}
• *Harga:* *${formatRupiah(tx.price_sell)}*
• *SN / Token:* \`${tx.sn || '-'}\`
• *Waktu:* ${formatDateTime(tx.created_at)}
• *Status:* *SUKSES ✅*

💰 *Sisa Saldo Anda:* *${formatRupiah(agent.balance)}*

────────────────────────────
_Simpan pesan ini sebagai bukti transaksi yang sah._`;

  return sendWhatsAppMessage(agent.phone, msg);
}

/**
 * Notifikasi deposit saldo disetujui ke agen
 */
async function notifyDepositApproved(deposit, agent) {
  if (!agent || !agent.phone) return;
  const appName = getSetting('app_name', 'Juragan Pulsa');

  const msg = `*✅ DEPOSIT SALDO DISETUJUI*
────────────────────────────
🏢 *${appName}*
────────────────────────────
Yth. Agen *${agent.name || agent.username}*,

Tiket deposit saldo Anda telah diverifikasi dan berhasil ditambahkan ke akun Anda.

📋 *Rincian Deposit:*
• *Kode Tiket:* \`${deposit.deposit_code}\`
• *Nominal:* *${formatRupiah(deposit.amount)}*
• *Waktu Disetujui:* ${formatDateTime(deposit.reviewed_at || new Date())}
• *Status:* *BERHASIL / LUNAS ✅*

💰 *Total Saldo Sekarang:* *${formatRupiah(agent.balance)}*

────────────────────────────
_Terima kasih telah melakukan deposit di ${appName}. Selamat bertransaksi!_`;

  return sendWhatsAppMessage(agent.phone, msg);
}

/**
 * Kirim pesan bergambar ke nomor WhatsApp tujuan
 */
async function sendWhatsAppImage(phone, imageBuffer, caption = '') {
  if (!currentSock || whatsappStatus.connection !== 'open') {
    logger.warn(`[WhatsApp] Tidak dapat mengirim gambar (WhatsApp belum terhubung) ke: ${phone}`);
    return false;
  }

  try {
    const cleanDigits = normalizePhoneDigits(phone);
    if (!cleanDigits) {
      throw new Error('Format nomor telepon tidak valid: ' + phone);
    }

    const targetJid = `${cleanDigits}@s.whatsapp.net`;
    const res = await currentSock.sendMessage(targetJid, {
      image: imageBuffer,
      caption: caption
    });
    logger.info(`[WhatsApp] Gambar notifikasi berhasil dikirim ke ${cleanDigits}`);
    return !!res;
  } catch (err) {
    logger.error(`[WhatsApp] Gagal mengirim gambar ke ${phone}: ${err.message}`);
    return false;
  }
}

/**
 * Kirim pesan onboarding dan QR Code Pairing login ke Agen baru via WhatsApp
 */
async function sendAgentWelcomeMessage({ agent, plainPassword, serverUrl }) {
  if (!agent || !agent.phone) return false;
  const appName = getSetting('app_name', 'Juragan Pulsa');

  const pairingPayload = JSON.stringify({
    app: appName,
    url: serverUrl,
    u: agent.username,
    p: plainPassword || '',
    role: 'agent'
  });

  const caption =
    `*🎉 SELAMAT DATANG DI ${appName.toUpperCase()}*\n` +
    `────────────────────────────\n` +
    `Halo *${agent.name}*,\n` +
    `Akun Reseller / Agen Pulsa Anda telah aktif dan siap digunakan!\n\n` +
    `📋 *Detail Akun Agen:*\n` +
    `• *Server URL:* ${serverUrl}\n` +
    `• *Username:* \`${agent.username}\`\n` +
    `• *Password:* \`${plainPassword || '(Sesuai yang didaftarkan)'}\`\n` +
    `• *Saldo Awal:* *${formatRupiah(agent.balance || 0)}*\n\n` +
    `📲 *Cara Login Cepat di Aplikasi Android:*\n` +
    `1. Buka aplikasi *${appName}*\n` +
    `2. Tekan tombol *📷 Scan QR Code Akun*\n` +
    `3. Arahkan kamera atau scan gambar QR Code di atas.\n` +
    `_(Aplikasi otomatis mengisi Server, Username, Password, dan login!)_\n\n` +
    `💬 Anda juga bisa bertransaksi langsung via WhatsApp ini!\n` +
    `Ketik *menu* untuk melihat format transaksi pulsa, paket data, & PLN.\n` +
    `────────────────────────────\n` +
    `_Simpan data akun ini dengan baik dan jangan dibagikan ke orang lain._`;

  try {
    const qrBuffer = await QRCodeNode.toBuffer(pairingPayload, {
      type: 'png',
      width: 450,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });

    return await sendWhatsAppImage(agent.phone, qrBuffer, caption);
  } catch (err) {
    logger.warn(`[WhatsApp] Gagal generate/kirim QR Pairing ke WA: ${err.message}. Mencoba fallback teks.`);
    return await sendWhatsAppMessage(agent.phone, caption);
  }
}

/**
 * Notifikasi invoice baru untuk pesanan publik (Web Store)
 */
async function notifyPublicInvoiceCreated(order, invoiceUrl) {
  if (!order || !order.buyer_phone) return false;
  const appName = getSetting('public_store_name', getSetting('app_name', 'Juragan Pulsa'));

  const msg =
    `*🧾 INVOICE PESANAN TOP-UP - ${appName.toUpperCase()}*\n` +
    `────────────────────────────\n` +
    `Halo, terima kasih telah memesan di *${appName}*.\n\n` +
    `📋 *Rincian Pesanan:*\n` +
    `• *No. Invoice:* \`${order.invoice_code}\`\n` +
    `• *Produk:* ${order.product_name}\n` +
    `• *Tujuan:* \`${order.target_combined}\`\n` +
    `• *Total Pembayaran:* *${formatRupiah(order.total_amount)}*\n` +
    `  _(Termasuk kode unik Rp ${order.unique_code})_\n` +
    `• *Batas Waktu:* 15 Menit\n\n` +
    `📲 *Buka QRIS & Bayar Di Sini:*\n` +
    `${invoiceUrl}\n\n` +
    `_Transfer sesuai nominal tepat agar pesanan otomatis terkirim._`;

  return await sendWhatsAppMessage(order.buyer_phone, msg);
}

/**
 * Notifikasi sukses untuk pesanan publik (Web Store)
 */
async function notifyPublicOrderSuccess(order) {
  if (!order || !order.buyer_phone) return false;
  const appName = getSetting('public_store_name', getSetting('app_name', 'Juragan Pulsa'));

  const msg =
    `*✅ TOP-UP BERHASIL! - ${appName.toUpperCase()}*\n` +
    `────────────────────────────\n` +
    `Pesanan Anda telah berhasil diproses dan dikirim!\n\n` +
    `📋 *Rincian Transaksi:*\n` +
    `• *No. Invoice:* \`${order.invoice_code}\`\n` +
    `• *Produk:* ${order.product_name}\n` +
    `• *Tujuan:* \`${order.target_combined}\`\n` +
    `• *Total Bayar:* *${formatRupiah(order.total_amount)}*\n` +
    `• *Status:* *SUKSES*\n` +
    (order.sn ? `• *SN / Token:* \`${order.sn}\`\n` : '') +
    `• *Waktu:* ${formatDateTime(order.completed_at || new Date())}\n\n` +
    `Terima kasih telah berbelanja di *${appName}*! 🙏\n` +
    `────────────────────────────`;

  return await sendWhatsAppMessage(order.buyer_phone, msg);
}

/**
 * Notifikasi gagal untuk pesanan publik (Web Store)
 */
async function notifyPublicOrderFailed(order) {
  if (!order || !order.buyer_phone) return false;
  const appName = getSetting('public_store_name', getSetting('app_name', 'Juragan Pulsa'));
  const csPhone = getSetting('public_cs_whatsapp', getSetting('app_phone', ''));

  const msg =
    `*⚠️ PESANAN GAGAL DIPROSES - ${appName.toUpperCase()}*\n` +
    `────────────────────────────\n` +
    `Pesanan dengan No. Invoice \`${order.invoice_code}\` mengalami kendala dari pihak vendor/provider.\n\n` +
    `📋 *Rincian:*\n` +
    `• *Produk:* ${order.product_name}\n` +
    `• *Tujuan:* \`${order.target_combined}\`\n` +
    `• *Total:* ${formatRupiah(order.total_amount)}\n` +
    `• *Keterangan:* ${order.message || 'Gangguan sistem vendor'}\n\n` +
    (csPhone ? `Silakan hubungi Customer Service kami di WA *${csPhone}* untuk bantuan refund / pemrosesan ulang.` : `Silakan hubungi admin untuk bantuan.`) +
    `\n────────────────────────────`;

  return await sendWhatsAppMessage(order.buyer_phone, msg);
}

/**
 * Ambil status koneksi WhatsApp saat ini
 */
function getConnectionStatus() {
  return {
    connection: whatsappStatus.connection,
    status: whatsappStatus.connection,
    qr: whatsappStatus.qr,
    qrImage: whatsappStatus.qrImage,
    user: whatsappStatus.user,
    lastUpdate: whatsappStatus.lastUpdate
  };
}

module.exports = {
  startBot,
  resetSession,
  sendWhatsAppMessage,
  sendWhatsAppImage,
  sendAgentWelcomeMessage,
  notifyTransactionSuccess,
  notifyDepositApproved,
  notifyPublicInvoiceCreated,
  notifyPublicOrderSuccess,
  notifyPublicOrderFailed,
  getConnectionStatus,
  normalizePhoneDigits
};

