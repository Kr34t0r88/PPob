/**
 * Juragan Pulsa - Cron Scheduler Service
 * services/cronService.js
 */

const cron = require('node-cron');
const db = require('../config/database');
const { syncProductsFromProvider } = require('./productService');
const { checkTransactionStatus } = require('./transactionService');
const { getActiveProviders } = require('./providers/providerFactory');
const logger = require('../utils/logger');

let cronInitialized = false;

function startCronJobs() {
  if (cronInitialized) return;
  cronInitialized = true;

  logger.info('[Cron] Menginisialisasi scheduled tasks...');

  // 1. Cek Transaksi Pending (Setiap 3 Menit)
  // Cek transaksi pending yang berumur > 1 menit dan < 24 jam
  cron.schedule('*/3 * * * *', async () => {
    try {
      const pendingTxs = db.prepare(`
        SELECT id, ref_id, created_at
        FROM transactions
        WHERE status = 'pending'
          AND created_at <= datetime('now', 'localtime', '-1 minute')
          AND created_at >= datetime('now', 'localtime', '-24 hours')
        LIMIT 20
      `).all();

      if (pendingTxs.length > 0) {
        logger.info(`[Cron] Memeriksa status ${pendingTxs.length} transaksi pending...`);
        for (const tx of pendingTxs) {
          try {
            await checkTransactionStatus(tx.id);
          } catch (err) {
            logger.warn(`[Cron] Gagal cek status transaksi #${tx.id} (${tx.ref_id}): ${err.message}`);
          }
        }
      }

      // Expire public orders yang telah lewat batas 15 menit
      try {
        const { expireOldPendingOrders } = require('./publicOrderService');
        const expiredCount = expireOldPendingOrders();
        if (expiredCount > 0) {
          logger.info(`[Cron] ${expiredCount} pesanan publik kedaluwarsa dibatalkan.`);
        }
      } catch (_) {}
    } catch (err) {
      logger.error('[Cron] Error checking pending transactions:', err);
    }
  });

  // 2. Sync Produk Otomatis dari Provider Default (Setiap 6 Jam)
  cron.schedule('0 */6 * * *', async () => {
    try {
      const providers = getActiveProviders();
      for (const prov of providers) {
        if (prov.username && prov.api_key) {
          logger.info(`[Cron] Auto-sync produk untuk provider: ${prov.label}`);
          await syncProductsFromProvider(prov.id);
        }
      }
    } catch (err) {
      logger.error('[Cron] Error auto-syncing products:', err);
    }
  });

  // 3. Daily Housekeeping / Log Cleanup & Vacuum (Setiap Hari Pukul 02:00)
  cron.schedule('0 2 * * *', () => {
    try {
      logger.info('[Cron] Menjalankan daily cleanup log & database maintenance...');
      
      // Hapus audit trail > 90 hari
      const deletedAudit = db.prepare("DELETE FROM audit_trail WHERE created_at < datetime('now', 'localtime', '-90 days')").run();
      // Hapus webhook logs > 30 hari
      const deletedWebhook = db.prepare("DELETE FROM webhook_logs WHERE created_at < datetime('now', 'localtime', '-30 days')").run();
      // Hapus sync logs > 30 hari
      const deletedSync = db.prepare("DELETE FROM product_sync_logs WHERE created_at < datetime('now', 'localtime', '-30 days')").run();

      logger.info(`[Cron] Cleanup selesai: ${deletedAudit.changes} audit logs, ${deletedWebhook.changes} webhook logs, ${deletedSync.changes} sync logs dihapus.`);
    } catch (err) {
      logger.error('[Cron] Error daily cleanup:', err);
    }
  });

  logger.info('✅ [Cron] Semua scheduler aktif');
}

module.exports = {
  startCronJobs,
};
