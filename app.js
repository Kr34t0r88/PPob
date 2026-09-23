require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { generalLimiter } = require('./middleware/rateLimit');
const logger = require('./utils/logger');

// ── Inisialisasi database (harus sebelum apapun) ──────────────────────────────
const db = require('./config/database');

// ── Inisialisasi WhatsApp Bot (Baileys) ───────────────────────────────────────
// Di-load setelah DB agar bisa baca settings
let whatsappService;
try {
  whatsappService = require('./services/whatsappService');
} catch (e) {
  logger.warn('WhatsApp service tidak dapat dimuat:', e.message);
}

// ── Inisialisasi Express ───────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 5000;

// ── View Engine ───────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── Static Files ──────────────────────────────────────────────────────────────
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));
app.use('/downloads', express.static(path.join(__dirname, 'public', 'downloads')));

// ── Raw body untuk webhook (HARUS sebelum json parser) ───────────────────────
// Simpan raw body di req.rawBody untuk verifikasi HMAC webhook
app.use('/webhook', (req, res, next) => {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    next();
  });
});

// ── Body Parser ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// ── Session ───────────────────────────────────────────────────────────────────
const { getSetting } = require('./config/settingsManager');
const sessionSecret = process.env.SESSION_SECRET ||
  getSetting('session_secret', crypto.randomBytes(32).toString('hex'));

app.use(session({
  name: 'juragan.sid',
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000 // 24 jam
  }
}));

// ── Rate Limiter Global ────────────────────────────────────────────────────────
app.use(generalLimiter);

// ── CSRF Protection untuk form POST ───────────────────────────────────────────
// Skip untuk: webhook, API (pakai token auth)
const CSRF_EXEMPT_PATHS = ['/webhook', '/api/'];
app.use((req, res, next) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const isExempt = CSRF_EXEMPT_PATHS.some(p => req.path.startsWith(p));
    if (!isExempt) {
      const origin = req.headers['origin'] || '';
      const referer = req.headers['referer'] || '';
      const host = req.headers['host'] || '';
      const appUrl = process.env.APP_URL || `http://${host}`;

      const isOriginOk = !origin || origin.startsWith(appUrl) ||
        origin.includes(host);
      const isRefererOk = !referer || referer.startsWith(appUrl) ||
        referer.includes(host);

      if (!isOriginOk && !isRefererOk) {
        logger.warn(`CSRF check failed: origin=${origin}, referer=${referer}`);
        return res.status(403).json({ success: false, error: 'Akses ditolak (CSRF)' });
      }
    }
  }
  next();
});

// ── Local Variables untuk EJS ──────────────────────────────────────────────────
const { formatRupiah, formatDateTime, formatDate } = require('./utils/helpers');

app.use((req, res, next) => {
  res.locals.appName = getSetting('app_name', process.env.APP_NAME || 'Juragan Pulsa');
  res.locals.appVersion = '1.0.0';
  res.locals.currentPath = req.path;
  res.locals.adminUser = req.session?.adminUser || null;
  res.locals.flashMessage = req.session?.flash || null;
  res.locals.formatRupiah = formatRupiah;
  res.locals.formatDateTime = formatDateTime;
  res.locals.formatDate = formatDate;

  try {
    const digi = db.prepare("SELECT balance, balance_updated_at FROM providers WHERE name = 'digiflazz' LIMIT 1").get();
    res.locals.digiBalance = digi ? (digi.balance || 0) : 0;
    res.locals.digiBalanceUpdated = digi ? digi.balance_updated_at : null;
  } catch (_) {
    res.locals.digiBalance = 0;
    res.locals.digiBalanceUpdated = null;
  }

  if (req.session?.flash) delete req.session.flash;
  next();
});

// ── Helper untuk flash message ─────────────────────────────────────────────────
app.use((req, res, next) => {
  res.flash = (type, message) => {
    req.session.flash = { type, message };
  };
  next();
});

// ── Routes: Admin Dashboard & Auth ──────────────────────────────────────────
const adminAuthRouter = require('./routes/admin/auth');
const adminDashboardRouter = require('./routes/admin/dashboard');
const adminAgentsRouter = require('./routes/admin/agents');
const adminTransactionsRouter = require('./routes/admin/transactions');
const adminPublicOrdersRouter = require('./routes/admin/publicOrders');
const adminProductsRouter = require('./routes/admin/products');
const adminProvidersRouter = require('./routes/admin/providers');
const adminDepositsRouter = require('./routes/admin/deposits');
const adminReportsRouter = require('./routes/admin/reports');
const adminSettingsRouter = require('./routes/admin/settings');

// Admin Auth (Dukungan /login dan /admin/login)
app.use('/', adminAuthRouter);
app.use('/admin', adminAuthRouter);
app.use('/admin', adminDashboardRouter);
app.use('/admin', adminAgentsRouter);
app.use('/admin', adminTransactionsRouter);
app.use('/admin', adminPublicOrdersRouter);
app.use('/admin', adminProductsRouter);
app.use('/admin', adminProvidersRouter);
app.use('/admin', adminDepositsRouter);
app.use('/admin', adminReportsRouter);
app.use('/admin', adminSettingsRouter);

