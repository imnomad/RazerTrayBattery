const {
  app,
  Tray,
  Menu,
  BrowserWindow,
  ipcMain,
  nativeImage
} = require('electron');

const path = require('path');
const fs = require('fs');
const HID = require('node-hid');
const { WebUSB } = require('usb');
const { createCanvas } = require('canvas');

function handleSquirrel() {
  if (process.platform === 'win32') {
    const cmd = process.argv[1];
    if (cmd === '--squirrel-install' || cmd === '--squirrel-updated' || cmd === '--squirrel-uninstall' || cmd === '--squirrel-obsolete') {
      app.quit();
      return true;
    }
  }
  return false;
}
if (handleSquirrel()) return;

const RAZER_VENDOR_ID = 0x1532;
const logFile = path.join(
  process.env.LOCALAPPDATA || (app && app.getPath ? app.getPath('userData') : '.'),
  'RazerTrayBattery',
  'debug.log'
);
function log(msg) {
  try { fs.appendFileSync(logFile, new Date().toISOString() + ' ' + msg + '\n'); } catch (_) {}
}

process.on('uncaughtException', (err) => log('UncaughtException: ' + (err ? err.stack : 'unknown')));
process.on('unhandledRejection', (err) => log('UnhandledRejection: ' + (err && err.stack ? err.stack : err)));

const devices = new Map();
const trays = new Map(); // device.key -> Tray, or 'single' -> Tray
let settingsWindow = null;
let pollTimer = null;

/* =========================
   CONFIGURATION & UI STYLES
   ========================= */

const configPath = path.join(
  process.env.LOCALAPPDATA || '',
  'RazerTrayBattery',
  'config.json'
);

// Styles: 'lowest_classic', 'lowest_silhouette', 'silhouettes', 'dark', 'shapes', 'badges', 'combined'
let currentStyle = 'silhouettes';

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (data && data.style) {
        currentStyle = data.style;
      }
    }
  } catch (_) {}
}

function saveConfig() {
  try {
    fs.writeFileSync(configPath, JSON.stringify({ style: currentStyle }, null, 2), 'utf8');
  } catch (_) {}
}

loadConfig();

async function setStyle(newStyle) {
  if (currentStyle === newStyle) return;
  currentStyle = newStyle;
  saveConfig();
  await updateAllTrays();
  log('Switched UI style to: ' + currentStyle);
}

/* =========================
   CANVAS DRAWING UTILITIES
   ========================= */

function getBackgroundColor(percent) {
  if (percent > 75) return '#22c55e'; // Green
  if (percent > 25) return '#f59e0b'; // Amber / Yellow
  return '#ef4444';                   // Red
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function getDeviceInitial(deviceType) {
  switch (deviceType) {
    case 'keyboard': return 'K';
    case 'mouse': return 'M';
    case 'headset': return 'H';
    case 'gamepad': return 'G';
    case 'speaker': return 'S';
    case 'microphone': return 'MIC';
    default: return 'B';
  }
}

/* =========================
   STYLE: CLASSIC SQUARE (ORIGINAL DEFAULT)
   ========================= */

function renderClassicIcon(percent, charging, S = 32) {
  const canvas = createCanvas(S, S);
  const ctx = canvas.getContext('2d');
  const p = Math.max(0, Math.min(100, Math.round(percent || 0)));
  const color = getBackgroundColor(p);

  ctx.fillStyle = color;
  roundRect(ctx, 1, 1, S - 2, S - 2, 5);
  ctx.fill();

  ctx.fillStyle = '#000000';
  ctx.font = p === 100 ? '900 13px "Segoe UI", sans-serif' : '900 17px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(p), S / 2, S / 2 + 1);

  if (charging) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.6;
    roundRect(ctx, 1.5, 1.5, S - 3, S - 3, 4.5);
    ctx.stroke();
  }

  return nativeImage.createFromBuffer(canvas.toBuffer('image/png'));
}

/* =========================
   STYLE: SILUETAS NATIVAS
   ========================= */

