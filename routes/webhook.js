/**
 * Juragan Pulsa - Digiflazz Webhook Router
 * routes/webhook.js
 */

const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { getProviderById, getDefaultProvider } = require('../services/providers/providerFactory');
const { verifyWebhookSignature, normalizeStatus } = require('../services/providers/digiflazzAdapter');
const { processWebhookUpdate } = require('../services/transactionService');
const { getAgentById } = require('../services/agentService');
const { notifyTransactionSuccess } = require('../services/whatsappService');
const { getSetting } = require('../config/settingsManager');
const logger = require('../utils/logger');

router.get('/digiflazz', (req, res) => {
  res.json({ success: true, message: 'OK. Use POST for Digiflazz webhook.' });
});

router.head('/digiflazz', (req, res) => res.status(200).end());

router.post('/digiflazz', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const signatureHeader = req.headers['x-hub-signature'] || req.headers['x-digiflazz-delivery'] || '';
  const eventHeader = req.headers['x-digiflazz-event'] || '';
  const deliveryHeader = req.headers['x-digiflazz-delivery'] || '';
  const rawBody = req.rawBody || JSON.stringify(req.body);

  logger.info(`[Webhook] Menerima request dari ${ip}, event: ${eventHeader}, delivery: ${deliveryHeader}`);

  const provider = getDefaultProvider();
  const webhookSecret = (provider && provider.webhook_secret) || getSetting('digiflazz_webhook_secret', '');

  let signatureOk = 0;
  if (webhookSecret) {
    signatureOk = verifyWebhookSignature(rawBody, signatureHeader, webhookSecret) ? 1 : 0;
    if (!signatureOk) {
      logger.warn(`[Webhook] Signature verification GAGAL untuk IP: ${ip}`);
      // Catat log
      db.prepare(`
        INSERT INTO webhook_logs (provider, ref_id, status, signature_ok, payload, processed, ip)
        VALUES ('digiflazz', '', 'signature_failed', 0, ?, 0, ?)
      `).run(rawBody, ip);

      return res.status(401).json({ success: false, error: 'Invalid HMAC signature' });
    }
  } else {
    logger.warn('[Webhook] Webhook secret belum diset di provider/settings, melewatinya...');
    signatureOk = 1;
  }

  let payload = {};
  try {
    payload = typeof req.body === 'object' && Object.keys(req.body).length > 0
      ? req.body
      : JSON.parse(rawBody);
  } catch (err) {
    logger.error('[Webhook] Gagal parsing JSON payload:', err);
    return res.status(400).json({ success: false, error: 'Invalid JSON' });
  }

  const data = payload.data || payload;

  // Handle Webhook Registration Ping dari Digiflazz
  if (data.sed !== undefined && !data.ref_id) {
    logger.info('[Webhook] Ping terdeteksi dari Digiflazz registration');
    return res.status(200).json({ success: true, message: 'Ping OK' });
  }

  const refId = String(data.ref_id || '').trim();
  const vendorStatus = String(data.status || '').trim();
  const normalizedStatus = normalizeStatus(vendorStatus);
  const sn = String(data.sn || '').trim();
  const message = String(data.message || '').trim();
  const trxId = String(data.trx_id || '').trim();

  logger.info(`[Webhook] Update payload: RefID=${refId}, VendorStatus=${vendorStatus} (${normalizedStatus}), SN=${sn}`);

  // Catat webhook log
  db.prepare(`
    INSERT INTO webhook_logs (provider, ref_id, status, signature_ok, payload, processed, ip)
    VALUES ('digiflazz', ?, ?, ?, ?, 1, ?)
  `).run(refId, normalizedStatus, signatureOk, JSON.stringify(payload), ip);

  if (!refId) {
    return res.status(200).json({ success: true, message: 'No ref_id found in payload' });
  }

  // Update status transaksi
  try {
    const updatedTx = processWebhookUpdate({
      refId,
      status: normalizedStatus,
      sn,
      message,
      trxId,
      rawPayload: payload,
    });

    if (updatedTx && updatedTx.status === 'success' && updatedTx.agent_id) {
      const agent = getAgentById(updatedTx.agent_id);
      if (agent) {
        notifyTransactionSuccess(updatedTx, agent).catch(() => {});
      }
    }

    return res.status(200).json({ success: true, status: normalizedStatus });
  } catch (err) {
    logger.error('[Webhook] Gagal memproses update transaksi:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
