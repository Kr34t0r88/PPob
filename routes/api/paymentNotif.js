/**
 * Juragan Pulsa - Generic Payment Notification Webhook Router
 * routes/api/paymentNotif.js
 * 
 * Pengganti MacroDroid / Server Gateway Penangkap Notifikasi Bank & E-Wallet
 * Otomatis memverifikasi tiket deposit agen ketika notifikasi masuk di HP Admin
 */

'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../config/database');
const { approveDeposit } = require('../../services/depositService');
const { getAgentById } = require('../../services/agentService');
const { notifyDepositApproved } = require('../../services/whatsappService');
const { getSetting } = require('../../config/settingsManager');
const logger = require('../../utils/logger');

/**
 * Helper untuk mengekstrak nominal rupiah dari teks notifikasi
 */
function parseAmountFromText(text) {
  if (!text) return 0;
  const s = String(text).replace(/,/g, ''); // bersihkan koma jika ada

  // Pola 1: Rp 50.125 atau Rp. 50.125 atau Rp50.125 atau Rp7.643
  const rpMatch = /rp\.?\s*([0-9\.]+)/i.exec(s);
  if (rpMatch) {
    const clean = rpMatch[1].replace(/\./g, '');
    const num = parseInt(clean, 10);
    if (!isNaN(num) && num >= 100) return num;
  }

  // Pola 2: "sebesar 50.125" atau "nominal 50.125"
  const wordMatch = /(?:sebesar|nominal|jumlah|total|dana)\s*(?:rp\.?)?\s*([0-9\.]+)/i.exec(s);
  if (wordMatch) {
    const clean = wordMatch[1].replace(/\./g, '');
    const num = parseInt(clean, 10);
    if (!isNaN(num) && num >= 100) return num;
  }

  // Pola 3: Angka ribuan dengan titik (contoh 50.125 atau 100.025 atau 7.643)
  const dotMatch = /\b([0-9]{1,3}(?:\.[0-9]{3})+)\b/.exec(s);
  if (dotMatch) {
    const clean = dotMatch[1].replace(/\./g, '');
    const num = parseInt(clean, 10);
    if (!isNaN(num) && num >= 100) return num;
  }

  // Pola 4: Angka digit setelah kata terima / masuk / bayar
  const rawNumMatch = /(?:diterima|masuk|berhasil|bayar|transfer)\D+([0-9]{3,8})/i.exec(s);
  if (rawNumMatch) {
    const num = parseInt(rawNumMatch[1], 10);
    if (!isNaN(num) && num >= 100) return num;
  }

  return 0;
}

/**
 * POST /api/webhook/v1/payment-notif (dan /api/webhook/payment-notif)
 */
