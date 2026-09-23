/**
 * Juragan Pulsa - Admin Products Router
 * routes/admin/products.js
 */

const express = require('express');
const router = express.Router();
const {
  listProducts,
  listCategories,
  listBrands,
  syncProductsFromProvider,
  setMarkup,
  toggleProduct
} = require('../../services/productService');
const { getActiveProviders } = require('../../services/providers/providerFactory');
const { requireAdminLogin } = require('../../middleware/adminAuth');
const { formatRupiah, formatDateTime } = require('../../utils/helpers');

// GET /admin/products
router.get('/products', requireAdminLogin, (req, res) => {
  const { category = '', brand = '', q = '', status = '', page = 1 } = req.query;

  const result = listProducts({
    category,
    brand,
    q,
    includeInactive: status === 'inactive' ? true : (status === 'all' ? true : false),
    page: parseInt(page, 10) || 1,
    limit: 25,
  });

  const categories = listCategories();
  const brands = listBrands(category);
  const providers = getActiveProviders();

  res.render('admin/products', {
    title: 'Manajemen Produk & Harga',
    activeNav: 'products',
    products: result.products,
    pagination: result.pagination,
    categories,
    brands,
    providers,
    filter: { category, brand, q, status },
    formatRupiah,
    formatDateTime,
  });
});

// POST /admin/products/sync
router.post('/products/sync', requireAdminLogin, async (req, res) => {
  const { provider_id } = req.body;
  try {
    const syncRes = await syncProductsFromProvider(provider_id ? parseInt(provider_id, 10) : null);
    req.session.flash = {
      type: 'success',
      message: `Sinkronisasi produk berhasil: Total ${syncRes.total} (${syncRes.inserted} baru, ${syncRes.updated} update, ${syncRes.active} aktif).`
    };
  } catch (err) {
    req.session.flash = { type: 'error', message: `Gagal sinkronisasi produk: ${err.message}` };
  }
  res.redirect('/admin/products');
});

// POST /admin/products/:sku/markup (Harga Agen)
router.post(['/products/:sku/markup', '/admin/products/:sku/markup'], requireAdminLogin, (req, res) => {
  const { markup } = req.body;
  try {
    const { setMarkup } = require('../../services/productService');
    setMarkup(req.params.sku, markup);
    req.session.flash = { type: 'success', message: `Markup Agen SKU ${req.params.sku} berhasil diperbarui.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin/products');
});

// POST /admin/products/:sku/public-markup (Harga Publik)
router.post(['/products/:sku/public-markup', '/admin/products/:sku/public-markup'], requireAdminLogin, (req, res) => {
  const { markup_public } = req.body;
  try {
    const { setPublicMarkup } = require('../../services/productService');
    setPublicMarkup(req.params.sku, markup_public);
    req.session.flash = { type: 'success', message: `Markup Publik SKU ${req.params.sku} berhasil diperbarui.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin/products');
});

// POST /admin/products/:sku/toggle
router.post(['/products/:sku/toggle', '/admin/products/:sku/toggle'], requireAdminLogin, (req, res) => {
  const { is_active } = req.body;
  try {
    const { toggleProduct } = require('../../services/productService');
    toggleProduct(req.params.sku, is_active === '1');
    req.session.flash = { type: 'success', message: `Status SKU ${req.params.sku} berhasil diubah.` };
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin/products');
});

// POST /admin/products/bulk-markup (Update margin agen massal)
router.post(['/products/bulk-markup', '/admin/products/bulk-markup'], requireAdminLogin, (req, res) => {
  const { markup, category, target_type } = req.body;
  const safeMarkup = Math.max(0, parseInt(markup || 0, 10));
  const { applyGlobalMarkup, applyPublicMarkup } = require('../../services/productService');
  const { setSetting } = require('../../config/settingsManager');

  try {
    let count;
    if (target_type === 'public') {
      count = applyPublicMarkup(safeMarkup, category);
      if (!category) setSetting('public_store_markup', String(safeMarkup));
      req.session.flash = {
        type: 'success',
        message: `Berhasil mengubah Margin Publik menjadi Rp ${safeMarkup.toLocaleString('id-ID')} untuk ${count} produk${category ? ' kategori ' + category : ''}.`
      };
    } else {
      if (category) {
        const db = require('../../config/database');
        const result = db.prepare(`
          UPDATE products
          SET markup = ?, price_sell = price_modal + ?
          WHERE category = ?
        `).run(safeMarkup, safeMarkup, category);
        count = result.changes;
      } else {
        count = applyGlobalMarkup(safeMarkup);
        setSetting('digiflazz_markup', String(safeMarkup));
      }

      req.session.flash = {
        type: 'success',
        message: `Berhasil mengubah Margin Agen menjadi Rp ${safeMarkup.toLocaleString('id-ID')} untuk ${count} produk${category ? ' kategori ' + category : ''}.`
      };
    }
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
  }
  res.redirect('/admin/products');
});

module.exports = router;
