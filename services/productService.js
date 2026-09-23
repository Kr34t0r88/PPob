/**
 * Juragan Pulsa - Product Service
 * services/productService.js
 */

const db = require('../config/database');
const { getProviderById, getAdapter, getDefaultProvider } = require('./providers/providerFactory');
const { getSetting } = require('../config/settingsManager');
const { paginate } = require('../utils/helpers');
const logger = require('../utils/logger');

/**
 * Sync products dari provider H2H ke local SQLite database
 * @param {number} providerId - Optional, default ke default provider
 */
async function syncProductsFromProvider(providerId) {
  const provider = providerId ? getProviderById(providerId) : getDefaultProvider();
  if (!provider) {
    throw new Error('Provider tidak ditemukan');
  }

  const adapter = getAdapter(provider.name);
  logger.info(`[Sync] Memulai sync produk dari provider: ${provider.label}`);

  const defaultMarkup = parseInt(getSetting('digiflazz_markup', '2000'), 10) || 2000;
  const defaultPublicMarkup = parseInt(getSetting('public_store_markup', '3000'), 10) || 3000;
  const products = await adapter.syncProducts(provider);

  let inserted = 0;
  let updated = 0;
  let active = 0;
  let inactive = 0;

  const stmtFind = db.prepare('SELECT id, markup, markup_public, price_sell, price_public, price_modal FROM products WHERE provider_id = ? AND sku = ?');
  const stmtInsert = db.prepare(`
    INSERT INTO products (
      provider_id, sku, product_name, category, brand,
      price_modal, price_sell, markup, price_public, markup_public, description, is_active, last_sync
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
  `);
  const stmtUpdate = db.prepare(`
    UPDATE products SET
      product_name = ?,
      category = ?,
      brand = ?,
      price_modal = ?,
      price_sell = ?,
      price_public = ?,
      is_active = ?,
      description = ?,
      last_sync = datetime('now','localtime')
    WHERE id = ?
  `);

  const syncTx = db.transaction((items) => {
    for (const item of items) {
      const existing = stmtFind.get(provider.id, item.sku);
      if (item.is_active) active++;
      else inactive++;

      if (existing) {
        // Keep existing custom markup if defined, otherwise default
        const currentMarkup = existing.markup > 0 ? existing.markup : defaultMarkup;
        const currentPubMarkup = existing.markup_public > 0 ? existing.markup_public : defaultPublicMarkup;
        const newSellPrice = item.price_modal + currentMarkup;
        const newPublicPrice = item.price_modal + currentPubMarkup;
        stmtUpdate.run(
          item.product_name,
          item.category || '',
          item.brand || '',
          item.price_modal,
          newSellPrice,
          newPublicPrice,
          item.is_active ? 1 : 0,
          item.description || '',
          existing.id
        );
        updated++;
      } else {
        const sellPrice = item.price_modal + defaultMarkup;
        const publicPrice = item.price_modal + defaultPublicMarkup;
        stmtInsert.run(
          provider.id,
          item.sku,
          item.product_name,
          item.category || '',
          item.brand || '',
          item.price_modal,
          sellPrice,
          defaultMarkup,
          publicPrice,
          defaultPublicMarkup,
          item.description || '',
          item.is_active ? 1 : 0
        );
        inserted++;
      }
    }
  });

  syncTx(products);

  // Catat log sync
  db.prepare(`
    INSERT INTO product_sync_logs (provider_id, total, inserted, updated, active, inactive)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(provider.id, products.length, inserted, updated, active, inactive);

  logger.info(`[Sync] Selesai: Total ${products.length} produk (${inserted} baru, ${updated} update, ${active} aktif)`);

  return {
    total: products.length,
    inserted,
    updated,
    active,
    inactive,
  };
}

/**
 * List products dengan filter dan pagination
 */
function listProducts({ q = '', category = '', brand = '', includeInactive = false, page = 1, limit = 50 } = {}) {
  const where = [];
  const params = [];

  if (!includeInactive) {
    where.push('p.is_active = 1');
  }

  if (q) {
    where.push('(p.sku LIKE ? OR p.product_name LIKE ? OR p.brand LIKE ? OR p.category LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }

  if (category) {
    where.push('p.category = ?');
    params.push(category);
  }

  if (brand) {
    where.push('p.brand = ?');
    params.push(brand);
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM products p ${whereClause}`).get(...params)?.cnt || 0;
  const pg = paginate(total, page, limit);

  const products = db.prepare(`
    SELECT p.*, pr.label as provider_name
    FROM products p
    JOIN providers pr ON pr.id = p.provider_id
    ${whereClause}
    ORDER BY p.category ASC, p.brand ASC, p.price_sell ASC
    LIMIT ? OFFSET ?
  `).all(...params, pg.limit, pg.offset);

  return { products, pagination: pg };
}

/**
 * List categories yang aktif
 */
