/**
 * Juragan Pulsa - Telegram Bot Service
 * services/telegramService.js
 * 
 * Jembatan dua arah (Two-Way Bridge):
 * 1. Mengirim pesan live chat pengunjung web ke Telegram Admin/Grup CS.
 * 2. Menerima balasan (Reply) Admin di Telegram dan meneruskannya ke pengunjung web secara real-time.
 */

'use strict';

const axios = require('axios');
const EventEmitter = require('events');
const db = require('../config/database');
const { getSetting } = require('../config/settingsManager');
const logger = require('../utils/logger');

class TelegramService extends EventEmitter {
  constructor() {
    super();
    this.isPolling = false;
    this.pollingOffset = 0;
    this.pollingTimeout = null;
    this.axiosInstance = axios.create({
      timeout: 35000,
    });
  }

  /**
   * Escape HTML khusus Telegram
   */
  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Ambil kredensial Telegram dari database
   */
  getCredentials() {
    const token = String(getSetting('telegram_bot_token', '') || '').trim();
    const chatId = String(getSetting('telegram_chat_id', '') || '').trim();
    const rawEnabled = getSetting('telegram_livechat_enabled', '0');
    const isEnabled = rawEnabled === true || rawEnabled === '1' || rawEnabled === 1 || rawEnabled === 'true';

    return { token, chatId, isEnabled };
  }

  /**
   * Kirim pesan teks ke Telegram
   */
  async sendMessage(chatId, text, options = {}) {
    const { token } = this.getCredentials();
    const targetToken = options.customToken || token;
    const targetChatId = chatId || this.getCredentials().chatId;

    if (!targetToken || !targetChatId) {
      throw new Error('Telegram Bot Token atau Chat ID belum dikonfigurasi.');
    }

    const url = `https://api.telegram.org/bot${targetToken}/sendMessage`;
    const payload = {
      chat_id: targetChatId,
      text: text,
      parse_mode: options.parse_mode || 'HTML',
      disable_web_page_preview: options.disable_web_page_preview !== false,
      reply_to_message_id: options.reply_to_message_id || undefined,
    };

    try {
      const response = await this.axiosInstance.post(url, payload);
      if (response.data && response.data.ok) {
        return response.data.result;
      }
      throw new Error(response.data?.description || 'Gagal mengirim pesan ke Telegram');
    } catch (err) {
      const msg = err.response?.data?.description || err.message;
      logger.error(`[Telegram] Send message error: ${msg}`);
      throw new Error(`Telegram API Error: ${msg}`);
    }
  }

  /**
   * Teruskan pesan chat pengunjung web ke Telegram Admin/Grup CS
   */
  async forwardVisitorMessage({ session, message, visitorName, visitorPhone }) {
    const { isEnabled, chatId } = this.getCredentials();
    if (!isEnabled || !chatId) {
      logger.info('[Telegram] Livechat telegram dinonaktifkan atau Chat ID kosong, lewati forward.');
      return null;
    }

    const cleanName = this.escapeHtml(visitorName || session.visitor_name || 'Pengunjung Web');
    const cleanPhone = this.escapeHtml(visitorPhone || session.visitor_phone || '-');
    const cleanMsg = this.escapeHtml(message);
    const cleanSession = this.escapeHtml(session.session_id);
    const cleanIp = this.escapeHtml(session.ip_address || '-');
    const timeStr = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

    const text = 
`💬 <b>[LiveChat Web] Pesan Masuk</b>
👤 <b>Pengirim:</b> ${cleanName}
📱 <b>No. HP / WA:</b> ${cleanPhone}
🆔 <b>Sesi:</b> <code>${cleanSession}</code>
🌐 <b>IP:</b> <code>${cleanIp}</code>
📅 <b>Waktu:</b> ${timeStr}
────────────────────────
${cleanMsg}
────────────────────────
👉 <i>Tekan <b>Reply (Balas)</b> pada pesan ini untuk menjawab pengunjung web!</i>`;

    try {
      const result = await this.sendMessage(chatId, text);
      return result?.message_id || null;
    } catch (err) {
      logger.warn(`[Telegram] Gagal forward pesan pengunjung: ${err.message}`);
      return null;
    }
  }

  /**
   * Mulai background polling untuk menangkap balasan Admin di Telegram
   */
  startPolling() {
    const { token, isEnabled } = this.getCredentials();
    if (!token || !isEnabled) {
      logger.info('[Telegram] Polling tidak dimulai (Bot token kosong atau livechat dinonaktifkan).');
      return;
    }

    if (this.isPolling) return;
    this.isPolling = true;
    logger.info('[Telegram] Memulai Telegram Bot Long-Polling...');
    this.pollLoop();
  }

  /**
   * Hentikan polling
   */
  stopPolling() {
    this.isPolling = false;
    if (this.pollingTimeout) {
      clearTimeout(this.pollingTimeout);
      this.pollingTimeout = null;
    }
    logger.info('[Telegram] Telegram Bot Polling dihentikan.');
  }

