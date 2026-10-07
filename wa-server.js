/* AKS Mentorluk — Render WhatsApp sunucusu (Electron'u bozmaz, yan dosya) */
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.WA_DATA_DIR || path.join(__dirname, '.wa-session');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}

let waStatus = 'disconnected';
let waQR = null;
let waClient = null;
let waLastError = null;

function log(m) { console.log('[WA-SRV] ' + m); }

async function initWA() {
  const { Client, LocalAuth } = require('whatsapp-web.js');
  let executablePath;
  try {
    const puppeteer = require('puppeteer');
    executablePath = typeof puppeteer.executablePath === 'function'
      ? puppeteer.executablePath() : puppeteer.executablePath;
    log('puppeteer path: ' + executablePath);
  } catch (e) { log('puppeteer require yok: ' + e.message); }
  const homeCache = process.env.HOME ? path.join(process.env.HOME, '.cache/puppeteer') : null;
  if (homeCache) log('cache bak: ' + homeCache + ' var=' + fs.existsSync(homeCache));
  log('HOME=' + process.env.HOME + ' PUPPETEER_CACHE_DIR=' + (process.env.PUPPETEER_CACHE_DIR || 'yok'));
  // build'de inen chrome runtime'da silinebiliyor -> proje içine de bak
  function findChrome(base) {
    try {
      if (!base || !fs.existsSync(base)) return null;
      const stack = [base];
      while (stack.length) {
        const d = stack.pop();
        let ents = [];
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
        for (const e of ents) {
          const p = path.join(d, e.name);
          if (e.isFile() && (e.name === 'chrome' || e.name === 'chrome.exe')) return p;
          if (e.isDirectory() && stack.length < 60) stack.push(p);
        }
      }
    } catch (_) {}
    return null;
  }
  const localCache = path.join(__dirname, '.cache', 'puppeteer');
  const foundLocal = findChrome(localCache) || findChrome(homeCache) || findChrome('/opt/render/.cache/puppeteer') || findChrome(process.env.PUPPETEER_CACHE_DIR);
  if (foundLocal) log('taramada bulundu: ' + foundLocal);
  const cands = [executablePath, foundLocal, process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/opt/render/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome'].filter(Boolean);
  executablePath = cands.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } });
  log('secilen chrome: ' + (executablePath || 'YOK (varsayılan denenecek)'));

  if (waClient) { try { await waClient.destroy(); } catch (_) {} waClient = null; }
  waClient = new Client({
    authStrategy: new LocalAuth({ clientId: 'aks-render', dataPath: DATA_DIR }),
    puppeteer: { executablePath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] }
  });
  waClient.on('qr', (qr) => { waQR = qr; waStatus = 'qr'; log('QR hazır'); });
  waClient.on('authenticated', () => { waStatus = 'connecting'; waQR = null; log('doğrulandı'); });
  waClient.on('ready', () => { waStatus = 'ready'; waQR = null; log('bağlandı ✓'); });
  waClient.on('disconnected', () => { waStatus = 'disconnected'; waQR = null; log('bağlantı koptu'); });
  waClient.on('auth_failure', (m) => { waStatus = 'auth_failure'; waQR = null; waLastError = String(m || 'auth_failure'); log('hata: ' + m); });
  waStatus = 'connecting';
  try { await waClient.initialize(); } catch (e) { waStatus = 'auth_failure'; waLastError = String((e && e.message) || e); log('init hata: ' + waLastError); }
}

function normPhone(p) {
  let d = String(p || '').replace(/[^0-9]/g, '');
  if (d.startsWith('90') && d.length === 12) return d;
  if (d.startsWith('0') && d.length === 11) return '90' + d.slice(1);
  if (d.length === 10) return '90' + d;
  if (d.length === 11 && d.startsWith('5')) return '90' + d;
  return null;
}

async function sendWA(phone, text) {
  if (!waClient || waStatus !== 'ready') return { ok: false, error: 'WhatsApp bağlı değil (' + waStatus + ')' };
  const d = normPhone(phone);
  if (!d) return { ok: false, error: 'Geçersiz numara' };
  try {
    await waClient.sendMessage(d + '@c.us', String(text || ''));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (url.pathname === '/' || url.pathname === '/health') {
    res.end(JSON.stringify({ ok: true, status: waStatus, lastError: waLastError, time: new Date().toISOString() }));
  } else if (url.pathname === '/qr') {
    res.end(JSON.stringify({ status: waStatus, qr: waQR }));
  } else if (url.pathname === '/qr.png') {
    // basit QR sayfası: tarayıcıda açıp okut
    try {
      const QRCode = require('qrcode');
      if (!waQR) { res.end(JSON.stringify({ status: waStatus, msg: 'QR yok' })); return; }
      const png = await QRCode.toBuffer(waQR, { width: 300, margin: 2 });
      res.setHeader('Content-Type', 'image/png');
      res.end(png);
    } catch (e) { res.end(JSON.stringify({ ok: false, error: e.message })); }
  } else if (url.pathname === '/send' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', async () => {
      try {
        const j = JSON.parse(body || '{}');
        const r = await sendWA(j.phone, j.text);
        res.end(JSON.stringify(r));
      } catch (e) { res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: 'bilinmeyen uç' }));
  }
});

server.listen(PORT, () => { log('dinleniyor :' + PORT); initWA(); });