function listCategories() {
  const rows = db.prepare(`
    SELECT category, COUNT(*) as product_count
    FROM products
    WHERE is_active = 1 AND category IS NOT NULL AND TRIM(category) <> ''
    GROUP BY category
    ORDER BY category ASC
  `).all();
  return rows;
}

/**
 * List brands berdasarkan category
 */
function listBrands(category = '') {
  let sql = `
    SELECT brand, COUNT(*) as product_count
    FROM products
    WHERE is_active = 1 AND brand IS NOT NULL AND TRIM(brand) <> ''
  `;
  const params = [];
  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  sql += ' GROUP BY brand ORDER BY brand ASC';
  return db.prepare(sql).all(...params);
}

/**
 * Cari produk by SKU
 */
function getProductBySku(sku, providerId = null) {
  let sql = `
    SELECT p.*, pr.name as provider_code, pr.label as provider_label
    FROM products p
    JOIN providers pr ON pr.id = p.provider_id
    WHERE p.sku = ?
  `;
  const params = [sku];
  if (providerId) {
    sql += ' AND p.provider_id = ?';
    params.push(providerId);
  }
  return db.prepare(sql).get(...params) || null;
}

/**
 * Update markup produk
 */
function setMarkup(sku, markup, providerId = null) {
  const safeMarkup = Math.max(0, parseInt(markup || 0, 10));
  const product = getProductBySku(sku, providerId);
  if (!product) throw new Error('Produk tidak ditemukan');

  const newSellPrice = product.price_modal + safeMarkup;
  db.prepare(`
    UPDATE products
    SET markup = ?, price_sell = ?
    WHERE id = ?
  `).run(safeMarkup, newSellPrice, product.id);

  return { ...product, markup: safeMarkup, price_sell: newSellPrice };
}

/**
 * Toggle status aktif produk
 */
function toggleProduct(sku, isActive, providerId = null) {
  const product = getProductBySku(sku, providerId);
  if (!product) throw new Error('Produk tidak ditemukan');

  const status = isActive ? 1 : 0;
  db.prepare('UPDATE products SET is_active = ? WHERE id = ?').run(status, product.id);
  return { ...product, is_active: status };
}

/**
 * Hitung harga jual untuk grup markup agen
 */
function calculateAgentPrice(product, agent) {
  let sellPrice = product.price_sell;
  if (!agent || !agent.markup_group || agent.markup_group === 'default') {
    return sellPrice;
  }

  const group = db.prepare('SELECT * FROM markup_groups WHERE name = ?').get(agent.markup_group);
  if (!group) return sellPrice;

  if (group.markup_flat) {
    sellPrice += group.markup_flat;
  }
  if (group.markup_pct) {
    sellPrice += Math.round(product.price_modal * (group.markup_pct / 100));
  }
  return sellPrice;
}

/**
 * Update markup harga publik produk
 */
function setPublicMarkup(sku, markup, providerId = null) {
  const safeMarkup = Math.max(0, parseInt(markup || 0, 10));
  const product = getProductBySku(sku, providerId);
  if (!product) throw new Error('Produk tidak ditemukan');

  const newPublicPrice = product.price_modal + safeMarkup;
  db.prepare(`
    UPDATE products
    SET markup_public = ?, price_public = ?
    WHERE id = ?
  `).run(safeMarkup, newPublicPrice, product.id);

  return { ...product, markup_public: safeMarkup, price_public: newPublicPrice };
}

/**
 * Terapkan default markup ke seluruh produk di tabel products (Harga Agen)
 * @param {number} markup
 */
function applyGlobalMarkup(markup) {
  const safeMarkup = Math.max(0, parseInt(markup || 0, 10));
  const res = db.prepare(`
    UPDATE products
    SET markup = ?, price_sell = price_modal + ?
  `).run(safeMarkup, safeMarkup);
  return res.changes;
}

/**
 * Terapkan default markup publik ke seluruh produk / kategori tertentu (Harga Publik)
 * @param {number} markup
 * @param {string} category
 */
function applyPublicMarkup(markup, category = '') {
  const safeMarkup = Math.max(0, parseInt(markup || 0, 10));
  let res;
  if (category) {
    res = db.prepare(`
      UPDATE products
      SET markup_public = ?, price_public = price_modal + ?
      WHERE category = ?
    `).run(safeMarkup, safeMarkup, category);
  } else {
    res = db.prepare(`
      UPDATE products
      SET markup_public = ?, price_public = price_modal + ?
    `).run(safeMarkup, safeMarkup);
  }
  return res.changes;
}

module.exports = {
  syncProductsFromProvider,
  listProducts,
  listCategories,
  listBrands,
  getProductBySku,
  setMarkup,
  setPublicMarkup,
  applyGlobalMarkup,
  applyPublicMarkup,
  toggleProduct,
  calculateAgentPrice,
};