  /**
   * Loop Polling getUpdates
   */
  async pollLoop() {
    if (!this.isPolling) return;

    const { token } = this.getCredentials();
    if (!token) {
      this.isPolling = false;
      return;
    }

    try {
      const url = `https://api.telegram.org/bot${token}/getUpdates`;
      const res = await this.axiosInstance.get(url, {
        params: {
          offset: this.pollingOffset,
          timeout: 20,
          allowed_updates: JSON.stringify(['message']),
        },
      });

      if (res.data && res.data.ok && Array.isArray(res.data.result)) {
        for (const update of res.data.result) {
          this.pollingOffset = update.update_id + 1;
          await this.handleTelegramUpdate(update);
        }
      }
    } catch (err) {
      // Ignore timeout or abort, log other errors
      if (err.code !== 'ECONNABORTED' && !err.message.includes('timeout')) {
        logger.warn(`[Telegram] Polling error: ${err.message}`);
      }
      // Tunggu 3 detik sebelum retry jika ada error koneksi
      await new Promise(r => setTimeout(r, 3000));
    }

    if (this.isPolling) {
      this.pollingTimeout = setTimeout(() => this.pollLoop(), 500);
    }
  }

  /**
   * Proses update pesan yang masuk dari Telegram
   */
  async handleTelegramUpdate(update) {
    const msg = update.message;
    if (!msg || !msg.text) return;

    const text = String(msg.text).trim();
    const fromUser = msg.from?.first_name || 'Admin CS';
    const chatId = msg.chat?.id;

    // Command: /start atau /ping untuk cek status bot
    if (text === '/start' || text === '/ping') {
      try {
        await this.sendMessage(chatId, `🤖 <b>Bot LiveChat Juragan Pulsa Aktif!</b>\n\n✅ Siap menerima dan membalas pesan pengunjung website secara langsung.`, {
          reply_to_message_id: msg.message_id
        });
      } catch (_) {}
      return;
    }

    // Cek apakah pesan ini merupakan Reply (Balasan) terhadap pesan pengunjung sebelumnya
    if (msg.reply_to_message) {
      const repliedTeleMsgId = msg.reply_to_message.message_id;
      const repliedText = msg.reply_to_message.text || '';

      // 1. Cari session_id dari tabel live_chat_messages berdasarkan telegram_message_id
      let sessionRow = db.prepare(`
        SELECT session_id FROM live_chat_messages 
        WHERE telegram_message_id = ? 
        ORDER BY id DESC LIMIT 1
      `).get(repliedTeleMsgId);

      // 2. Jika tidak ketemu di DB, coba parse session_id dari format teks pesan asli: 🆔 Sesi: LC-xxxxxx
      let sessionId = sessionRow?.session_id;
      if (!sessionId && repliedText) {
        const sessMatch = /Sesi:\s*([A-Za-z0-9_-]+)/i.exec(repliedText);
        if (sessMatch) {
          sessionId = sessMatch[1];
        }
      }

      if (sessionId) {
        logger.info(`[Telegram] Menemukan balasan Admin (${fromUser}) untuk sesi: ${sessionId}`);

        // Jika Admin mengetik /selesai, /close, atau /done -> tutup sesi
        if (text === '/selesai' || text === '/close' || text === '/done') {
          const liveChatService = require('./liveChatService');
          await liveChatService.closeSession(sessionId, 'admin');
          try {
            await this.sendMessage(chatId, `✅ <b>Sesi Ditutup:</b> Percakapan untuk sesi <code>${sessionId}</code> telah berhasil diselesaikan.`, {
              reply_to_message_id: msg.message_id
            });
          } catch (_) {}
          return;
        }

        // Simpan balasan Admin ke tabel live_chat_messages
        const insertStmt = db.prepare(`
          INSERT INTO live_chat_messages (
            session_id, sender_type, sender_name, message, telegram_message_id, is_read, created_at
          ) VALUES (?, 'admin', ?, ?, ?, 0, datetime('now','localtime'))
        `);

        const result = insertStmt.run(sessionId, fromUser, text, msg.message_id);

        // Update status sesi
        db.prepare(`
          UPDATE live_chat_sessions 
          SET last_message_at = datetime('now','localtime'), status = 'active'
          WHERE session_id = ?
        `).run(sessionId);

        const newSavedMsg = {
          id: result.lastInsertRowid,
          session_id: sessionId,
          sender_type: 'admin',
          sender_name: fromUser,
          message: text,
          created_at: new Date().toISOString()
        };

        // Emit event agar Web Stream / SSE langsung menerima balasan
        this.emit('admin_reply', newSavedMsg);
        this.emit(`reply:${sessionId}`, newSavedMsg);
      } else {
        logger.warn(`[Telegram] Reply diterima tetapi sesi pengunjung tidak ditemukan (Reply Msg ID: ${repliedTeleMsgId})`);
      }
    }
  }

  /**
   * Tes koneksi dan kirim pesan tes ke Telegram
   */
  async testConnection(customToken, customChatId) {
    const token = String(customToken || getSetting('telegram_bot_token', '')).trim();
    const chatId = String(customChatId || getSetting('telegram_chat_id', '')).trim();

    if (!token) throw new Error('Token Bot Telegram tidak boleh kosong.');
    if (!chatId) throw new Error('Chat ID / ID Grup Telegram tidak boleh kosong.');

    const timeStr = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    const text = 
`🚀 <b>TES KONEKSI BOT TELEGRAM JURAGAN PULSA</b>\n
✅ <b>Status:</b> Berhasil Terhubung!
📅 <b>Waktu:</b> ${timeStr}
🤖 <b>Layanan:</b> Web Live Chat &amp; Notifikasi Admin\n
<i>Jika Anda melihat pesan ini, berarti Bot Telegram sudah siap menerima pesan live chat dari website publik.</i>`;

    return await this.sendMessage(chatId, text, { customToken: token });
  }
}

const telegramService = new TelegramService();
module.exports = telegramService;
