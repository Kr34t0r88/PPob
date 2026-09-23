/**
 * Juragan Pulsa - Agent REST API Products Router
 * routes/api/products.js
 */

const express = require('express');
const router = express.Router();
const { listProducts, listCategories, listBrands, getProductBySku, calculateAgentPrice } = require('../../services/productService');
const { requireApiToken } = require('../../middleware/apiAuth');

// GET /api/products (List produk dengan harga khusus grup agen)
router.get('/', requireApiToken, (req, res) => {
  const { q = '', category = '', brand = '', page = 1, limit = 50 } = req.query;

  try {
    const result = listProducts({
      q,
      category,
      brand,
      includeInactive: false,
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || 50,
    });

    // Format harga sesuai grup agen
    const formattedProducts = result.products.map(p => ({
      sku: p.sku,
      product_name: p.product_name,
      category: p.category,
      brand: p.brand,
      price: calculateAgentPrice(p, req.agent),
      description: p.description || '',
      is_active: p.is_active,
    }));

    return res.json({
      success: true,
      data: formattedProducts,
      pagination: result.pagination,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/products/categories
router.get('/categories', requireApiToken, (req, res) => {
  try {
    const categories = listCategories();
    return res.json({
      success: true,
      data: categories,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/products/brands
router.get('/brands', requireApiToken, (req, res) => {
  const { category = '' } = req.query;
  try {
    const brands = listBrands(category);
    return res.json({
      success: true,
      data: brands,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/products/:sku
router.get('/:sku', requireApiToken, (req, res) => {
  try {
    const product = getProductBySku(req.params.sku);
    if (!product) {
      return res.status(404).json({ success: false, error: 'Produk tidak ditemukan' });
    }

    return res.json({
      success: true,
      data: {
        sku: product.sku,
        product_name: product.product_name,
        category: product.category,
        brand: product.brand,
        price: calculateAgentPrice(product, req.agent),
        description: product.description || '',
        is_active: product.is_active,
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
