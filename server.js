const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, perMessageDeflate: false });

const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/mobile', (req, res) => {
  res.sendFile(path.join(__dirname, 'mobile.html'));
});

app.post('/data', (req, res) => {
  const body = req.body;
  const freq = body.freq;

  if (freq === undefined) {
    console.log('ERROR: freq missing from body:', JSON.stringify(body));
    return res.status(400).json({ error: 'Missing freq field' });
  }

  const payload = JSON.stringify({
    freq:      body.freq,
    ax:        body.ax,
    ay:        body.ay,
    az:        body.az,
    alert:     body.alert     || 'NORMAL',
    deviation: body.deviation || 0,
    baseline:  body.baseline  || 83.87,
    serverTs:  Date.now()
  });

  console.log(`[${new Date().toLocaleTimeString()}] freq=${freq} Hz  alert=${body.alert || 'NORMAL'}`);

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });

  res.json({ status: 'ok' });
});

wss.on('connection', ws => {
  console.log('Dashboard client connected.');

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 30000);

  ws.on('pong', () => console.log('Pong received'));
  ws.on('close', () => { clearInterval(pingInterval); console.log('Client disconnected.'); });
  ws.on('error', (err) => { clearInterval(pingInterval); console.log('WS error:', err.message); });

  ws.send(JSON.stringify({ type: 'connected' }));
});

const https = require('https');
setInterval(() => {
  https.get('https://gfrp-shm.onrender.com', (res) => {
    console.log('[Keepalive] status:', res.statusCode);
  }).on('error', () => {});
}, 4 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`SHM server running on port ${PORT}`);
});