function renderSilhouettesIcon(deviceType, percent, charging, S = 32) {
  const canvas = createCanvas(S, S);
  const ctx = canvas.getContext('2d');
  const p = Math.max(0, Math.min(100, Math.round(percent || 0)));
  const color = getBackgroundColor(p);

  ctx.clearRect(0, 0, S, S);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.8;

  switch (deviceType) {
    case 'mouse': {
      roundRect(ctx, 11, 2, 10, 14, 5);
      ctx.stroke();

      ctx.fillStyle = color;
      roundRect(ctx, 15, 4.5, 2, 4, 1);
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(16, 2);
      ctx.lineTo(16, 4.5);
      ctx.stroke();
      break;
    }

    case 'keyboard': {
      roundRect(ctx, 5, 3, 22, 12, 3);
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.fillRect(8, 5.5, 3, 2);
      ctx.fillRect(13, 5.5, 3, 2);
      ctx.fillRect(18, 5.5, 3, 2);
      ctx.fillRect(23, 5.5, 1.5, 2);

      ctx.fillRect(8, 8.5, 2, 2);
      ctx.fillRect(12, 8.5, 8, 2);
      ctx.fillRect(22, 8.5, 2, 2);
      break;
    }

    case 'headset': {
      ctx.beginPath();
      ctx.arc(16, 8, 9, Math.PI, 0, false);
      ctx.stroke();

      ctx.fillStyle = color;
      roundRect(ctx, 5, 7, 4.5, 8, 2);
      ctx.fill();
      roundRect(ctx, 22.5, 7, 4.5, 8, 2);
      ctx.fill();

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(7, 14);
      ctx.lineTo(11, 16);
      ctx.stroke();
      break;
    }

    case 'gamepad': {
      roundRect(ctx, 5, 4, 22, 11, 4);
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      roundRect(ctx, 6, 12, 4, 3, 1.5);
      ctx.fill();
      roundRect(ctx, 22, 12, 4, 3, 1.5);
      ctx.fill();

      ctx.fillStyle = color;
      ctx.fillRect(8, 7.5, 4, 1.5);
      ctx.fillRect(9.2, 6.2, 1.5, 4);

      ctx.beginPath();
      ctx.arc(20, 8, 1.3, 0, Math.PI * 2);
      ctx.arc(23, 8, 1.3, 0, Math.PI * 2);
      ctx.fill();
      break;
    }

    case 'speaker': {
      roundRect(ctx, 8, 3, 16, 13, 2.5);
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(16, 9.5, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#000000';
      ctx.beginPath();
      ctx.arc(16, 9.5, 1.8, 0, Math.PI * 2);
      ctx.fill();
      break;
    }

    case 'microphone': {
      roundRect(ctx, 11, 2, 10, 11, 5);
      ctx.stroke();

      ctx.fillStyle = color;
      roundRect(ctx, 13, 4, 6, 4, 2);
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(16, 13);
      ctx.lineTo(16, 16);
      ctx.moveTo(12, 16);
      ctx.lineTo(20, 16);
      ctx.stroke();
      break;
    }

    default: {
      roundRect(ctx, 8, 4, 16, 11, 2.5);
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(24, 7, 2, 5);

      ctx.fillStyle = color;
      const fillW = Math.max(2, (12 * p) / 100);
      roundRect(ctx, 10, 6, fillW, 7, 1.5);
      ctx.fill();
      break;
    }
  }

  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = '#000000';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 1;
  ctx.font = p === 100 ? '900 12px "Segoe UI", sans-serif' : '900 14px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(String(p), S / 2, S);

  if (charging) {
    ctx.shadowBlur = 0;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(S - 4, 4, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  return nativeImage.createFromBuffer(canvas.toBuffer('image/png'));
}

/* =========================
   STYLE: RAZER DARK MINIMALIST
   ========================= */

function renderDarkIcon(deviceType, percent, charging, S = 32) {
  const canvas = createCanvas(S, S);
  const ctx = canvas.getContext('2d');
  const p = Math.max(0, Math.min(100, Math.round(percent || 0)));
  const color = getBackgroundColor(p);

  ctx.fillStyle = '#111827';
  roundRect(ctx, 1, 1, S - 2, S - 2, 6);
  ctx.fill();

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  roundRect(ctx, 1.5, 1.5, S - 3, S - 3, 5);
  ctx.stroke();

  // Bottom progress bar
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  roundRect(ctx, 4, S - 5, S - 8, 2.5, 1.2);
  ctx.fill();

  ctx.fillStyle = color;
  const fillW = Math.max(2, ((S - 8) * p) / 100);
  roundRect(ctx, 4, S - 5, fillW, 2.5, 1.2);
  ctx.fill();

  // Mini vector icon on left
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
  if (deviceType === 'mouse') {
    ctx.lineWidth = 1.3;
    roundRect(ctx, 5, 5, 7, 12, 3.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(8.5, 5);
    ctx.lineTo(8.5, 9);
    ctx.stroke();
  } else if (deviceType === 'keyboard') {
    ctx.lineWidth = 1.2;
    roundRect(ctx, 4, 7, 9, 8, 2);
    ctx.stroke();
    ctx.fillRect(6, 9, 2, 1.5);
    ctx.fillRect(9, 9, 2, 1.5);
    ctx.fillRect(6, 12, 5, 1.5);
  } else if (deviceType === 'headset') {
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(8.5, 9, 4.5, Math.PI, 0, false);
    ctx.stroke();
    roundRect(ctx, 3.5, 8.5, 2.5, 5, 1);
    ctx.fill();
    roundRect(ctx, 11, 8.5, 2.5, 5, 1);
    ctx.fill();
  } else {
    ctx.lineWidth = 1.2;
    roundRect(ctx, 4, 7, 9, 8, 2);
    ctx.stroke();
  }

  // Right percentage number
  ctx.fillStyle = '#ffffff';
  ctx.font = p === 100 ? '900 12px "Segoe UI", sans-serif' : '900 15px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(p), 22, 12);

  if (charging) {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(S - 4, 4, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  return nativeImage.createFromBuffer(canvas.toBuffer('image/png'));
}

/* =========================
   STYLE: HARDWARE SHAPES
   ========================= */

function renderShapesIcon(deviceType, percent, charging, S = 32) {
  const canvas = createCanvas(S, S);
  const ctx = canvas.getContext('2d');
  const p = Math.max(0, Math.min(100, Math.round(percent || 0)));
  const color = getBackgroundColor(p);

  if (deviceType === 'mouse') {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(10, 1);
    ctx.lineTo(S - 10, 1);
    ctx.quadraticCurveTo(S - 1, 1, S - 1, 10);
    ctx.lineTo(S - 1, S - 4);
    ctx.quadraticCurveTo(S - 1, S - 1, S - 4, S - 1);
    ctx.lineTo(4, S - 1);
    ctx.quadraticCurveTo(1, S - 1, 1, S - 4);
    ctx.lineTo(1, 10);
    ctx.quadraticCurveTo(1, 1, 10, 1);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#000000';
    roundRect(ctx, 14.5, 3, 3, 5, 1.5);
    ctx.fill();

    ctx.font = p === 100 ? '900 13px "Segoe UI", sans-serif' : '900 16px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(p), S / 2, 18.5);
  } else {
    // 3D Keycap
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    roundRect(ctx, 1, 1, S - 2, S - 2, 4);
    ctx.fill();

    ctx.fillStyle = color;
    roundRect(ctx, 2, 2, S - 4, S - 5, 3);
    ctx.fill();

    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    roundRect(ctx, 7, 4, 18, 2.5, 1);
    ctx.fill();

    ctx.fillStyle = '#000000';
    ctx.font = p === 100 ? '900 13px "Segoe UI", sans-serif' : '900 16px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(p), S / 2, 18);
  }

  if (charging) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.6;
    roundRect(ctx, 1.5, 1.5, S - 3, S - 3, 4);
    ctx.stroke();
  }

  return nativeImage.createFromBuffer(canvas.toBuffer('image/png'));
}

/* =========================
   STYLE: COLOR BADGES (M/K/H)
   ========================= */

function renderBadgesIcon(deviceType, percent, charging, S = 32) {
  const canvas = createCanvas(S, S);
  const ctx = canvas.getContext('2d');
  const p = Math.max(0, Math.min(100, Math.round(percent || 0)));
  const color = getBackgroundColor(p);

  ctx.fillStyle = color;
  roundRect(ctx, 1, 1, S - 2, S - 2, 5);
  ctx.fill();

  ctx.fillStyle = 'rgba(0, 0, 0, 0.40)';
  ctx.beginPath();
  ctx.moveTo(6, 1);
  ctx.lineTo(11, 1);
  ctx.lineTo(11, S - 1);
  ctx.lineTo(6, S - 1);
  ctx.quadraticCurveTo(1, S - 1, 1, S - 6);
  ctx.lineTo(1, 6);
  ctx.quadraticCurveTo(1, 1, 6, 1);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = '900 12px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(getDeviceInitial(deviceType), 6, S / 2);

  ctx.fillStyle = '#000000';
  if (p === 100) {
    ctx.font = '900 11px "Segoe UI", sans-serif';
    ctx.fillText('100', 21.5, S / 2 + 0.5);
  } else {
    ctx.font = '900 16.5px "Segoe UI", sans-serif';
    ctx.fillText(String(p), 21.5, S / 2 + 1);
  }

  if (charging) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    roundRect(ctx, 1.5, 1.5, S - 3, S - 3, 4.5);
    ctx.stroke();
  }

  return nativeImage.createFromBuffer(canvas.toBuffer('image/png'));
}

/* =========================
   STYLE: COMBINED ALL-IN-ONE
   ========================= */

function renderCombinedIcon(devicesWithBat, S = 32) {
  const canvas = createCanvas(S, S);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#111827';
  roundRect(ctx, 1, 1, S - 2, S - 2, 6);
  ctx.fill();

  ctx.strokeStyle = '#374151';
  ctx.lineWidth = 1;
  roundRect(ctx, 1, 1, S - 2, S - 2, 6);
  ctx.stroke();

  if (devicesWithBat.length === 0) {
    ctx.fillStyle = '#9ca3af';
    ctx.font = '900 9px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('RAZER', S / 2, S / 2);
    return nativeImage.createFromBuffer(canvas.toBuffer('image/png'));
  }

  if (devicesWithBat.length === 1) {
    const d = devicesWithBat[0];
    const color = getBackgroundColor(d.percent);
    ctx.fillStyle = color;
    ctx.font = '900 8px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(getDeviceInitial(d.deviceType), S / 2, 9);
    ctx.font = '900 14px "Segoe UI", sans-serif';
    ctx.fillText(String(d.percent), S / 2, 22);
    return nativeImage.createFromBuffer(canvas.toBuffer('image/png'));
  }

  // 2 or more devices: display first 2 side-by-side
  const d1 = devicesWithBat[0];
  const d2 = devicesWithBat[1];
  const c1 = getBackgroundColor(d1.percent);
  const c2 = getBackgroundColor(d2.percent);

  ctx.fillStyle = c1;
  ctx.font = '900 8px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(getDeviceInitial(d1.deviceType), 8.5, 9);
  ctx.font = '900 12px "Segoe UI", sans-serif';
  ctx.fillText(String(d1.percent), 8.5, 22);

  ctx.strokeStyle = '#374151';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(16, 4);
  ctx.lineTo(16, S - 4);
  ctx.stroke();

  ctx.fillStyle = c2;
  ctx.font = '900 8px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(getDeviceInitial(d2.deviceType), 23.5, 9);
  ctx.font = '900 12px "Segoe UI", sans-serif';
  ctx.fillText(String(d2.percent), 23.5, 22);

  return nativeImage.createFromBuffer(canvas.toBuffer('image/png'));
}

/* =========================
   ICON ROUTER
   ========================= */

function createDeviceIcon(deviceType, percent, charging) {
  switch (currentStyle) {
    case 'lowest_classic':
      return renderClassicIcon(percent, charging);
    case 'dark':
      return renderDarkIcon(deviceType, percent, charging);
    case 'shapes':
      return renderShapesIcon(deviceType, percent, charging);
    case 'badges':
      return renderBadgesIcon(deviceType, percent, charging);
    case 'lowest_silhouette':
    case 'silhouettes':
    default:
      return renderSilhouettesIcon(deviceType, percent, charging);
  }
}

/* =========================
   SYNAPSE LOG READER
   ========================= */

function readSynapseBatteries() {
  try {
    const logPath = path.join(
      process.env.LOCALAPPDATA || '',
      'Razer',
      'RazerAppEngine',
      'User Data',
      'Logs',
      'systray_systrayv2.log'
    );
    if (!fs.existsSync(logPath)) return {};

    const stat = fs.statSync(logPath);
    const readSize = Math.min(stat.size, 128 * 1024);
    const buffer = Buffer.alloc(readSize);
    const fd = fs.openSync(logPath, 'r');
    fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);

    const content = buffer.toString('utf-8');
    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes('mapDevices ~ devices:')) {
        const idx = lines[i].indexOf('mapDevices ~ devices:');
        const raw = lines[i].slice(idx + 'mapDevices ~ devices:'.length).trim();
        const parsed = JSON.parse(raw);
        const result = {};
        for (const item of parsed) {
          if (item.hasBattery && item.powerStatus) {
            result[item.productId] = {
              level: item.powerStatus.level,
              charging: item.powerStatus.chargingStatus === 'Charging',
              name: item.name?.en || item.productName?.en
            };
          }
        }
        return result;
      }
    }
  } catch (_) {}
  return {};
}

/* =========================
   DEVICE CLASSIFICATION & DETECTION
   ========================= */

function classifyDevice(name, productId) {
  const n = (name || '').toLowerCase();

  // Mice
  if (
    n.includes('viper') || n.includes('deathadder') || n.includes('basilisk') ||
    n.includes('naga') || n.includes('cobra') || n.includes('orochi') ||
    n.includes('mamba') || n.includes('abyssus') || n.includes('lancehead') ||
    n.includes('ouroboros') || n.includes('mouse') || n.includes('raton') ||
    productId === 0x00e6 || productId === 0x00e5
  ) {
    return 'mouse';
  }

  // Keyboards & Keypads
  if (
    n.includes('huntsman') || n.includes('blackwidow') || n.includes('deathstalker') ||
    n.includes('pro type') || n.includes('ornata') || n.includes('cynosa') ||
    n.includes('tartarus') || n.includes('orbweaver') || n.includes('keyboard') ||
    n.includes('teclado') || n.includes('keypad') ||
    productId === 0x0277 || productId === 0x027b
  ) {
    return 'keyboard';
  }

  // Headsets & Audio
  if (
    n.includes('blackshark') || n.includes('kraken') || n.includes('barracuda') ||
    n.includes('nari') || n.includes('kaira') || n.includes('opus') ||
    n.includes('hammerhead') || n.includes('thresher') || n.includes('headset') ||
    n.includes('headphone') || n.includes('auricular') || n.includes('audifono') ||
    n.includes('audio') || n.includes('earbuds')
  ) {
    return 'headset';
  }

  // Controllers / Gamepads
  if (
    n.includes('wolverine') || n.includes('raiju') || n.includes('kishi') ||
    n.includes('edge') || n.includes('serval') || n.includes('controller') ||
    n.includes('gamepad') || n.includes('mando')
  ) {
    return 'gamepad';
  }

  // Speakers / Soundbars
  if (
    n.includes('nommo') || n.includes('leviathan') || n.includes('ferox') ||
    n.includes('speaker') || n.includes('soundbar')
  ) {
    return 'speaker';
  }

  // Microphones
  if (n.includes('seiren') || n.includes('microphone') || n.includes('mic')) {
    return 'microphone';
  }

  return 'battery';
}

function getDeviceTypeLabel(deviceType) {
  const titles = {
    keyboard: 'Keyboard',
    mouse: 'Mouse',
    headset: 'Headset',
    gamepad: 'Gamepad',
    speaker: 'Speaker',
    microphone: 'Microphone',
    battery: 'Device'
  };
  return titles[deviceType] || 'Device';
}

function getDeviceCanonicalKey(name, vendorId, productId) {
  const norm = (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (norm.includes('viper')) return 'razer_viper';
  if (norm.includes('protype')) return 'razer_protype';
  if (norm.includes('deathadder')) return 'razer_deathadder';
  if (norm.includes('basilisk')) return 'razer_basilisk';
  if (norm.includes('blackshark')) return 'razer_blackshark';
  if (norm.includes('barracuda')) return 'razer_barracuda';
  if (norm.includes('kraken')) return 'razer_kraken';
  if (norm.includes('huntsman')) return 'razer_huntsman';
  if (norm.includes('blackwidow')) return 'razer_blackwidow';
  if (norm.includes('deathstalker')) return 'razer_deathstalker';
  if (norm.includes('wolverine')) return 'razer_wolverine';
  if (norm.includes('kishi')) return 'razer_kishi';
  if (norm.includes('leviathan')) return 'razer_leviathan';
  if (norm.includes('nommo')) return 'razer_nommo';
  if (norm.includes('seiren')) return 'razer_seiren';
  return norm || `${vendorId}:${productId}`;
}

function refreshDevices() {
  devices.clear();

  // 1. Scan HID devices connected via USB
  const list = HID.devices().filter(d => d.vendorId === RAZER_VENDOR_ID);

  for (const d of list) {
    let name = d.product || 'Razer Device';
    let deviceType = classifyDevice(name, d.productId);

    if (name.toLowerCase().includes('viper') || d.productId === 0x00e6 || d.productId === 0x00e5) {
      name = 'Razer Viper V4 Pro';
      deviceType = 'mouse';
    } else if (name.toLowerCase().includes('pro type') || d.productId === 0x0277 || d.productId === 0x027b) {
      name = 'Razer Pro Type Ultra';
      deviceType = 'keyboard';
    }

    const canonicalKey = getDeviceCanonicalKey(name, d.vendorId, d.productId);

    if (!devices.has(canonicalKey)) {
      const lower = name.toLowerCase();
      const isKnownNonBattery = lower.includes('kiyo') || lower.includes('essential') || lower.includes('camera') || lower.includes('dock');
      devices.set(canonicalKey, {
        key: canonicalKey,
        vendorId: d.vendorId,
        productId: d.productId,
        productName: name,
        deviceType,
        hasBattery: !isKnownNonBattery
      });
    }
  }

  // 2. Also import any battery devices tracked by Razer Synapse
  const synapseData = readSynapseBatteries();
  for (const [pidStr, item] of Object.entries(synapseData)) {
    const pid = Number(pidStr);
    const devName = item.name || 'Razer Device';
    const canonicalKey = getDeviceCanonicalKey(devName, RAZER_VENDOR_ID, pid);
    if (!devices.has(canonicalKey)) {
      const deviceType = classifyDevice(devName, pid);
      devices.set(canonicalKey, {
        key: canonicalKey,
        vendorId: RAZER_VENDOR_ID,
        productId: pid,
        productName: devName,
        deviceType,
        hasBattery: true
      });
    }
  }
}

/* =========================
   BATTERY RESOLVER
   ========================= */

async function getDeviceBattery(device) {
  if (!device || !device.hasBattery) return null;

  // 1. Try Synapse live data first
  const synapseData = readSynapseBatteries();
  const devCanonical = getDeviceCanonicalKey(device.productName, device.vendorId, device.productId);

  for (const item of Object.values(synapseData)) {
    if (!item || item.level === undefined) continue;
    const itemCanonical = getDeviceCanonicalKey(item.name, RAZER_VENDOR_ID, item.productId);
    if (itemCanonical === devCanonical || item.productId === device.productId) {
      return {
        percent: item.level,
        charging: item.charging
      };
    }
  }

  // 2. Direct WebUSB communication fallback
  const direct = await readBatteryWebUSB(device);
  if (direct != null) {
    return {
      percent: direct,
      charging: false
    };
  }

  return null;
}

/* =========================
   STYLE SUBMENU BUILDER
   ========================= */

function buildStyleSubmenu() {
  return [
    {
      label: 'Original Default (Single icon, lowest battery)',
      type: 'radio',
      checked: currentStyle === 'lowest_classic',
      click: async () => await setStyle('lowest_classic')
    },
    {
      label: 'Lowest Battery (Native Silhouette)',
      type: 'radio',
      checked: currentStyle === 'lowest_silhouette',
      click: async () => await setStyle('lowest_silhouette')
    },
    {
      label: 'Native Silhouettes (Separate per device)',
      type: 'radio',
      checked: currentStyle === 'silhouettes',
      click: async () => await setStyle('silhouettes')
    },
    {
      label: 'Razer Dark Minimalist (Separate, Carbon & Neon)',
      type: 'radio',
      checked: currentStyle === 'dark',
      click: async () => await setStyle('dark')
    },
    {
      label: 'Hardware Shapes (Separate, Mouse / Keycap)',
      type: 'radio',
      checked: currentStyle === 'shapes',
      click: async () => await setStyle('shapes')
    },
    {
      label: 'Color Badges (Separate with M / K)',
      type: 'radio',
      checked: currentStyle === 'badges',
      click: async () => await setStyle('badges')
    },
    {
      label: 'Combined Split Icon (Both in one: KB | M)',
      type: 'radio',
      checked: currentStyle === 'combined',
      click: async () => await setStyle('combined')
    }
  ];
}

/* =========================
   TRAY CONTEXT MENUS
   ========================= */

function createContextMenuForDevice(device, percent, charging) {
  const menu = [];
  if (device) {
    const chargeStr = charging ? ' (Charging)' : '';
    const typeLabel = getDeviceTypeLabel(device.deviceType);
    menu.push({
      label: `${device.productName} [${typeLabel}]: ${percent}%${chargeStr}`,
      enabled: false
    });
    menu.push({ type: 'separator' });
  }

  menu.push(
    {
      label: 'Icon Style',
      submenu: buildStyleSubmenu()
    },
    { type: 'separator' },
    {
      label: 'Refresh Devices',
      click: async () => {
        refreshDevices();
        await updateAllTrays();
      }
    },
    {
      label: 'Settings…',
      click: openSettings
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        for (const t of trays.values()) {
          try { t.destroy(); } catch (_) {}
        }
        app.exit(0);
      }
    }
  );

  return Menu.buildFromTemplate(menu);
}

function createCombinedContextMenu(devicesWithBat, lowestDevice) {
  const menu = [];

  if (devicesWithBat.length > 0) {
    for (const d of devicesWithBat) {
      const chargeStr = d.charging ? ' (Charging)' : '';
      const typeLabel = getDeviceTypeLabel(d.deviceType);
      const isLowest = lowestDevice && d.key === lowestDevice.key && devicesWithBat.length > 1;
      const lowestTag = isLowest ? ' [Lowest]' : '';
      menu.push({
        label: `${d.productName} [${typeLabel}]: ${d.percent}%${chargeStr}${lowestTag}`,
        enabled: false
      });
    }
    menu.push({ type: 'separator' });
  }

  menu.push(
    {
      label: 'Icon Style',
      submenu: buildStyleSubmenu()
    },
    { type: 'separator' },
    {
      label: 'Refresh Devices',
      click: async () => {
        refreshDevices();
        await updateAllTrays();
      }
    },
    {
      label: 'Settings…',
      click: openSettings
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        for (const t of trays.values()) {
          try { t.destroy(); } catch (_) {}
        }
        app.exit(0);
      }
    }
  );

  return Menu.buildFromTemplate(menu);
}

