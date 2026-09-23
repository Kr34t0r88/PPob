/**
 * Juragan Pulsa - Live Chat Service
 * services/liveChatService.js
 */

'use strict';

const db = require('../config/database');
const telegramService = require('./telegramService');
const { getSetting } = require('../config/settingsManager');
const logger = require('../utils/logger');

/**
 * Generate Session ID acak jika pengunjung belum memiliki
 */
function generateSessionId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let rand = '';
  for (let i = 0; i < 6; i++) {
    rand += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `LC-${Date.now().toString(36).toUpperCase()}-${rand}`;
}

/**
 * Ambil atau buat sesi baru untuk pengunjung
 */
function getOrCreateSession({ sessionId, visitorName, visitorPhone, ipAddress, userAgent } = {}) {
  let cleanId = String(sessionId || '').trim();
  let session = null;

  if (cleanId) {
    session = db.prepare('SELECT * FROM live_chat_sessions WHERE session_id = ?').get(cleanId);

    // Jika sesi sudah ditutup (closed) atau idle lebih dari 24 jam, otomatis buat sesi baru
    if (session) {
      const isClosed = session.status === 'closed';
      const lastActive = new Date(session.last_message_at || session.created_at).getTime();
      const isExpired = (Date.now() - lastActive) > (24 * 60 * 60 * 1000); // 24 jam

      if (isClosed || isExpired) {
        cleanId = generateSessionId();
        session = null; // Buat sesi baru
      }
    }
  } else {
    cleanId = generateSessionId();
  }

  if (!session) {
    const name = String(visitorName || 'Pengunjung Web').trim();
    const phone = String(visitorPhone || '').trim();
    const ip = String(ipAddress || '').trim();
    const ua = String(userAgent || '').trim();

    db.prepare(`
      INSERT INTO live_chat_sessions (
        session_id, visitor_name, visitor_phone, ip_address, user_agent, status, last_message_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 'active', datetime('now','localtime'), datetime('now','localtime'))
    `).run(cleanId, name, phone, ip, ua);

    session = db.prepare('SELECT * FROM live_chat_sessions WHERE session_id = ?').get(cleanId);

    // Kirim pesan sambutan otomatis (Welcome message)
    const welcomeMsg = getSetting('livechat_welcome_message', 'Halo! Selamat datang di Juragan Pulsa. Ada yang bisa kami bantu?');
    if (welcomeMsg) {
      db.prepare(`
        INSERT INTO live_chat_messages (
          session_id, sender_type, sender_name, message, is_read, created_at
        ) VALUES (?, 'system', 'CS Juragan Pulsa', ?, 0, datetime('now','localtime'))
      `).run(cleanId, welcomeMsg);
    }
  } else {
    // Update nama/telepon jika diberikan
    if (visitorName || visitorPhone) {
      db.prepare(`
        UPDATE live_chat_sessions SET
          visitor_name = COALESCE(NULLIF(?, ''), visitor_name),
          visitor_phone = COALESCE(NULLIF(?, ''), visitor_phone),
          ip_address = COALESCE(NULLIF(?, ''), ip_address),
          last_message_at = datetime('now','localtime')
        WHERE session_id = ?
      `).run(visitorName || '', visitorPhone || '', ipAddress || '', cleanId);

      session = db.prepare('SELECT * FROM live_chat_sessions WHERE session_id = ?').get(cleanId);
    }
  }

  return session;
}

/**
 * Kirim pesan dari pengunjung web
 */
async function sendVisitorMessage({ sessionId, message, visitorName, visitorPhone, ipAddress, userAgent }) {
  if (!message || !String(message).trim()) {
    throw new Error('Pesan tidak boleh kosong.');
  }

  const cleanMsg = String(message).trim();
  const session = getOrCreateSession({ sessionId, visitorName, visitorPhone, ipAddress, userAgent });

  // 1. Simpan pesan pengunjung ke database
  const insertStmt = db.prepare(`
    INSERT INTO live_chat_messages (
      session_id, sender_type, sender_name, message, is_read, created_at
    ) VALUES (?, 'visitor', ?, ?, 0, datetime('now','localtime'))
  `);

  const name = session.visitor_name || visitorName || 'Pengunjung Web';
  const info = insertStmt.run(session.session_id, name, cleanMsg);
  const messageId = info.lastInsertRowid;

  // 2. Update waktu aktivitas sesi
  db.prepare(`
    UPDATE live_chat_sessions 
    SET last_message_at = datetime('now','localtime'), status = 'active'
    WHERE session_id = ?
  `).run(session.session_id);

  // 3. Teruskan ke Telegram Admin
  try {
    const teleMsgId = await telegramService.forwardVisitorMessage({
      session,
      message: cleanMsg,
      visitorName: name,
      visitorPhone: session.visitor_phone || visitorPhone || ''
    });

    if (teleMsgId) {
      db.prepare(`
        UPDATE live_chat_messages 
        SET telegram_message_id = ? 
        WHERE id = ?
      `).run(teleMsgId, messageId);
    }
  } catch (err) {
    logger.warn(`[LiveChat] Gagal mengirim pesan ke Telegram: ${err.message}`);
  }

  return {
    id: messageId,
    session_id: session.session_id,
    sender_type: 'visitor',
    sender_name: name,
    message: cleanMsg,
    created_at: new Date().toISOString()
  };
}