// ── Routes: REST API untuk Agent & Admin App ─────────────────────────────────
const apiAuthRouter = require('./routes/api/auth');
const apiAdminRouter = require('./routes/api/admin');
const apiProductsRouter = require('./routes/api/products');
const apiTransactionsRouter = require('./routes/api/transactions');
const apiBalanceRouter = require('./routes/api/balance');
const paymentNotifRouter = require('./routes/api/paymentNotif');
const appVersionRouter = require('./routes/api/appVersion');

app.use('/api/auth', apiAuthRouter);
app.use('/api/admin', apiAdminRouter);
app.use('/api/products', apiProductsRouter);
app.use('/api/transactions', apiTransactionsRouter);
app.use('/api/balance', apiBalanceRouter);
app.use('/api/webhook', paymentNotifRouter);
app.use('/api/app', appVersionRouter);

// ── Routes: Public Live Chat (Telegram Bridge) ──────────────────────────────
const publicLiveChatRouter = require('./routes/public/livechat');
app.use('/api/public/livechat', publicLiveChatRouter);

// ── Routes: Public Agent Registration (Daftar Mandiri) ──────────────────────
const publicRegisterRouter = require('./routes/public/register');
app.use('/', publicRegisterRouter);

// ── Routes: Webhook ────────────────────────────────────────────────────────────
const webhookRouter = require('./routes/webhook');
app.use('/webhook', webhookRouter);

// ── Routes: Web Publik Direct Top-Up (Root URL '/') ─────────────────────────
try {
  const publicStoreRouter = require('./routes/public/store');
  app.use('/', publicStoreRouter);
} catch (e) {
  logger.warn('Public store router tidak tersedia, menggunakan fallback route:', e.message);
  app.get('/', (req, res) => {
    if (req.session && req.session.adminId) return res.redirect('/admin/dashboard');
    return res.redirect('/login');
  });
}

// ── 404 Handler ────────────────────────────────────────────────────────────────
app.use((req, res) => {
  const isApi = req.path.startsWith('/api/') || req.headers['accept'] === 'application/json';
  if (isApi) {
    return res.status(404).json({ success: false, error: 'Endpoint tidak ditemukan' });
  }
  const errorView = path.join(__dirname, 'views', 'error.ejs');
  if (fs.existsSync(errorView)) {
    return res.status(404).render('error', {
      title: '404 - Halaman Tidak Ditemukan',
      message: 'Halaman yang Anda cari tidak ditemukan.',
      code: 404
    });
  }
  return res.status(404).send('<h1>404 Not Found</h1><p><a href="/login">Ke Halaman Login</a></p>');
});

// ── Global Error Handler ───────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  const isApi = req.path.startsWith('/api/') || req.headers['accept'] === 'application/json';
  if (isApi) {
    return res.status(500).json({ success: false, error: 'Terjadi kesalahan server' });
  }
  const errorView = path.join(__dirname, 'views', 'error.ejs');
  if (fs.existsSync(errorView)) {
    return res.status(500).render('error', {
      title: '500 - Server Error',
      message: process.env.NODE_ENV === 'development' ? err.message : 'Terjadi kesalahan server.',
      code: 500
    });
  }
  return res.status(500).send('<h1>500 Server Error</h1><p><a href="/login">Ke Halaman Login</a></p>');
});

// ── Pastikan folder uploads & downloads tersedia ──────────────────────────────
const uploadDirs = [
  path.join(__dirname, 'public', 'uploads'),
  path.join(__dirname, 'public', 'uploads', 'deposits'),
  path.join(__dirname, 'public', 'uploads', 'qris'),
  path.join(__dirname, 'public', 'downloads'),
  path.join(__dirname, 'logs'),
];
uploadDirs.forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ── Start Server ───────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  logger.info(`  🚀 Juragan Pulsa Server v1.0.0`);
  logger.info(`  📡 Port    : ${PORT}`);
  logger.info(`  🌐 URL     : http://localhost:${PORT}`);
  logger.info(`  🔧 Mode    : ${process.env.NODE_ENV || 'development'}`);
  logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  // Start cron jobs setelah server ready
  try {
    const { startCronJobs } = require('./services/cronService');
    startCronJobs();
    logger.info('✅ Cron jobs aktif');
  } catch (e) {
    logger.warn('⚠️  Cron jobs gagal dimuat:', e.message);
  }

  // Start WhatsApp bot jika dikonfigurasi
  if (whatsappService && typeof whatsappService.startBot === 'function') {
    const waEnabled = getSetting('whatsapp_enabled', '0');
    if (waEnabled === '1' || waEnabled === true) {
      whatsappService.startBot().catch(e => {
        logger.warn('WhatsApp bot gagal start:', e.message);
      });
    }
  }

  // Start Telegram bot polling untuk Live Chat jika aktif
  try {
    const telegramService = require('./services/telegramService');
    telegramService.startPolling();
  } catch (e) {
    logger.warn('⚠️ Telegram bot polling gagal dimuat:', e.message);
  }

  logger.info(`  📋 Admin  : http://localhost:${PORT}/admin`);
  logger.info(`  🔌 API    : http://localhost:${PORT}/api`);
});

module.exports = app;