/* =========================
   TRAY UPDATER (MULTI-TRAY / SINGLE TRAY)
   ========================= */

const singleTrayStyles = ['lowest_classic', 'lowest_silhouette', 'combined'];

async function updateAllTrays() {
  const batteryDevices = [...devices.values()].filter(d => d.hasBattery);

  if (batteryDevices.length === 0) {
    for (const [key, t] of trays.entries()) {
      if (key !== 'single') {
        try { t.destroy(); } catch (_) {}
        trays.delete(key);
      }
    }
    let defaultTray = trays.get('single');
    if (!defaultTray) {
      defaultTray = new Tray(renderSilhouettesIcon('battery', 0, false));
      defaultTray.on('click', openSettings);
      trays.set('single', defaultTray);
    }
    defaultTray.setToolTip('No se detectaron dispositivos con batería');
    defaultTray.setContextMenu(createContextMenuForDevice(null, 0, false));
    return;
  }

  // Fetch live battery for each device
  const listWithBat = [];
  for (const device of batteryDevices) {
    const bat = await getDeviceBattery(device);
    listWithBat.push({
      ...device,
      percent: bat ? bat.percent : 0,
      charging: bat ? bat.charging : false
    });
  }

  // Sort stably by type priority (keyboard, mouse, headset, gamepad, speaker, microphone, battery)
  const priority = {
    keyboard: 1,
    mouse: 2,
    headset: 3,
    gamepad: 4,
    speaker: 5,
    microphone: 6,
    battery: 7
  };
  listWithBat.sort((a, b) => {
    const pA = priority[a.deviceType] || 99;
    const pB = priority[b.deviceType] || 99;
    if (pA !== pB) return pA - pB;
    return (a.productName || '').localeCompare(b.productName || '');
  });

  // --- SINGLE TRAY MODES ---
  if (singleTrayStyles.includes(currentStyle)) {
    // Remove all individual device trays
    for (const [key, t] of trays.entries()) {
      if (key !== 'single') {
        try { t.destroy(); } catch (_) {}
        trays.delete(key);
      }
    }

    let icon = null;
    let tooltip = '';
    let lowestDevice = listWithBat[0];
    for (const dev of listWithBat) {
      if (dev.percent < lowestDevice.percent) {
        lowestDevice = dev;
      }
    }

    if (currentStyle === 'lowest_classic') {
      icon = renderClassicIcon(lowestDevice.percent, lowestDevice.charging, 32);
      const chargeStr = lowestDevice.charging ? ' (Charging)' : '';
      const typeLabel = getDeviceTypeLabel(lowestDevice.deviceType);
      tooltip = `Batería más baja: ${lowestDevice.productName} [${typeLabel}]: ${lowestDevice.percent}%${chargeStr}`;
    } else if (currentStyle === 'lowest_silhouette') {
      icon = renderSilhouettesIcon(lowestDevice.deviceType, lowestDevice.percent, lowestDevice.charging, 32);
      const chargeStr = lowestDevice.charging ? ' (Charging)' : '';
      const typeLabel = getDeviceTypeLabel(lowestDevice.deviceType);
      tooltip = `Batería más baja: ${lowestDevice.productName} [${typeLabel}]: ${lowestDevice.percent}%${chargeStr}`;
    } else if (currentStyle === 'combined') {
      icon = renderCombinedIcon(listWithBat, 32);
      tooltip = listWithBat.map(d => `${d.productName}: ${d.percent}%${d.charging ? ' (Charging)' : ''}`).join(' | ');
    }

    let tray = trays.get('single');
    if (!tray) {
      tray = new Tray(icon);
      tray.on('click', openSettings);
      trays.set('single', tray);
    } else {
      tray.setImage(icon);
    }

    tray.setToolTip(tooltip);
    tray.setContextMenu(createCombinedContextMenu(listWithBat, lowestDevice));
    log('Updated single tray (' + currentStyle + ') for: ' + listWithBat.map(d => d.productName).join(', '));
    return;
  }

  // --- MULTI-TRAY MODES ---
  if (trays.has('single')) {
    try { trays.get('single').destroy(); } catch (_) {}
    trays.delete('single');
  }

  // Remove trays for devices that no longer exist
  for (const [key, t] of trays.entries()) {
    if (!devices.has(key)) {
      try { t.destroy(); } catch (_) {}
      trays.delete(key);
    }
  }

  // Update or create tray for each battery device
  for (const device of listWithBat) {
    const icon = createDeviceIcon(device.deviceType, device.percent, device.charging);
    const chargeStr = device.charging ? ' (Charging)' : '';
    const typeLabel = getDeviceTypeLabel(device.deviceType);
    const tooltip = `${device.productName} [${typeLabel}]: ${device.percent}%${chargeStr}`;

    let tray = trays.get(device.key);
    if (!tray) {
      tray = new Tray(icon);
      tray.on('click', openSettings);
      trays.set(device.key, tray);
    } else {
      tray.setImage(icon);
    }

    tray.setToolTip(tooltip);
    tray.setContextMenu(createContextMenuForDevice(device, device.percent, device.charging));
  }

  log('Updated trays for: ' + listWithBat.map(d => d.productName).join(', '));
}

