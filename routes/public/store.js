/**
 * Juragan Pulsa - Public Storefront & Top-Up Controller
 * routes/public/store.js
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const db = require('../../config/database');
const { getSetting } = require('../../config/settingsManager');
const { createPublicOrder, getOrderByInvoice, recheckPublicOrder } = require('../../services/publicOrderService');
const qrisUtil = require('../../utils/qrisUtil');
const { formatRupiah, formatDateTime, formatWaNumber } = require('../../utils/helpers');
const logger = require('../../utils/logger');

/**
 * GET / - Public Storefront Home (UniPin Style)
 */
router.get('/', (req, res) => {
  const rawEnabled = getSetting('public_store_enabled', '1');
  const isEnabled = rawEnabled === true || rawEnabled === '1' || rawEnabled === 1 || rawEnabled === 'true';
  const indexView = path.join(__dirname, '../../views/public/index.ejs');

  // Fallback: Jika toko publik dinonaktifkan di admin atau file view tidak ada
  if (!isEnabled || !fs.existsSync(indexView)) {
    if (req.session && req.session.adminId) {
      return res.redirect('/admin/dashboard');
    }
    return res.redirect('/login');
  }

  const rawCsWa = getSetting('public_cs_whatsapp', getSetting('app_phone', '081947215703'));
  const csWhatsapp = rawCsWa || '081947215703';
  const csWhatsappFormatted = formatWaNumber(csWhatsapp);

  const storeSettings = {
    enabled: isEnabled,
    name: getSetting('public_store_name', getSetting('app_name', 'Juragan Topup')),
    tagline: getSetting('public_store_tagline', 'Top Up Game, Pulsa & Token PLN 24 Jam Otomatis'),
    logo: getSetting('public_store_logo', ''),
    themeColor: getSetting('public_theme_color', 'blue'),
    announcement: getSetting('public_store_announcement', '⚡ Layanan Top-Up & Pembayaran Otomatis 24 Jam Nonstop! Tanpa Antri & Tanpa Ribet.'),
    banner1: getSetting('public_banner_1', ''),
    banner2: getSetting('public_banner_2', ''),
    banner3: getSetting('public_banner_3', ''),
    csWhatsapp,
    csWhatsappFormatted,
    csTelegram: getSetting('public_cs_telegram', ''),
    showApkDownload: getSetting('public_show_apk_download', '1') === '1' || getSetting('public_show_apk_download', true) === true,
    appDownloadUrl: getSetting('app_download_url', '/downloads/juragan-pulsa.apk'),
  };


  // Ambil semua produk aktif dengan harga publik dan harga agen
  const products = db.prepare(`
    SELECT sku, product_name, category, brand, price_modal,
           COALESCE(NULLIF(price_sell, 0), price_modal + 2000) AS price_agent,
           COALESCE(NULLIF(price_sell, 0), price_modal + 2000) AS price_sell,
           COALESCE(NULLIF(price_public, 0), price_modal + COALESCE(NULLIF(markup_public, 0), 3000), price_sell, price_modal + 3000) AS price_public,
           description, is_active
    FROM products
    WHERE is_active = 1
    ORDER BY category ASC, brand ASC, price_public ASC
  `).all();

  // Kelompokkan produk berdasarkan kategori dan brand
  const catalog = {};
  const categories = [];

  products.forEach(p => {
    const cat = p.category || 'Lainnya';
    if (!catalog[cat]) {
      catalog[cat] = {};
      categories.push(cat);
    }
    const brand = p.brand || 'Umum';
    if (!catalog[cat][brand]) {
      catalog[cat][brand] = [];
    }
    catalog[cat][brand].push(p);
  });

  // Game populer untuk slider/grid
  const gameBrands = catalog['Game'] ? Object.keys(catalog['Game']) : [];

  res.render('public/index', {
    title: `${storeSettings.name} - ${storeSettings.tagline}`,
    store: storeSettings,
    catalog,
    categories,
    gameBrands,
    productsJson: JSON.stringify(products),
    formatRupiah,
    formatDateTime
  });
});