router.post(['/v1/payment-notif', '/payment-notif'], async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const body = req.body || {};

  const service = String(body.service || body.app || body.packageName || 'Unknown').trim();
  const title = String(body.title || '').trim();
  const content = String(body.content || body.text || '').trim();
  const fullText = `${title} ${content}`.trim();
  const secretKey = String(body.secret_key || req.headers['x-webhook-token'] || req.query.secret_key || '').trim();

  logger.info(`[Payment Gateway Webhook] Menerima notifikasi dari [${service}]: "${fullText.slice(0, 150)}"`);

  // Validasi Secret Key jika dikonfigurasi
  const expectedSecret = String(getSetting('payment_gateway_secret', 'juragan-pulsa-gateway-key')).trim();
  if (expectedSecret && secretKey && secretKey !== expectedSecret) {
    logger.warn(`[Payment Gateway Webhook] Secret key tidak valid dari ${ip}`);
    return res.status(403).json({ success: false, error: 'Invalid secret_key' });
  }

  if (!fullText) {
    return res.status(400).json({ success: false, error: 'Content notifikasi kosong' });
  }

  // Ekstrak nominal uang dari isi notifikasi
  const parsedAmount = parseAmountFromText(fullText);

  // Catat ke webhook_logs
  try {
    db.prepare(`
      INSERT INTO webhook_logs (provider, ref_id, status, signature_ok, payload, processed, ip)
      VALUES (?, ?, ?, 1, ?, 1, ?)
    `).run(
      service,
      parsedAmount ? String(parsedAmount) : 'NO_AMOUNT',
      parsedAmount ? 'amount_parsed' : 'unparsed',
      JSON.stringify(body),
      ip
    );
  } catch (_) {}

  if (!parsedAmount || parsedAmount < 100) {
    logger.info(`[Payment Gateway Webhook] Tidak ditemukan nominal valid pada teks: "${fullText.slice(0, 100)}"`);
    return res.json({
      success: true,
      matched: false,
      parsed_amount: 0,
      message: 'Notifikasi dicatat (tidak ditemukan nominal pembayaran yang cocok).'
    });
  }


  logger.info(`[Payment Gateway Webhook] Nominal terdeteksi: Rp ${parsedAmount.toLocaleString('id-ID')}. Mencari transaksi pending...`);

  // 1. Cek tiket deposit agen terlebih dahulu
  try {
    const deposit = db.prepare(`
      SELECT * FROM deposit_requests 
      WHERE amount = ? AND status = 'pending'
      ORDER BY created_at DESC 
      LIMIT 1
    `).get(parsedAmount);

    if (deposit) {
      // Ada tiket deposit agen cocok! Otomatis setujui (Approve) deposit agen
      logger.info(`[Payment Gateway Webhook] MATCH DEPOSIT! Menyetujui deposit #${deposit.id} (${deposit.deposit_code}) untuk Agen #${deposit.agent_id}`);
      const approved = approveDeposit(deposit.id, `Auto Gateway (${service})`, `Verifikasi Otomatis via ${service}`);

      // Dapatkan data agen dan kirim notifikasi WhatsApp
      const agent = getAgentById(deposit.agent_id);
      if (agent && agent.phone) {
        notifyDepositApproved(approved, agent).catch(() => {});
      }

      return res.json({
        success: true,
        matched: true,
        type: 'agent_deposit',
        deposit_id: deposit.id,
        deposit_code: deposit.deposit_code,
        amount: parsedAmount,
        agent_id: deposit.agent_id,
        agent_name: agent ? agent.name : '-',
        message: `Deposit ${deposit.deposit_code} sebesar Rp ${parsedAmount.toLocaleString('id-ID')} berhasil diverifikasi otomatis!`
      });
    }

    // 2. Jika bukan deposit agen, cek pesanan publik (Web Store / UniPin Style)
    const publicOrder = db.prepare(`
      SELECT * FROM public_orders 
      WHERE total_amount = ? AND status = 'pending' AND datetime('now','localtime') < expired_at
      ORDER BY created_at DESC 
      LIMIT 1
    `).get(parsedAmount);

    if (publicOrder) {
      logger.info(`[Payment Gateway Webhook] MATCH PUBLIC ORDER! Memproses pesanan publik invoice #${publicOrder.invoice_code} (${publicOrder.product_name})`);
      const publicOrderService = require('../../services/publicOrderService');
      const processedOrder = await publicOrderService.processPaymentSuccess(publicOrder.id, service);

      return res.json({
        success: true,
        matched: true,
        type: 'public_order',
        invoice_code: processedOrder.invoice_code,
        product_name: processedOrder.product_name,
        target: processedOrder.target_combined,
        amount: parsedAmount,
        status: processedOrder.status,
        sn: processedOrder.sn || '-',
        message: `Pesanan publik ${processedOrder.invoice_code} berhasil diverifikasi dan dikirim (${processedOrder.status})!`
      });
    }

    logger.info(`[Payment Gateway Webhook] Tidak ada deposit agen atau pesanan publik pending dengan nominal Rp ${parsedAmount.toLocaleString('id-ID')}`);
    return res.json({
      success: true,
      matched: false,
      parsed_amount: parsedAmount,
      message: `Nominal Rp ${parsedAmount.toLocaleString('id-ID')} terdeteksi, namun tidak ada deposit atau pesanan publik pending yang sesuai.`
    });
  } catch (err) {
    logger.error(`[Payment Gateway Webhook] Error memproses pembayaran: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/webhook/payment-notif/logs (Lihat log notifikasi gateway)
router.get(['/v1/payment-notif/logs', '/payment-notif/logs'], (req, res) => {
  try {
    const logs = db.prepare(`
      SELECT * FROM webhook_logs 
      WHERE provider NOT IN ('digiflazz') 
      ORDER BY created_at DESC 
      LIMIT 30
    `).all();

    return res.json({ success: true, data: logs });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
