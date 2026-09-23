/**
 * Juragan Pulsa - Database Initialization (SQLite WAL)
 * config/database.js
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'database', 'juragan-pulsa.db');

// Pastikan folder database tersedia
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);

// ── Pragma & Performance ───────────────────────────────────────────────────────
db.pragma('journal_mode = WAL');
db.pragma('cache_size = -65536');       // 64 MB
db.pragma('mmap_size = 134217728');     // 128 MB
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');
db.pragma('temp_store = MEMORY');
db.pragma('busy_timeout = 5000');

// ── Custom function NOW_LOCAL() ───────────────────────────────────────────────
db.function('NOW_LOCAL', () => {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ` +
         `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
});

// ── Schema ─────────────────────────────────────────────────────────────────────
db.exec(`
  -- Settings (konfigurasi dinamis)
  CREATE TABLE IF NOT EXISTS settings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    key        TEXT NOT NULL UNIQUE,
    value      TEXT,
    type       TEXT DEFAULT 'string',
    updated_at DATETIME DEFAULT (datetime('now','localtime'))
  );

  -- Admins
  CREATE TABLE IF NOT EXISTS admins (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT NOT NULL UNIQUE,
    password   TEXT NOT NULL,
    name       TEXT NOT NULL,
    role       TEXT DEFAULT 'admin',
    is_active  INTEGER DEFAULT 1,
    last_login DATETIME,
    api_token  TEXT UNIQUE,
    created_at DATETIME DEFAULT (datetime('now','localtime'))
  );

  -- Providers H2H
  CREATE TABLE IF NOT EXISTS providers (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT NOT NULL UNIQUE,
    label              TEXT NOT NULL,
    api_url            TEXT NOT NULL DEFAULT 'https://api.digiflazz.com/v1',
    username           TEXT DEFAULT '',
    api_key            TEXT DEFAULT '',
    webhook_secret     TEXT DEFAULT '',
    is_active          INTEGER DEFAULT 1,
    is_default         INTEGER DEFAULT 0,
    balance            REAL DEFAULT 0,
    balance_updated_at DATETIME,
    config             TEXT DEFAULT '{}',
    created_at         DATETIME DEFAULT (datetime('now','localtime'))
  );

  -- Products (cache dari provider)
  CREATE TABLE IF NOT EXISTS products (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id  INTEGER NOT NULL REFERENCES providers(id),
    sku          TEXT NOT NULL,
    product_name TEXT NOT NULL,
    category     TEXT NOT NULL DEFAULT '',
    brand        TEXT DEFAULT '',
    price_modal  INTEGER NOT NULL DEFAULT 0,
    price_sell   INTEGER NOT NULL DEFAULT 0,
    markup       INTEGER DEFAULT 0,
    price_public INTEGER NOT NULL DEFAULT 0,
    markup_public INTEGER DEFAULT 0,
    description  TEXT DEFAULT '',
    is_active    INTEGER DEFAULT 1,
    last_sync    DATETIME,
    created_at   DATETIME DEFAULT (datetime('now','localtime')),
    UNIQUE(provider_id, sku)
  );

  -- Markup Groups (grup harga per agen)
  CREATE TABLE IF NOT EXISTS markup_groups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    label       TEXT NOT NULL,
    markup_flat INTEGER DEFAULT 0,
    markup_pct  REAL DEFAULT 0,
    created_at  DATETIME DEFAULT (datetime('now','localtime'))
  );

  -- Agents (agen pulsa)
  CREATE TABLE IF NOT EXISTS agents (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    username     TEXT NOT NULL UNIQUE,
    password     TEXT NOT NULL,
    name         TEXT NOT NULL,
    phone        TEXT NOT NULL,
    email        TEXT DEFAULT '',
    address      TEXT DEFAULT '',
    balance      REAL DEFAULT 0,
    markup_group TEXT DEFAULT 'default',
    pin          TEXT DEFAULT '',
    is_active    INTEGER DEFAULT 1,
    last_login   DATETIME,
    api_token    TEXT UNIQUE,
    created_at   DATETIME DEFAULT (datetime('now','localtime'))
  );

  -- Transactions (transaksi pulsa)
  CREATE TABLE IF NOT EXISTS transactions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id          INTEGER REFERENCES agents(id),
    provider_id       INTEGER REFERENCES providers(id),
    ref_id            TEXT NOT NULL UNIQUE,
    provider_ref_id   TEXT DEFAULT '',
    product_sku       TEXT NOT NULL,
    product_name      TEXT DEFAULT '',
    category          TEXT DEFAULT '',
    brand             TEXT DEFAULT '',
    target            TEXT NOT NULL,
    price_modal       INTEGER NOT NULL DEFAULT 0,
    price_sell        INTEGER NOT NULL DEFAULT 0,
    profit            INTEGER DEFAULT 0,
    status            TEXT DEFAULT 'pending',
    sn                TEXT DEFAULT '',
    message           TEXT DEFAULT '',
    provider_response TEXT DEFAULT '{}',
    is_refunded       INTEGER DEFAULT 0,
    channel           TEXT DEFAULT 'app',
    created_at        DATETIME DEFAULT (datetime('now','localtime')),
    updated_at        DATETIME DEFAULT (datetime('now','localtime'))
  );

  -- Public Orders (Transaksi Pembeli Publik Tanpa Akun / UniPin Style)
  CREATE TABLE IF NOT EXISTS public_orders (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_code     TEXT NOT NULL UNIQUE,
    provider_id      INTEGER REFERENCES providers(id),
    product_sku      TEXT NOT NULL,
    product_name     TEXT NOT NULL,
    category         TEXT NOT NULL,
    brand            TEXT DEFAULT '',
    target_id        TEXT NOT NULL,
    target_zone      TEXT DEFAULT '',
    target_combined  TEXT NOT NULL,
    buyer_phone      TEXT DEFAULT '',
    buyer_email      TEXT DEFAULT '',
    price_modal      INTEGER NOT NULL DEFAULT 0,
    price_public     INTEGER NOT NULL DEFAULT 0,
    unique_code      INTEGER NOT NULL DEFAULT 0,
    total_amount     INTEGER NOT NULL,
    payment_method   TEXT DEFAULT 'QRIS',
    qris_payload     TEXT DEFAULT '',
    status           TEXT DEFAULT 'pending', -- pending, paid, processing, success, failed, expired
    sn               TEXT DEFAULT '',
    provider_ref_id  TEXT DEFAULT '',
    message          TEXT DEFAULT '',
    wa_notif_sent    INTEGER DEFAULT 0,
    paid_at          DATETIME,
    completed_at     DATETIME,
    expired_at       DATETIME,
    created_at       DATETIME DEFAULT (datetime('now','localtime')),
    updated_at       DATETIME DEFAULT (datetime('now','localtime'))
  );

  -- Balance Mutations (riwayat perubahan saldo)
  CREATE TABLE IF NOT EXISTS balance_mutations (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id       INTEGER NOT NULL REFERENCES agents(id),
    type           TEXT NOT NULL,
    amount         REAL NOT NULL,
    balance_before REAL NOT NULL,
    balance_after  REAL NOT NULL,
    ref_id         TEXT DEFAULT '',
    notes          TEXT DEFAULT '',
    created_by     TEXT DEFAULT '',
    created_at     DATETIME DEFAULT (datetime('now','localtime'))
  );

  -- Deposit Requests
  CREATE TABLE IF NOT EXISTS deposit_requests (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id     INTEGER NOT NULL REFERENCES agents(id),
    amount       REAL NOT NULL,
    deposit_code TEXT NOT NULL UNIQUE,
    transfer_to  TEXT DEFAULT '',
    bank_name    TEXT DEFAULT '',
    proof_image  TEXT DEFAULT '',
    status       TEXT DEFAULT 'pending',
    notes        TEXT DEFAULT '',
    reviewed_by  TEXT DEFAULT '',
    reviewed_at  DATETIME,
    created_at   DATETIME DEFAULT (datetime('now','localtime'))
  );

  -- Bank Accounts (rekening terima deposit)
  CREATE TABLE IF NOT EXISTS bank_accounts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_name      TEXT NOT NULL,
    account_number TEXT NOT NULL,
    account_name   TEXT NOT NULL,
    qris_image     TEXT DEFAULT '',
    is_active      INTEGER DEFAULT 1,
    created_at     DATETIME DEFAULT (datetime('now','localtime'))
  );

  -- Webhook Logs
  CREATE TABLE IF NOT EXISTS webhook_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    provider     TEXT NOT NULL DEFAULT '',
    ref_id       TEXT DEFAULT '',
    status       TEXT DEFAULT '',
    signature_ok INTEGER DEFAULT 0,
    payload      TEXT DEFAULT '{}',
    processed    INTEGER DEFAULT 0,
    ip           TEXT DEFAULT '',
    created_at   DATETIME DEFAULT (datetime('now','localtime'))
  );

  -- Product Sync Logs
  CREATE TABLE IF NOT EXISTS product_sync_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id INTEGER REFERENCES providers(id),
    total       INTEGER DEFAULT 0,
    inserted    INTEGER DEFAULT 0,
    updated     INTEGER DEFAULT 0,
    active      INTEGER DEFAULT 0,
    inactive    INTEGER DEFAULT 0,
    error_msg   TEXT DEFAULT '',
    created_at  DATETIME DEFAULT (datetime('now','localtime'))
  );

  -- Audit Trail
  CREATE TABLE IF NOT EXISTS audit_trail (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT DEFAULT '',
    user_role  TEXT DEFAULT '',
    action     TEXT NOT NULL,
    table_name TEXT DEFAULT '',
    record_id  INTEGER,
    old_value  TEXT DEFAULT '',
    new_value  TEXT DEFAULT '',
    ip_address TEXT DEFAULT '',
    status     TEXT DEFAULT 'success',
    notes      TEXT DEFAULT '',
    created_at DATETIME DEFAULT (datetime('now','localtime'))
  );

  -- Live Chat Sessions (Sesi Pengunjung Web Live Chat)
  CREATE TABLE IF NOT EXISTS live_chat_sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL UNIQUE,
    visitor_name    TEXT DEFAULT 'Pengunjung Web',
    visitor_phone   TEXT DEFAULT '',
    ip_address      TEXT DEFAULT '',
    user_agent      TEXT DEFAULT '',
    status          TEXT DEFAULT 'active',
    last_message_at DATETIME DEFAULT (datetime('now','localtime')),
    created_at      DATETIME DEFAULT (datetime('now','localtime'))
  );

  -- Live Chat Messages (Pesan Chat Pengunjung <-> Admin Telegram)
  CREATE TABLE IF NOT EXISTS live_chat_messages (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id          TEXT NOT NULL REFERENCES live_chat_sessions(session_id),
    sender_type         TEXT NOT NULL, -- 'visitor', 'admin', 'system'
    sender_name         TEXT DEFAULT '',
    message             TEXT NOT NULL,
    telegram_message_id INTEGER DEFAULT NULL,
    is_read             INTEGER DEFAULT 0,
    created_at          DATETIME DEFAULT (datetime('now','localtime'))
  );
`);

// ── Indexes & Migrations ──────────────────────────────────────────────────────
try {
  db.exec("ALTER TABLE admins ADD COLUMN api_token TEXT");
} catch (_) {}

try {
  db.exec("ALTER TABLE products ADD COLUMN price_public INTEGER NOT NULL DEFAULT 0");
} catch (_) {}

try {
  db.exec("ALTER TABLE products ADD COLUMN markup_public INTEGER DEFAULT 0");
} catch (_) {}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_transactions_agent     ON transactions(agent_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_transactions_status    ON transactions(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_transactions_ref       ON transactions(ref_id);
  CREATE INDEX IF NOT EXISTS idx_transactions_date      ON transactions(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_balance_mut_agent      ON balance_mutations(agent_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_products_category      ON products(category, brand, is_active);
  CREATE INDEX IF NOT EXISTS idx_products_sku           ON products(sku, is_active);
  CREATE INDEX IF NOT EXISTS idx_deposit_req_agent      ON deposit_requests(agent_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_deposit_req_status     ON deposit_requests(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_deposit_req_code       ON deposit_requests(deposit_code);
  CREATE INDEX IF NOT EXISTS idx_audit_action           ON audit_trail(action, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_pub_orders_invoice     ON public_orders(invoice_code);
  CREATE INDEX IF NOT EXISTS idx_pub_orders_amount      ON public_orders(total_amount, status);
  CREATE INDEX IF NOT EXISTS idx_pub_orders_status      ON public_orders(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_livechat_msg_session   ON live_chat_messages(session_id, created_at ASC);
  CREATE INDEX IF NOT EXISTS idx_livechat_msg_tele_id   ON live_chat_messages(telegram_message_id);
  CREATE INDEX IF NOT EXISTS idx_livechat_sess_id       ON live_chat_sessions(session_id);
`);

// ── Seed Data Awal ─────────────────────────────────────────────────────────────
function seed() {
  // Default markup group
  const hasGroup = db.prepare('SELECT 1 FROM markup_groups WHERE name = ?').get('default');
  if (!hasGroup) {
    db.prepare(`
      INSERT INTO markup_groups (name, label, markup_flat, markup_pct) VALUES
      ('default',  'Standar',   2000, 0),
      ('reseller', 'Reseller',  1500, 0),
      ('platinum', 'Platinum',  1000, 0)
    `).run();
  }

  // Default provider Digiflazz
  const hasProvider = db.prepare('SELECT 1 FROM providers WHERE name = ?').get('digiflazz');
  if (!hasProvider) {
    db.prepare(`
      INSERT INTO providers (name, label, api_url, is_active, is_default)
      VALUES ('digiflazz', 'Digiflazz', 'https://api.digiflazz.com/v1', 1, 1)
    `).run();
  }

  // Default admin
  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
  const adminName = process.env.ADMIN_NAME || 'Administrator';
  const hasAdmin = db.prepare('SELECT 1 FROM admins WHERE username = ?').get(adminUser);
  if (!hasAdmin) {
    const hash = bcrypt.hashSync(adminPass, 10);
    db.prepare('INSERT INTO admins (username, password, name, role) VALUES (?, ?, ?, ?)').run(
      adminUser, hash, adminName, 'admin'
    );
  }

  // Default settings
  const defaultSettings = [
    ['app_name',                  'Juragan Pulsa',  'string'],
    ['app_phone',                 '',               'string'],
    ['app_address',               '',               'string'],
    ['session_secret',            require('crypto').randomBytes(32).toString('hex'), 'string'],
    ['whatsapp_enabled',          '0',              'boolean'],
    ['whatsapp_admin_numbers',    '',               'string'],
    ['qris_static_enabled',       '1',              'boolean'],
    ['qris_static_payload',       '00020101021126570011ID.DANA.WWW011893600915346519740402094651974040303UMI51440014ID.CO.QRIS.WWW0215ID10232708012520303UMI5204549953033605802ID5907ALIJAYA6014Kab. Indramayu6105452576304E962', 'string'],
    ['digiflazz_username',        '',               'string'],
    ['digiflazz_api_key',         '',               'string'],
    ['digiflazz_webhook_secret',  '',               'string'],
    ['digiflazz_markup',          '2000',           'number'],
    ['deposit_min_amount',        '10000',          'number'],
    ['deposit_code_digits',       '3',              'number'],
    ['public_store_enabled',      '1',              'boolean'],
    ['public_store_name',         'Juragan Topup',  'string'],
    ['public_store_tagline',      'Top Up Game, Pulsa & Token PLN 24 Jam Otomatis', 'string'],
    ['public_store_logo',         '',               'string'],
    ['public_theme_color',        'blue',           'string'],
    ['public_store_markup',       '3000',           'number'],
    ['public_store_announcement', '⚡ Layanan Top-Up & Pembayaran Otomatis 24 Jam Nonstop! Tanpa Antri & Tanpa Ribet.', 'string'],
    ['public_banner_1',           '',               'string'],
    ['public_banner_2',           '',               'string'],
    ['public_banner_3',           '',               'string'],
    ['public_cs_whatsapp',        '',               'string'],
    ['public_cs_telegram',        '',               'string'],
    ['public_show_apk_download',  '1',              'boolean'],
    ['public_qris_expiry_minutes','15',             'number'],
    ['telegram_bot_token',        '',               'string'],
    ['telegram_chat_id',          '',               'string'],
    ['telegram_livechat_enabled', '0',              'boolean'],
    ['livechat_welcome_message',  'Halo! Selamat datang di Juragan Pulsa. Ada yang bisa kami bantu?', 'string'],
  ];

  const upsertSetting = db.prepare(`
    INSERT INTO settings (key, value, type) VALUES (?, ?, ?)
    ON CONFLICT(key) DO NOTHING
  `);
  const insertMany = db.transaction((rows) => {
    for (const row of rows) upsertSetting.run(...row);
  });
  insertMany(defaultSettings);

  // Pastikan kolom price_public pada seluruh produk terisi
  try {
    const pubMarkup = 3000;
    db.prepare(`
      UPDATE products 
      SET markup_public = ?, price_public = price_modal + ? 
      WHERE price_public IS NULL OR price_public = 0 OR markup_public IS NULL OR markup_public = 0
    `).run(pubMarkup, pubMarkup);
  } catch (_) {}

  // Sync Digiflazz provider credentials from settings if provider credentials are empty
  const digiUser = db.prepare("SELECT value FROM settings WHERE key = 'digiflazz_username'").get()?.value || '';
  const digiKey = db.prepare("SELECT value FROM settings WHERE key = 'digiflazz_api_key'").get()?.value || '';
  const digiSec = db.prepare("SELECT value FROM settings WHERE key = 'digiflazz_webhook_secret'").get()?.value || '';
  if (digiUser || digiKey) {
    db.prepare(`
      UPDATE providers SET
        username = CASE WHEN (username IS NULL OR username = '') THEN ? ELSE username END,
        api_key = CASE WHEN (api_key IS NULL OR api_key = '') THEN ? ELSE api_key END,
        webhook_secret = CASE WHEN (webhook_secret IS NULL OR webhook_secret = '') THEN ? ELSE webhook_secret END
      WHERE name = 'digiflazz'
    `).run(digiUser, digiKey, digiSec);
  }

  // Default Catalog Products jika tabel products masih kosong
  const productCount = db.prepare('SELECT COUNT(*) as count FROM products').get()?.count || 0;
  if (productCount === 0) {
    const provider = db.prepare('SELECT id FROM providers WHERE is_default = 1 LIMIT 1').get() || { id: 1 };
    const initialProducts = [
      // ── PULSA TELKOMSEL ─────────────────────────────────────────────
      [provider.id, 'S5', 'Telkomsel 5.000', 'Pulsa', 'Telkomsel', 5250, 6500, 1250, 'Pulsa Reguler Telkomsel 5.000', 1],
      [provider.id, 'S10', 'Telkomsel 10.000', 'Pulsa', 'Telkomsel', 10250, 11500, 1250, 'Pulsa Reguler Telkomsel 10.000', 1],
      [provider.id, 'S15', 'Telkomsel 15.000', 'Pulsa', 'Telkomsel', 15150, 16500, 1350, 'Pulsa Reguler Telkomsel 15.000', 1],
      [provider.id, 'S20', 'Telkomsel 20.000', 'Pulsa', 'Telkomsel', 20100, 21500, 1400, 'Pulsa Reguler Telkomsel 20.000', 1],
      [provider.id, 'S25', 'Telkomsel 25.000', 'Pulsa', 'Telkomsel', 25050, 26500, 1450, 'Pulsa Reguler Telkomsel 25.000', 1],
      [provider.id, 'S50', 'Telkomsel 50.000', 'Pulsa', 'Telkomsel', 49800, 51500, 1700, 'Pulsa Reguler Telkomsel 50.000', 1],
      [provider.id, 'S100', 'Telkomsel 100.000', 'Pulsa', 'Telkomsel', 98500, 101000, 2500, 'Pulsa Reguler Telkomsel 100.000', 1],

      // ── PULSA INDOSAT ───────────────────────────────────────────────
      [provider.id, 'I5', 'Indosat 5.000', 'Pulsa', 'Indosat', 5650, 6500, 850, 'Pulsa Reguler Indosat 5.000', 1],
      [provider.id, 'I10', 'Indosat 10.000', 'Pulsa', 'Indosat', 10650, 11500, 850, 'Pulsa Reguler Indosat 10.000', 1],
      [provider.id, 'I25', 'Indosat 25.000', 'Pulsa', 'Indosat', 25100, 26500, 1400, 'Pulsa Reguler Indosat 25.000', 1],
      [provider.id, 'I50', 'Indosat 50.000', 'Pulsa', 'Indosat', 49500, 51500, 2000, 'Pulsa Reguler Indosat 50.000', 1],
      [provider.id, 'I100', 'Indosat 100.000', 'Pulsa', 'Indosat', 98000, 101000, 3000, 'Pulsa Reguler Indosat 100.000', 1],

      // ── PULSA XL ───────────────────────────────────────────────────
      [provider.id, 'X5', 'XL 5.000', 'Pulsa', 'XL', 5700, 6500, 800, 'Pulsa Reguler XL 5.000', 1],
      [provider.id, 'X10', 'XL 10.000', 'Pulsa', 'XL', 10700, 11500, 800, 'Pulsa Reguler XL 10.000', 1],
      [provider.id, 'X25', 'XL 25.000', 'Pulsa', 'XL', 25150, 26500, 1350, 'Pulsa Reguler XL 25.000', 1],
      [provider.id, 'X50', 'XL 50.000', 'Pulsa', 'XL', 49600, 51500, 1900, 'Pulsa Reguler XL 50.000', 1],
      [provider.id, 'X100', 'XL 100.000', 'Pulsa', 'XL', 98200, 101000, 2800, 'Pulsa Reguler XL 100.000', 1],

      // ── PULSA AXIS ─────────────────────────────────────────────────
      [provider.id, 'AX5', 'Axis 5.000', 'Pulsa', 'Axis', 5700, 6500, 800, 'Pulsa Reguler Axis 5.000', 1],
      [provider.id, 'AX10', 'Axis 10.000', 'Pulsa', 'Axis', 10700, 11500, 800, 'Pulsa Reguler Axis 10.000', 1],
      [provider.id, 'AX25', 'Axis 25.000', 'Pulsa', 'Axis', 25150, 26500, 1350, 'Pulsa Reguler Axis 25.000', 1],
      [provider.id, 'AX50', 'Axis 50.000', 'Pulsa', 'Axis', 49600, 51500, 1900, 'Pulsa Reguler Axis 50.000', 1],

      // ── PULSA TRI ──────────────────────────────────────────────────
      [provider.id, 'T5', 'Tri 5.000', 'Pulsa', 'Tri', 5100, 6500, 1400, 'Pulsa Reguler Tri 5.000', 1],
      [provider.id, 'T10', 'Tri 10.000', 'Pulsa', 'Tri', 10100, 11500, 1400, 'Pulsa Reguler Tri 10.000', 1],
      [provider.id, 'T20', 'Tri 20.000', 'Pulsa', 'Tri', 19900, 21500, 1600, 'Pulsa Reguler Tri 20.000', 1],
      [provider.id, 'T50', 'Tri 50.000', 'Pulsa', 'Tri', 49400, 51500, 2100, 'Pulsa Reguler Tri 50.000', 1],
      [provider.id, 'T100', 'Tri 100.000', 'Pulsa', 'Tri', 98000, 101000, 3000, 'Pulsa Reguler Tri 100.000', 1],

      // ── PULSA SMARTFREN ────────────────────────────────────────────
      [provider.id, 'SM5', 'Smartfren 5.000', 'Pulsa', 'Smartfren', 5100, 6500, 1400, 'Pulsa Reguler Smartfren 5.000', 1],
      [provider.id, 'SM10', 'Smartfren 10.000', 'Pulsa', 'Smartfren', 10100, 11500, 1400, 'Pulsa Reguler Smartfren 10.000', 1],
      [provider.id, 'SM20', 'Smartfren 20.000', 'Pulsa', 'Smartfren', 19900, 21500, 1600, 'Pulsa Reguler Smartfren 20.000', 1],
      [provider.id, 'SM50', 'Smartfren 50.000', 'Pulsa', 'Smartfren', 49300, 51500, 2200, 'Pulsa Reguler Smartfren 50.000', 1],
      [provider.id, 'SM100', 'Smartfren 100.000', 'Pulsa', 'Smartfren', 98000, 101000, 3000, 'Pulsa Reguler Smartfren 100.000', 1],

      // ── PLN TOKEN LISTRIK & PASCABAYAR ─────────────────────────────
      [provider.id, 'PLN20', 'Token PLN 20.000', 'PLN', 'PLN', 20100, 21500, 1400, 'Token Listrik Prabayar PLN 20.000', 1],
      [provider.id, 'PLN50', 'Token PLN 50.000', 'PLN', 'PLN', 50100, 51500, 1400, 'Token Listrik Prabayar PLN 50.000', 1],
      [provider.id, 'PLN100', 'Token PLN 100.000', 'PLN', 'PLN', 100100, 101500, 1400, 'Token Listrik Prabayar PLN 100.000', 1],
      [provider.id, 'PLN200', 'Token PLN 200.000', 'PLN', 'PLN', 200100, 201500, 1400, 'Token Listrik Prabayar PLN 200.000', 1],
      [provider.id, 'PLN500', 'Token PLN 500.000', 'PLN', 'PLN', 500100, 501500, 1400, 'Token Listrik Prabayar PLN 500.000', 1],
      [provider.id, 'PLN1000', 'Token PLN 1.000.000', 'PLN', 'PLN', 1000100, 1001500, 1400, 'Token Listrik Prabayar PLN 1.000.000', 1],
      [provider.id, 'PLNPASCA', 'Tagihan Listrik PLN Pasca', 'PLN', 'PLN', 2500, 3000, 500, 'Cek & Bayar Tagihan Listrik Bulanan', 1],

      // ── PAKET DATA INTERNET ────────────────────────────────────────
      [provider.id, 'TD1', 'Telkomsel Data 1 GB 30 Hari', 'Data', 'Telkomsel', 14500, 16500, 2000, 'Kuota Utama 1GB Semua Jaringan 24 Jam', 1],
      [provider.id, 'TD3', 'Telkomsel Data 3 GB 30 Hari', 'Data', 'Telkomsel', 27000, 30000, 3000, 'Kuota Utama 3GB Semua Jaringan 24 Jam', 1],
      [provider.id, 'TD5', 'Telkomsel Data 5 GB 30 Hari', 'Data', 'Telkomsel', 41000, 45000, 4000, 'Kuota Utama 5GB Semua Jaringan 24 Jam', 1],
      [provider.id, 'TD10', 'Telkomsel Data 10 GB 30 Hari', 'Data', 'Telkomsel', 63000, 68000, 5000, 'Kuota Utama 10GB Semua Jaringan 24 Jam', 1],
      [provider.id, 'ID1', 'Indosat Freedom 1.5 GB 30 Hari', 'Data', 'Indosat', 12000, 14000, 2000, 'Freedom Internet 1.5GB 30 Hari', 1],
      [provider.id, 'ID3', 'Indosat Freedom 3 GB 30 Hari', 'Data', 'Indosat', 24500, 27500, 3000, 'Freedom Internet 3GB 30 Hari', 1],
      [provider.id, 'ID5', 'Indosat Freedom 5 GB 30 Hari', 'Data', 'Indosat', 36000, 40000, 4000, 'Freedom Internet 5GB 30 Hari', 1],
      [provider.id, 'XD2', 'XL Xtra Combo 2 GB 30 Hari', 'Data', 'XL', 17500, 20000, 2500, 'Xtra Combo Mini 2GB 30 Hari', 1],
      [provider.id, 'XD5', 'XL Xtra Combo 5 GB 30 Hari', 'Data', 'XL', 37000, 41000, 4000, 'Xtra Combo Mini 5GB 30 Hari', 1],

      // ── E-MONEY & DOMPET DIGITAL ───────────────────────────────────
      [provider.id, 'DANA10', 'DANA 10.000', 'E-Money', 'DANA', 10300, 11500, 1200, 'Top Up Saldo DANA 10.000', 1],
      [provider.id, 'DANA20', 'DANA 20.000', 'E-Money', 'DANA', 20300, 21500, 1200, 'Top Up Saldo DANA 20.000', 1],
      [provider.id, 'DANA50', 'DANA 50.000', 'E-Money', 'DANA', 50300, 51500, 1200, 'Top Up Saldo DANA 50.000', 1],
      [provider.id, 'DANA100', 'DANA 100.000', 'E-Money', 'DANA', 100300, 102000, 1700, 'Top Up Saldo DANA 100.000', 1],
      [provider.id, 'GOPAY10', 'GoPay 10.000', 'E-Money', 'GoPay', 10300, 11500, 1200, 'Top Up Saldo GoPay Pengguna 10.000', 1],
      [provider.id, 'GOPAY20', 'GoPay 20.000', 'E-Money', 'GoPay', 20300, 21500, 1200, 'Top Up Saldo GoPay Pengguna 20.000', 1],
      [provider.id, 'GOPAY50', 'GoPay 50.000', 'E-Money', 'GoPay', 50300, 51500, 1200, 'Top Up Saldo GoPay Pengguna 50.000', 1],
      [provider.id, 'OVO10', 'OVO 10.000', 'E-Money', 'OVO', 10500, 11500, 1000, 'Top Up Saldo OVO 10.000', 1],
      [provider.id, 'OVO20', 'OVO 20.000', 'E-Money', 'OVO', 20500, 21500, 1000, 'Top Up Saldo OVO 20.000', 1],
      [provider.id, 'OVO50', 'OVO 50.000', 'E-Money', 'OVO', 50500, 51500, 1000, 'Top Up Saldo OVO 50.000', 1],
      [provider.id, 'SPAY10', 'ShopeePay 10.000', 'E-Money', 'ShopeePay', 10300, 11500, 1200, 'Top Up Saldo ShopeePay 10.000', 1],
      [provider.id, 'SPAY20', 'ShopeePay 20.000', 'E-Money', 'ShopeePay', 20300, 21500, 1200, 'Top Up Saldo ShopeePay 20.000', 1],
      [provider.id, 'SPAY50', 'ShopeePay 50.000', 'E-Money', 'ShopeePay', 50300, 51500, 1200, 'Top Up Saldo ShopeePay 50.000', 1],

      // ── GAME VOUCHER ───────────────────────────────────────────────
      [provider.id, 'ML50', 'Mobile Legends 50 Diamonds', 'Game', 'Mobile Legends', 13500, 15000, 1500, '50 Diamonds Fast Delivery (ID+Server)', 1],
      [provider.id, 'ML86', 'Mobile Legends 86 Diamonds', 'Game', 'Mobile Legends', 20500, 23000, 2500, '86 Diamonds Fast Delivery (ID+Server)', 1],
      [provider.id, 'ML172', 'Mobile Legends 172 Diamonds', 'Game', 'Mobile Legends', 40500, 44000, 3500, '172 Diamonds Fast Delivery (ID+Server)', 1],
      [provider.id, 'FF50', 'Free Fire 50 Diamonds', 'Game', 'Free Fire', 6800, 8000, 1200, '50 Diamonds Fast Delivery (ID)', 1],
      [provider.id, 'FF70', 'Free Fire 70 Diamonds', 'Game', 'Free Fire', 9500, 11000, 1500, '70 Diamonds Fast Delivery (ID)', 1],
      [provider.id, 'FF140', 'Free Fire 140 Diamonds', 'Game', 'Free Fire', 18500, 21000, 2500, '140 Diamonds Fast Delivery (ID)', 1],
    ];

    const insertProduct = db.prepare(`
      INSERT INTO products (
        provider_id, sku, product_name, category, brand,
        price_modal, price_sell, markup, description, is_active, last_sync
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
      ON CONFLICT(provider_id, sku) DO NOTHING
    `);

    const insertAllProducts = db.transaction((items) => {
      for (const item of items) insertProduct.run(...item);
    });
    insertAllProducts(initialProducts);
  }
}

seed();

module.exports = db;