/**
 * GET /invoice/:invoiceCode & GET /order/:invoiceCode - Halaman Invoice & QRIS
 */
router.get(['/invoice/:invoiceCode', '/order/:invoiceCode'], async (req, res) => {
  const { invoiceCode } = req.params;
  const order = getOrderByInvoice(invoiceCode);

  if (!order) {
    return res.status(404).render('error', {
      title: 'Invoice Tidak Ditemukan',
      message: `Pesanan dengan nomor invoice ${invoiceCode} tidak ditemukan atau telah dihapus.`,
      code: 404
    });
  }

  const rawCsWa = getSetting('public_cs_whatsapp', getSetting('app_phone', '081947215703'));
  const csWhatsapp = rawCsWa || '081947215703';
  const csWhatsappFormatted = formatWaNumber(csWhatsapp);

  const storeSettings = {
    name: getSetting('public_store_name', getSetting('app_name', 'Juragan Topup')),
    logo: getSetting('public_store_logo', ''),
    csWhatsapp,
    csWhatsappFormatted,
    themeColor: getSetting('public_theme_color', 'blue'),
  };


  let qrImage = '';
  if (order.status === 'pending') {
    try {
      const qrisStaticPayload = String(getSetting('qris_static_payload', '')).trim();
      const qrRes = await qrisUtil.generateDynamicQrisDataUrl(qrisStaticPayload, order.total_amount);
      qrImage = qrRes.dataUrl;
    } catch (err) {
      logger.error(`[Invoice] Gagal generate QRIS: ${err.message}`);
    }
  }

  const invoiceView = path.join(__dirname, '../../views/public/invoice.ejs');
  if (!fs.existsSync(invoiceView)) {
    return res.status(200).send(`
      <!DOCTYPE html>
      <html lang="id">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Invoice ${order.invoice_code}</title>
        <style>body{font-family:sans-serif;padding:30px;text-align:center;background:#0f172a;color:#f8fafc;} .box{background:#1e293b;padding:24px;border-radius:12px;display:inline-block;max-width:400px;text-align:left;}</style>
      </head>
      <body>
        <div class="box">
          <h2 style="margin-top:0;">Invoice: ${order.invoice_code}</h2>
          <p><strong>Status:</strong> ${order.status.toUpperCase()}</p>
          <p><strong>Produk:</strong> ${order.product_name}</p>
          <p><strong>Tujuan:</strong> ${order.target_combined}</p>
          <p><strong>Total:</strong> ${formatRupiah(order.total_amount)}</p>
          ${order.sn ? `<p><strong>SN / Token:</strong> <code>${order.sn}</code></p>` : ''}
          <hr style="border-color:#334155;margin:16px 0;">
          <a href="/login" style="color:#38bdf8;text-decoration:none;">&larr; Masuk ke Halaman Utama</a>
        </div>
      </body>
      </html>
    `);
  }

  res.render('public/invoice', {
    title: `Invoice ${order.invoice_code} - ${storeSettings.name}`,
    order,
    qrImage,
    store: storeSettings,
    formatRupiah,
    formatDateTime
  });
});

/**
 * POST /api/public/order - Buat pesanan baru
 */
