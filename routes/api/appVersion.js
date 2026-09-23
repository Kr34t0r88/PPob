/**
 * Juragan Pulsa - App Version & In-App Auto Update API
 * routes/api/appVersion.js
 */

const express = require('express');
const router = express.Router();
const { getSetting } = require('../../config/settingsManager');

// GET /api/app/version (Public, no token needed)
router.get('/version', (req, res) => {
  const vCode = parseInt(getSetting('app_version_code', '1'), 10) || 1;
  const vName = getSetting('app_version_name', '1.0.0') || '1.0.0';
  const notes = getSetting('app_release_notes',
    '• Fitur Scan QR Code Akun & WhatsApp Bot Onboarding\n' +
    '• Cetak struk kasir Bluetooth Thermal Printer 58mm/80mm\n' +
    '• Pembaruan aplikasi otomatis (In-App Auto-Update)\n' +
    '• Gateway verifikasi deposit otomatis pengganti MacroDroid'
  );
  const forceUpdate = getSetting('app_force_update', '0') === '1' || getSetting('app_force_update', '0') === true;
  const downloadUrl = getSetting('app_download_url', '/downloads/juragan-pulsa.apk') || '/downloads/juragan-pulsa.apk';

  return res.json({
    success: true,
    data: {
      versionCode: vCode,
      versionName: vName,
      downloadUrl: downloadUrl,
      apkFileName: 'juragan-pulsa.apk',
      releaseNotes: notes,
      forceUpdate: forceUpdate
    }
  });
});

module.exports = router;
