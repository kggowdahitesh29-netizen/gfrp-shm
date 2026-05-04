const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const path       = require('path');
const https      = require('https');
const nodemailer = require('nodemailer');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

const GOOGLE_SHEET_URL = 'https://script.google.com/macros/s/AKfycbwFBwZc868SvpnuvSAYlpoX2q3WneREYoh9Gmdr-xiZ3ljGvPR64k2rVZB0oDSYl6LY/exec';

const EMAIL_FROM     = process.env.EMAIL_FROM     || 'your_gmail@gmail.com';
const EMAIL_TO       = process.env.EMAIL_TO       || 'your_gmail@gmail.com';
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD || 'your_app_password';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: EMAIL_FROM,
    pass: EMAIL_PASSWORD
  }
});

let lastEmailAlertState = 'NORMAL';
let lastEmailTime       = 0;
const EMAIL_COOLDOWN_MS = 60000;

app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/mobile', (req, res) => {
  res.sendFile(path.join(__dirname, 'mobile.html'));
});

app.post('/data', (req, res) => {
  const { freq, ax, ay, az, ts, alert, deviation, baseline } = req.body;

  if (freq === undefined) {
    return res.status(400).json({ error: 'Missing freq field' });
  }

  const payload = JSON.stringify({
    freq, ax, ay, az, ts,
    alert, deviation, baseline,
    serverTs: Date.now()
  });

  console.log(`[${new Date().toLocaleTimeString()}] freq=${freq} Hz  alert=${alert || 'NORMAL'}  dev=${deviation || 0}%`);

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });

  const currentAlert = alert || 'NORMAL';
  checkAndSendEmail(currentAlert, freq, deviation, ax, ay, az);

  logToGoogleSheets({ freq, ax, ay, az });

  res.json({ status: 'ok' });
});

function checkAndSendEmail(alertState, freq, deviation, ax, ay, az) {
  const now = Date.now();
  if (alertState === lastEmailAlertState) return;
  if (now - lastEmailTime < EMAIL_COOLDOWN_MS) return;

  if (alertState === 'CRITICAL' || alertState === 'WARNING') {
    lastEmailAlertState = alertState;
    lastEmailTime       = now;
    sendAlertEmail(alertState, freq, deviation, ax, ay, az);
  } else if (alertState === 'NORMAL' && lastEmailAlertState !== 'NORMAL') {
    lastEmailAlertState = alertState;
    sendRecoveryEmail(freq);
  }
}

function sendAlertEmail(alertState, freq, deviation, ax, ay, az) {
  const isCritical = alertState === 'CRITICAL';
  const emoji      = isCritical ? '🔴' : '🟡';
  const subject    = `${emoji} GFRP SHM ${alertState} — Freq=${freq} Hz`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:${isCritical ? '#ff4a4a' : '#f5a623'};color:white;padding:20px;border-radius:8px 8px 0 0;">
        <h2 style="margin:0;">${emoji} ${alertState} ALERT — GFRP Plate SHM</h2>
        <p style="margin:5px 0 0 0;opacity:0.9;">${new Date().toLocaleString()}</p>
      </div>
      <div style="background:#f9f9f9;padding:20px;border-radius:0 0 8px 8px;border:1px solid #ddd;">
        <table style="width:100%;border-collapse:collapse;">
          <tr style="background:#fff;border-bottom:1px solid #eee;">
            <td style="padding:10px;color:#666;font-weight:bold;">Current Frequency</td>
            <td style="padding:10px;color:${isCritical ? '#ff4a4a' : '#f5a623'};font-size:20px;font-weight:bold;">${freq} Hz</td>
          </tr>
          <tr style="background:#f9f9f9;border-bottom:1px solid #eee;">
            <td style="padding:10px;color:#666;font-weight:bold;">Baseline M1</td>
            <td style="padding:10px;color:#333;">83.87 Hz — FFFF · No hole · 0°</td>
          </tr>
          <tr style="background:#fff;border-bottom:1px solid #eee;">
            <td style="padding:10px;color:#666;font-weight:bold;">Deviation</td>
            <td style="padding:10px;color:${isCritical ? '#ff4a4a' : '#f5a623'};font-weight:bold;">${deviation}%</td>
          </tr>
          <tr style="background:#f9f9f9;border-bottom:1px solid #eee;">
            <td style="padding:10px;color:#666;font-weight:bold;">Alert Level</td>
            <td style="padding:10px;font-weight:bold;color:${isCritical ? '#ff4a4a' : '#f5a623'};">${alertState}</td>
          </tr>
          <tr style="background:#fff;">
            <td style="padding:10px;color:#666;font-weight:bold;">Acceleration</td>
            <td style="padding:10px;color:#333;">X=${ax} Y=${ay} Z=${az} m/s²</td>
          </tr>
        </table>
        <p style="color:#999;font-size:12px;margin-top:16px;">
          Sent by GFRP SHM System · MTech Project · ESP8266 + ADXL345
        </p>
      </div>
    </div>
  `;

  transporter.sendMail({ from: EMAIL_FROM, to: EMAIL_TO, subject, html }, (err) => {
    if (err) console.log('[Email] Error:', err.message);
    else console.log(`[Email] ${alertState} alert sent!`);
  });
}

function sendRecoveryEmail(freq) {
  transporter.sendMail({
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject: `✅ GFRP SHM — Frequency returned to normal (${freq} Hz)`,
    html: `<p>Frequency returned to normal.</p><p><strong>Current: ${freq} Hz</strong></p><p>Baseline: 83.87 Hz · Normal: 79.68–88.06 Hz</p>`
  }, (err) => {
    if (err) console.log('[Email] Error:', err.message);
    else console.log('[Email] Recovery email sent!');
  });
}

let lastLogTime = 0;

function logToGoogleSheets(data) {
  const now = Date.now();
  if (now - lastLogTime < 5000) return;
  lastLogTime = now;

  const body = JSON.stringify(data);
  const url  = new URL(GOOGLE_SHEET_URL);

  const options = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  };

  function makeRequest(opts, redirectCount) {
    if (redirectCount > 5) return;
    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const redirectUrl = new URL(res.headers.location);
          makeRequest({
            hostname: redirectUrl.hostname,
            path: redirectUrl.pathname + redirectUrl.search,
            method: 'GET',
            headers: {}
          }, redirectCount + 1);
        } else {
          console.log('[Sheets] Logged OK');
        }
      });
    });
    req.on('error', err => console.log('[Sheets] Error:', err.message));
    if (opts.method === 'POST') req.write(body);
    req.end();
  }

  makeRequest(options, 0);
}

wss.on('connection', ws => {
  console.log('Dashboard client connected.');
  ws.on('close', () => console.log('Dashboard client disconnected.'));
});

server.listen(PORT, () => {
  console.log(`SHM server running on port ${PORT}`);
  console.log(`Email alerts → ${EMAIL_TO}`);
  console.log(`Google Sheets logging every 5 seconds`);
});