/**
 * Ambil seluruh riwayat pesan untuk suatu sesi
 */
function getMessages(sessionId, sinceId = 0) {
  if (!sessionId) return [];

  const safeSince = parseInt(sinceId, 10) || 0;
  if (safeSince > 0) {
    return db.prepare(`
      SELECT id, session_id, sender_type, sender_name, message, is_read, created_at
      FROM live_chat_messages
      WHERE session_id = ? AND id > ?
      ORDER BY id ASC
    `).all(sessionId, safeSince);
  }

  return db.prepare(`
    SELECT id, session_id, sender_type, sender_name, message, is_read, created_at
    FROM live_chat_messages
    WHERE session_id = ?
    ORDER BY id ASC
  `).all(sessionId);
}

/**
 * Tandai pesan sudah dibaca
 */
function markMessagesRead(sessionId, senderType = 'admin') {
  if (!sessionId) return;
  db.prepare(`
    UPDATE live_chat_messages 
    SET is_read = 1 
    WHERE session_id = ? AND sender_type = ?
  `).run(sessionId, senderType);
}

/**
 * Ambil daftar sesi chat aktif untuk dashboard admin
 */
function getAllSessions(limit = 50) {
  return db.prepare(`
    SELECT s.*, 
      (SELECT message FROM live_chat_messages WHERE session_id = s.session_id ORDER BY id DESC LIMIT 1) as last_message,
      (SELECT COUNT(*) FROM live_chat_messages WHERE session_id = s.session_id AND sender_type = 'visitor' AND is_read = 0) as unread_count
    FROM live_chat_sessions s
    ORDER BY s.last_message_at DESC
    LIMIT ?
  `).all(limit);
}

/**
 * Tutup sesi chat (baik oleh pengunjung atau oleh admin di Telegram)
 */
async function closeSession(sessionId, closedBy = 'visitor') {
  if (!sessionId) return null;

  const session = db.prepare('SELECT * FROM live_chat_sessions WHERE session_id = ?').get(sessionId);
  if (!session) return null;

  // 1. Update status sesi menjadi closed
  db.prepare(`
    UPDATE live_chat_sessions 
    SET status = 'closed', last_message_at = datetime('now','localtime')
    WHERE session_id = ?
  `).run(sessionId);

  // 2. Tambah pesan sistem penutup
  const closeText = closedBy === 'admin'
    ? '✅ Sesi percakapan telah diselesaikan oleh Customer Service. Terima kasih telah menghubungi Juragan Pulsa.'
    : 'ℹ️ Anda telah mengakhiri sesi percakapan ini. Klik Mulai Chat Baru jika butuh bantuan kembali.';

  const info = db.prepare(`
    INSERT INTO live_chat_messages (
      session_id, sender_type, sender_name, message, is_read, created_at
    ) VALUES (?, 'system', 'Sistem', ?, 1, datetime('now','localtime'))
  `).run(sessionId, closeText);

  const closeMsg = {
    id: info.lastInsertRowid,
    session_id: sessionId,
    sender_type: 'system',
    sender_name: 'Sistem',
    message: closeText,
    is_closed: true,
    created_at: new Date().toISOString()
  };

  // 3. Notifikasi ke Telegram Admin jika ditutup oleh pengunjung
  if (closedBy === 'visitor') {
    try {
      const { chatId } = telegramService.getCredentials();
      if (chatId) {
        await telegramService.sendMessage(chatId, `ℹ️ <b>[LiveChat] Sesi Ditutup</b>\nPengunjung <b>${telegramService.escapeHtml(session.visitor_name || 'Pengunjung')}</b> telah mengakhiri sesi <code>${session.session_id}</code>.`);
      }
    } catch (_) {}
  }

  // 4. Emit event realtime
  telegramService.emit(`reply:${sessionId}`, closeMsg);
  telegramService.emit(`closed:${sessionId}`, { session_id: sessionId });

  return closeMsg;
}

module.exports = {
  generateSessionId,
  getOrCreateSession,
  sendVisitorMessage,
  getMessages,
  markMessagesRead,
  getAllSessions,
  closeSession,
};