router.post('/api/public/order', async (req, res) => {
  try {
    const { sku, target_id, target_zone, buyer_phone, buyer_email } = req.body;

    if (!sku || !target_id) {
      return res.status(400).json({
        success: false,
        error: 'Pilih produk dan masukkan nomor tujuan / User ID game dengan benar'
      });
    }

    const order = await createPublicOrder({
      sku,
      targetId: target_id,
      targetZone: target_zone,
      buyerPhone: buyer_phone,
      buyerEmail: buyer_email
    });

    return res.json({
      success: true,
      invoice_code: order.invoice_code,
      redirect_url: `/invoice/${order.invoice_code}`,
      order: {
        invoice_code: order.invoice_code,
        product_name: order.product_name,
        target: order.target_combined,
        total_amount: order.total_amount,
        expired_at: order.expired_at,
        qr_image: order.qr_image
      }
    });
  } catch (err) {
    logger.error(`[PublicStore] Gagal membuat order: ${err.message}`);
    return res.status(400).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /api/public/order/:invoiceCode/status - Polling Status Pesanan
 */
router.get('/api/public/order/:invoiceCode/status', (req, res) => {
  const { invoiceCode } = req.params;
  const order = getOrderByInvoice(invoiceCode);

  if (!order) {
    return res.status(404).json({ success: false, error: 'Invoice tidak ditemukan' });
  }

  return res.json({
    success: true,
    invoice_code: order.invoice_code,
    status: order.status,
    sn: order.sn || '',
    message: order.message || '',
    total_amount: order.total_amount,
    paid_at: order.paid_at,
    completed_at: order.completed_at,
    expired_at: order.expired_at
  });
});

/**
 * POST /api/public/order/:invoiceCode/recheck - Cek Ulang Status ke Vendor
 */
router.post('/api/public/order/:invoiceCode/recheck', async (req, res) => {
  const { invoiceCode } = req.params;
  const order = getOrderByInvoice(invoiceCode);

  if (!order) {
    return res.status(404).json({ success: false, error: 'Invoice tidak ditemukan' });
  }

  try {
    const updated = await recheckPublicOrder(order.id);
    return res.json({
      success: true,
      status: updated.status,
      sn: updated.sn || '',
      message: updated.message || ''
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /pricelist, /daftar-harga, /harga - Halaman Tabel Daftar Harga Agen & Mitra
 */
router.get(['/pricelist', '/daftar-harga', '/harga'], (req, res) => {
  const isEnabled = getSetting('public_store_enabled', '1') === '1' || getSetting('public_store_enabled', true) === true;
  const rawCsWa = getSetting('public_cs_whatsapp', getSetting('app_phone', '081947215703'));
  const csWhatsapp = rawCsWa || '081947215703';
  const csWhatsappFormatted = formatWaNumber(csWhatsapp);

  const storeSettings = {
    enabled: isEnabled,
    name: getSetting('public_store_name', getSetting('app_name', 'Juragan Pulsa')),
    tagline: getSetting('public_store_tagline', 'Top Up Game, Pulsa & Token PLN 24 Jam Otomatis'),
    logo: getSetting('public_store_logo', ''),
    themeColor: getSetting('public_theme_color', 'blue'),
    csWhatsapp,
    csWhatsappFormatted,
    csTelegram: getSetting('public_cs_telegram', ''),
    showApkDownload: getSetting('public_show_apk_download', '1') === '1' || getSetting('public_show_apk_download', true) === true,
    appDownloadUrl: getSetting('app_download_url', '/downloads/juragan-pulsa.apk'),
  };

  const products = db.prepare(`
    SELECT sku, product_name, category, brand, price_modal,
           COALESCE(NULLIF(price_sell, 0), price_modal + 2000) AS price_agent,
           COALESCE(NULLIF(price_sell, 0), price_modal + 2000) AS price_sell,
           COALESCE(NULLIF(price_public, 0), price_modal + COALESCE(NULLIF(markup_public, 0), 3000), price_sell, price_modal + 3000) AS price_public,
           description, is_active
    FROM products
    WHERE is_active = 1
    ORDER BY category ASC, brand ASC, price_agent ASC
  `).all();

  const categories = [...new Set(products.map(p => p.category).filter(Boolean))];
  const brands = [...new Set(products.map(p => p.brand).filter(Boolean))];

  res.render('public/pricelist', {
    title: `Daftar Harga Agen & Mitra - ${storeSettings.name}`,
    store: storeSettings,
    categories,
    brands,
    products,
    productsJson: JSON.stringify(products),
    formatRupiah,
    formatDateTime
  });
});

/**
 * GET /api/public/products - List katalog produk untuk client-side search
 */
router.get('/api/public/products', (req, res) => {
  const products = db.prepare(`
    SELECT sku, product_name, category, brand, price_public, description
    FROM products
    WHERE is_active = 1
    ORDER BY category ASC, brand ASC, price_public ASC
  `).all();

  return res.json({ success: true, data: products });
});

module.exports = router;