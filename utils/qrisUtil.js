/**
 * Juragan Pulsa - QRIS Utility & EMVCo TLV Converter
 * utils/qrisUtil.js
 * 
 * Mengonversi QRIS Statis menjadi QRIS Dinamis ber-nominal tepat (amount + kode unik)
 * Berdasarkan standar EMVCo QR Code Specification for Payment Systems (Merchant-Presented QR).
 */

'use strict';

const QRCode = require('qrcode');

/**
 * Membersihkan dan menormalkan string payload QRIS
 */
function normalizeQrisPayload(raw) {
  let s = String(raw || '').replace(/[\r\n\t]+/g, '').trim();
  const idx = s.indexOf('000201');
  if (idx > 0) s = s.slice(idx);
  const lastCrc = s.lastIndexOf('6304');
  if (lastCrc >= 0 && s.length >= lastCrc + 8) {
    s = s.slice(0, lastCrc + 8);
  }
  return s;
}

/**
 * Menghitung Checksum CRC16 CCITT (False / Poly 0x1021, Init 0xFFFF)
 */
function crc16CcittFalse(input) {
  const s = String(input || '');
  let crc = 0xffff;
  for (let i = 0; i < s.length; i++) {
    crc ^= (s.charCodeAt(i) & 0xff) << 8;
    for (let b = 0; b < 8; b++) {
      if (crc & 0x8000) crc = ((crc << 1) ^ 0x1021) & 0xffff;
      else crc = (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/**
 * Parsing string EMVCo TLV menjadi array objek [{ tag, value }]
 */
function parseEmvTlvString(input) {
  const raw = normalizeQrisPayload(input);
  if (!raw) throw new Error('Payload QRIS kosong');
  if (raw.length < 8) throw new Error('Payload QRIS terlalu pendek');

  const items = [];
  let i = 0;
  while (i < raw.length) {
    if (i + 4 > raw.length) throw new Error('Format TLV QRIS tidak valid pada index ' + i);
    const tag = raw.slice(i, i + 2);
    const lenStr = raw.slice(i + 2, i + 4);
    if (!/^\d{2}$/.test(lenStr)) throw new Error('Panjang TLV QRIS tidak valid pada tag ' + tag);
    const len = parseInt(lenStr, 10);
    const start = i + 4;
    const end = start + len;
    if (end > raw.length) throw new Error(`Panjang value TLV (${len}) melebihi panjang data pada tag ${tag}`);
    const value = raw.slice(start, end);
    items.push({ tag, value });
    i = end;
  }
  return items;
}

/**
 * Membangun string EMVCo TLV dari array objek [{ tag, value }]
 */
function buildEmvTlvString(items) {
  const list = Array.isArray(items) ? items : [];
  let out = '';
  for (const it of list) {
    const tag = String(it?.tag || '');
    const value = String(it?.value ?? '');
    const len = value.length;
    if (!/^\d{2}$/.test(tag)) throw new Error('Tag TLV tidak valid: ' + tag);
    if (len > 99) throw new Error('Panjang nilai TLV > 99 tidak didukung pada tag ' + tag);
    out += tag + String(len).padStart(2, '0') + value;
  }
  return out;
}

/**
 * Mengonversi QRIS Statis menjadi QRIS Dinamis dengan nominal tertentu
 * - Tag 01 diubah dari '11' (Static) menjadi '12' (Dynamic)
 * - Tag 54 (Transaction Amount) disisipkan dengan nominal tepat
 * - Tag 63 (CRC16) dihitung ulang
 * 
 * @param {string} staticPayload - String QRIS statis asal (dari BCA/Dana/Gopay/Bank)
 * @param {number|string} amount - Nominal unik yang harus dibayar (contoh: 50125)
 * @returns {string} Payload QRIS dinamis lengkap
 */
function convertStaticQrisToDynamic(staticPayload, amount) {
  const amt = Math.max(0, Math.floor(Number(amount || 0) || 0));
  if (!amt) throw new Error('Nominal QRIS dinamis tidak valid');

  const source = parseEmvTlvString(staticPayload)
    .filter(x => x && x.tag)
    .map(x => ({ tag: String(x.tag), value: String(x.value ?? '') }));

  // Tag yang akan dikelola ulang
  const managed = new Set(['54', '55', '56', '57', '63']);
  const result = [];
  let amountInserted = false;

  for (const el of source) {
    if (managed.has(el.tag)) continue;
    
    // Tag 01: Point of Initiation Method -> ubah jadi '12' (Dynamic QR)
    if (el.tag === '01') {
      result.push({ tag: '01', value: '12' });
      continue;
    }

    // Sisipkan Tag 54 (Transaction Amount) sebelum Tag 58 (Country Code) jika ada
    if (el.tag === '58' && !amountInserted) {
      result.push({ tag: '54', value: String(amt) });
      amountInserted = true;
    }

    result.push(el);
  }

  // Jika belum disisipkan (karena tidak ada tag 58), tambahkan di akhir sebelum CRC
  if (!amountInserted) {
    result.push({ tag: '54', value: String(amt) });
  }

  // Bangun body payload tanpa CRC
  const body = buildEmvTlvString(result);
  const partial = body + '6304';
  const crc = crc16CcittFalse(partial).toString(16).toUpperCase().padStart(4, '0');
  
  return partial + crc;
}

/**
 * Generate Dynamic QRIS sebagai Base64 Data URL (data:image/png;base64,...)
 */
async function generateDynamicQrisDataUrl(staticPayload, amount, options = {}) {
  const dynamicPayload = convertStaticQrisToDynamic(staticPayload, amount);
  const width = options.width || 400;
  const margin = options.margin !== undefined ? options.margin : 2;
  
  const dataUrl = await QRCode.toDataURL(dynamicPayload, {
    errorCorrectionLevel: 'M',
    margin,
    width,
    color: {
      dark: options.darkColor || '#000000',
      light: options.lightColor || '#FFFFFF'
    }
  });

  return {
    dynamicPayload,
    dataUrl
  };
}

/**
 * Generate Dynamic QRIS sebagai PNG Buffer (untuk binary HTTP response)
 */
async function generateDynamicQrisBuffer(staticPayload, amount, options = {}) {
  const dynamicPayload = convertStaticQrisToDynamic(staticPayload, amount);
  const width = options.width || 400;
  const margin = options.margin !== undefined ? options.margin : 2;

  const buffer = await QRCode.toBuffer(dynamicPayload, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin,
    width
  });

  return {
    dynamicPayload,
    buffer
  };
}

module.exports = {
  normalizeQrisPayload,
  crc16CcittFalse,
  parseEmvTlvString,
  buildEmvTlvString,
  convertStaticQrisToDynamic,
  generateDynamicQrisDataUrl,
  generateDynamicQrisBuffer
};
