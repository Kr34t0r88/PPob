/**
 * Juragan Pulsa - Public Live Chat API & SSE Stream Router
 * routes/public/livechat.js
 */

'use strict';

const express = require('express');
const router = express.Router();
const { getOrCreateSession, sendVisitorMessage, getMessages, markMessagesRead } = require('../../services/liveChatService');
const telegramService = require('../../services/telegramService');
const { getSetting } = require('../../config/settingsManager');
const logger = require('../../utils/logger');

/**
 * POST /api/public/livechat/init
 * Inisialisasi sesi baru atau ambil sesi tersimpan
 */
router.post('/init', (req, res) => {
  try {
    const { session_id, visitor_name, visitor_phone } = req.body;
    const ip = req.ip || req.connection.remoteAddress;
    const ua = req.headers['user-agent'] || '';

    const session = getOrCreateSession({
      sessionId: session_id,
      visitorName: visitor_name,
      visitorPhone: visitor_phone,
      ipAddress: ip,
      userAgent: ua
    });

    const messages = getMessages(session.session_id);
    const rawTeleEnabled = getSetting('telegram_livechat_enabled', '0');
    const isLiveChatEnabled = rawTeleEnabled === true || rawTeleEnabled === '1' || rawTeleEnabled === 1 || rawTeleEnabled === 'true';

    return res.json({
      success: true,
      session_id: session.session_id,
      visitor_name: session.visitor_name,
      is_enabled: isLiveChatEnabled,
      messages
    });
  } catch (err) {
    logger.error(`[LiveChat API] Init error: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/public/livechat/send
 * Kirim pesan chat dari pengunjung
 */
router.post('/send', async (req, res) => {
  try {
    const { session_id, message, visitor_name, visitor_phone } = req.body;
    const ip = req.ip || req.connection.remoteAddress;
    const ua = req.headers['user-agent'] || '';

    if (!message || !String(message).trim()) {
      return res.status(400).json({ success: false, error: 'Pesan tidak boleh kosong' });
    }

    const savedMsg = await sendVisitorMessage({
      sessionId: session_id,
      message: String(message).trim(),
      visitorName: visitor_name,
      visitorPhone: visitor_phone,
      ipAddress: ip,
      userAgent: ua
    });

    return res.json({
      success: true,
      message: savedMsg
    });
  } catch (err) {
    logger.error(`[LiveChat API] Send message error: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/public/livechat/messages
 * Polling pesan terbaru (fallback untuk browser yang tidak mendukung SSE)
 */
router.get('/messages', (req, res) => {
  try {
    const { session_id, since_id } = req.query;
    if (!session_id) {
      return res.status(400).json({ success: false, error: 'session_id wajib diisi' });
    }

    const messages = getMessages(session_id, since_id);
    return res.json({
      success: true,
      messages
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/public/livechat/read
 * Tandai pesan admin sebagai sudah dibaca pengunjung
 */
router.post('/read', (req, res) => {
  try {
    const { session_id } = req.body;
    if (session_id) {
      markMessagesRead(session_id, 'admin');
    }
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/public/livechat/close
 * Pengunjung mengakhiri sesi chat
 */
router.post('/close', async (req, res) => {
  try {
    const { session_id } = req.body;
    const { closeSession } = require('../../services/liveChatService');
    const result = await closeSession(session_id, 'visitor');
    return res.json({ success: true, message: result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/public/livechat/stream
 * Server-Sent Events (SSE) stream untuk menerima balasan instan dari Telegram
 */
router.get('/stream', (req, res) => {
  const { session_id } = req.query;
  if (!session_id) {
    return res.status(400).end('session_id required');
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Kirim initial connection message
  res.write(`data: ${JSON.stringify({ type: 'connected', session_id })}\n\n`);

  // Handler saat ada balasan admin via Telegram
  const onReply = (newMsg) => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'message', message: newMsg })}\n\n`);
    } catch (_) {}
  };

  const eventName = `reply:${session_id}`;
  telegramService.on(eventName, onReply);

  // Heartbeat ping setiap 15 detik agar koneksi tetap hidup
  const pingInterval = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (_) {}
  }, 15000);

  req.on('close', () => {
    clearInterval(pingInterval);
    telegramService.removeListener(eventName, onReply);
  });
});

module.exports = router;