/* =========================
   APP LIFECYCLE
   ========================= */

app.whenReady().then(async () => {
  log('App is ready. Initializing trays with style: ' + currentStyle);
  refreshDevices();
  await updateAllTrays();
  startPolling();
  if (process.argv.includes('--settings')) {
    openSettings();
  }
});

app.on('window-all-closed', (e) => e.preventDefault());

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    await updateAllTrays();
  }, 15000);
}

/* =========================
   SETTINGS WINDOW
   ========================= */

function openSettings() {
  if (settingsWindow) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 530,
    height: 600,
    useContentSize: true,
    frame: false,
    backgroundColor: '#0d1117',
    resizable: false,
    title: 'Razer Battery – Settings',
    webPreferences: {
      preload: path.join(__dirname, 'preload-settings.js')
    }
  });

  settingsWindow.setMenu(null);
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));

  settingsWindow.on('close', e => {
    e.preventDefault();
    settingsWindow.hide();
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

/* =========================
   IPC – SETTINGS
   ========================= */

ipcMain.handle('window:close', () => {
  if (settingsWindow) {
    settingsWindow.hide();
  }
  return true;
});

ipcMain.handle('devices:list', () => {
  return {
    devices: [...devices.values()]
  };
});

ipcMain.handle('devices:refresh', async () => {
  refreshDevices();
  await updateAllTrays();
  return {
    devices: [...devices.values()]
  };
});

ipcMain.handle('devices:batteryStatus', async (_e, key) => {
  const device = devices.get(key);
  if (!device) return { status: 'disconnected' };
  if (!device.hasBattery) return { status: 'no-battery' };

  const bat = await getDeviceBattery(device);
  if (!bat) return { status: 'connected' };

  return { status: 'ok', percent: bat.percent, charging: bat.charging };
});

ipcMain.handle('settings:getAutoStart', () => {
  const settings = app.getLoginItemSettings();
  return settings.openAtLogin;
});

ipcMain.handle('settings:setAutoStart', (_evt, enabled) => {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true
  });
  return true;
});

