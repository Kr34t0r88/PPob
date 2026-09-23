/**
 * Juragan Pulsa - Digiflazz H2H Adapter
 * services/providers/digiflazzAdapter.js
 *
 * API Reference: https://developer.digiflazz.com/api
 * Signing: MD5(username + apiKey + refId) untuk transaksi
 *          MD5(username + apiKey + 'depo') untuk cek saldo
 * Webhook: HMAC-SHA1(rawBody, webhookSecret)
 */

const axios = require('axios');
const crypto = require('crypto');
const logger = require('../../utils/logger');

const DIGIFLAZZ_BASE_URL = 'https://api.digiflazz.com/v1';

/**
 * Buat axios instance untuk Digiflazz
 */
function createApiClient(provider) {
  return axios.create({
    baseURL: provider.api_url || DIGIFLAZZ_BASE_URL,
    timeout: 30000,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * MD5 Signature untuk transaksi
 * @param {string} username
 * @param {string} apiKey
 * @param {string} refId
 */
function signTransaction(username, apiKey, refId) {
  const u = String(username || '').trim();
  const k = String(apiKey || '').trim();
  const r = String(refId || '').trim();
  return crypto.createHash('md5')
    .update(u + k + r)
    .digest('hex');
}

/**
 * MD5 Signature untuk cek saldo
 */
function signBalance(username, apiKey) {
  const u = String(username || '').trim();
  const k = String(apiKey || '').trim();
  return crypto.createHash('md5')
    .update(u + k + 'depo')
    .digest('hex');
}

/**
 * Normalize status vendor ke internal status
 * @param {string} vendorStatus
 * @returns {'success'|'failed'|'pending'}
 */
function normalizeStatus(vendorStatus) {
  const s = String(vendorStatus || '').toLowerCase().trim();
  if (s === 'sukses' || s === 'success') return 'success';
  if (s === 'gagal' || s === 'failed') return 'failed';
  // pending, process, processing, timeout → pending
  return 'pending';
}

/**
 * Cek saldo Digiflazz
 * @param {Object} provider - Row dari table providers
 * @returns {Promise<{ deposit: number }>}
 */
async function checkBalance(provider) {
  const username = String(provider.username || '').trim();
  const apiKey = String(provider.api_key || '').trim();
  if (!username || !apiKey) {
    throw new Error('Digiflazz credentials belum dikonfigurasi. Silakan isi Username & API Key di menu Provider / Pengaturan.');
  }

  const client = createApiClient(provider);
  const sign = signBalance(username, apiKey);

  try {
    const response = await client.post('/cek-saldo', {
      cmd: 'deposit',
      username,
      sign
    });

    const data = response?.data?.data || {};
    const rc = String(data?.rc || '').trim();
    if (rc && rc !== '00' && rc !== '03') {
      const msg = data?.message || `Error RC: ${rc}`;
      if (rc === '42') {
        throw new Error(`Digiflazz (42): ${msg}. (Penyebab: IP Server belum di-whitelist di member.digiflazz.com atau format API Key Dev/Prod tidak cocok)`);
      }
      throw new Error(`Digiflazz (${rc}): ${msg}`);
    }

    const deposit = Number(data?.deposit ?? 0);
    if (!Number.isFinite(deposit)) {
      throw new Error('Format response saldo tidak valid');
    }
    return { deposit };
  } catch (err) {
    const digiMsg = err.response?.data?.data?.message || err.response?.data?.message;
    const rc = String(err.response?.data?.data?.rc || err.response?.status || '');
    if (digiMsg) {
      if (rc === '42') {
        throw new Error(`Digiflazz (42): ${digiMsg}. (Penyebab: IP Server belum di-whitelist di Dashboard Member Digiflazz atau API Key salah)`);
      }
      throw new Error(`Digiflazz (${rc}): ${digiMsg}`);
    }
    if (err.response?.status === 400) {
      throw new Error('Digiflazz HTTP 400: Kredensial (Username / API Key) salah atau IP Server belum di-whitelist di Dashboard Member Digiflazz.');
    }
    throw err;
  }
}

/**
 * Sync price list dari Digiflazz (prepaid)
 * @param {Object} provider
 * @returns {Promise<Array>} Array of product objects
 */
async function syncProducts(provider) {
  const username = String(provider.username || '').trim();
  const apiKey = String(provider.api_key || '').trim();
  if (!username || !apiKey) {
    throw new Error('Digiflazz credentials belum dikonfigurasi. Silakan lengkapi Username & API Key di menu Pengaturan / Provider.');
  }

  const client = createApiClient(provider);
  const sign = signTransaction(username, apiKey, 'pricelist');

  try {
    const response = await client.post('/price-list', {
      cmd: 'prepaid',
      username,
      sign
    });

    const data = response?.data?.data;
    if (!Array.isArray(data)) {
      const msg = response?.data?.data?.message ||
                  response?.data?.message ||
                  'Gagal mengambil price list dari Digiflazz';
      const rc = String(response?.data?.data?.rc || '');
      if (rc === '42') {
        throw new Error(`Digiflazz (42): ${msg}. (Penyebab: IP Server belum di-whitelist di member.digiflazz.com atau format API Key Dev/Prod tidak cocok)`);
      }
      throw new Error(String(msg));
    }

    // Map ke format internal
    return data.map(item => ({
      sku:          String(item.buyer_sku_code || '').trim(),
      product_name: String(item.product_name || '').trim(),
      category:     String(item.category || '').trim(),
      brand:        String(item.brand || '').trim(),
      price_modal:  parseInt(item.price || 0, 10),
      is_active:    item.buyer_product_status === true || item.buyer_product_status === 1 ? 1 : 0,
      description:  String(item.desc || '').trim(),
    })).filter(p => p.sku);
  } catch (err) {
    const digiMsg = err.response?.data?.data?.message || err.response?.data?.message;
    const rc = String(err.response?.data?.data?.rc || err.response?.status || '');
    if (digiMsg) {
      if (rc === '42') {
        throw new Error(`Digiflazz (42): ${digiMsg}. (Penyebab: IP Server belum di-whitelist di Dashboard Member Digiflazz atau API Key salah)`);
      }
      throw new Error(`Digiflazz (${rc}): ${digiMsg}`);
    }
    if (err.response?.status === 400) {
      throw new Error('Digiflazz HTTP 400: Kredensial (Username / API Key) tidak valid atau IP Server belum di-whitelist di Dashboard Member Digiflazz.');
    }
    throw err;
  }
}

/**
 * Buat transaksi pulsa ke Digiflazz
 * @param {Object} provider
 * @param {Object} params
 * @param {string} params.sku - SKU produk
 * @param {string} params.target - Nomor HP / ID pelanggan
 * @param {string} params.refId - Unique ref ID
 * @returns {Promise<Object>}
 */
async function createTransaction(provider, { sku, target, refId }) {
  const { username, api_key: apiKey } = provider;
  if (!username || !apiKey) {
    throw new Error('Digiflazz credentials belum dikonfigurasi');
  }

  const client = createApiClient(provider);
  const sign = signTransaction(username, apiKey, refId);

  try {
    const response = await client.post('/transaction', {
      username,
      buyer_sku_code: String(sku || '').trim(),
      customer_no:    String(target || '').trim(),
      ref_id:         String(refId || '').trim(),
      sign
    });

    const data = response?.data?.data || {};
    const rc = String(data?.rc || '').trim();

    // RC selain '00' (sukses) dan '03' (pending/timeout) = error
    if (rc && !['00', '03'].includes(rc)) {
      const msg = data?.message || `Error Vendor (RC: ${rc})`;
      throw new Error(String(msg));
    }

    return {
      rc:       rc,
      trx_id:   String(data?.trx_id || ''),
      sn:       String(data?.sn || ''),
      price:    parseInt(data?.price || 0, 10),
      status:   normalizeStatus(data?.status),
      message:  String(data?.message || ''),
      raw:      data,
    };

  } catch (error) {
    const isTimeout = error?.code === 'ECONNABORTED' ||
      String(error?.message || '').toLowerCase().includes('timeout') ||
      String(error?.message || '').toLowerCase().includes('network');

    if (isTimeout) {
      logger.warn(`[Digiflazz] Timeout untuk ref_id=${refId}, anggap pending`);
      return {
        rc:      '03',
        trx_id:  '',
        sn:      '',
        price:   0,
        status:  'pending',
        message: 'Request timeout. Cek status transaksi nanti.',
        raw:     {},
      };
    }

    // Error response dari API
    const errMsg = error?.response?.data?.data?.message ||
                   error?.response?.data?.message ||
                   error?.message ||
                   String(error);
    throw new Error(String(errMsg));
  }
}

/**
 * Cek status transaksi existing di Digiflazz
 * @param {Object} provider
 * @param {string} refId
 * @returns {Promise<Object>}
 */
async function checkTransaction(provider, refId, sku = '', target = '') {
  return createTransaction(provider, { sku, target, refId });
}

/**
 * Verifikasi signature webhook dari Digiflazz
 * HMAC-SHA1 dengan timing-safe compare
 *
 * @param {string|Buffer} rawBody - Raw request body
 * @param {string} signatureHeader - Nilai header 'x-hub-signature' (sha1=...)
 * @param {string} webhookSecret - Secret dari settings
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, signatureHeader, webhookSecret) {
  if (!webhookSecret || !signatureHeader) return false;

  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected = 'sha1=' +
    crypto.createHmac('sha1', String(webhookSecret))
      .update(body)
      .digest('hex');

  const sig = String(signatureHeader || '');

  if (expected.length !== sig.length) return false;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'utf8'),
      Buffer.from(sig, 'utf8')
    );
  } catch {
    return false;
  }
}

module.exports = {
  checkBalance,
  syncProducts,
  createTransaction,
  checkTransaction,
  verifyWebhookSignature,
  normalizeStatus,
};