ipcMain.handle('settings:getStyle', () => currentStyle);

ipcMain.handle('settings:setStyle', async (_evt, style) => {
  await setStyle(style);
  return true;
});

/* =========================
   BATTERY (WebUSB Direct Fallback)
   ========================= */

async function readBatteryWebUSB(info) {
  try {
    const webusb = new WebUSB({
      devicesFound: devs =>
        devs.find(d =>
          d.vendorId === info.vendorId &&
          (d.productId === info.productId ||
           (info.productId === 0x00e6 && d.productId === 0x00e5) ||
           (info.productId === 0x00e5 && d.productId === 0x00e6))
        )
    });

    const device = await webusb.requestDevice({ filters: [{}] });
    if (!device) return null;

    await device.open();
    if (!device.configuration) await device.selectConfiguration(1);

    const transactionId = 0x1f;
    let msg = Buffer.from([
      0x00,
      transactionId,
      0x00, 0x00,
      0x00,
      0x02,
      0x07,
      0x80
    ]);

    let crc = 0;
    for (let i = 2; i < msg.length; i++) crc ^= msg[i];

    msg = Buffer.concat([
      msg,
      Buffer.alloc(80),
      Buffer.from([crc, 0x00])
    ]);

    let raw = null;
    const ifaces = device.configuration ? device.configuration.interfaces : [];

    for (const ifaceObj of ifaces) {
      const iface = ifaceObj.interfaceNumber;
      try {
        await device.claimInterface(iface);
        await device.controlTransferOut({
          requestType: 'class',
          recipient: 'interface',
          request: 0x09,
          value: 0x300,
          index: iface
        }, msg);

        await new Promise(r => setTimeout(r, 100));

        const reply = await device.controlTransferIn({
          requestType: 'class',
          recipient: 'interface',
          request: 0x01,
          value: 0x300,
          index: iface
        }, 90);

        await device.releaseInterface(iface);

        if (reply && reply.data && reply.data.byteLength >= 10) {
          const status = reply.data.getUint8(0);
          const val = reply.data.getUint8(9);
          if (status === 2 && val > 0 && val <= 255) {
            raw = val;
            break;
          }
        }
      } catch (_) {
        try { await device.releaseInterface(iface); } catch (__) {}
      }
    }

    await device.close();

    if (raw == null) return null;
    return Math.round((raw / 255) * 100);
  } catch {
    return null;
  }
}
