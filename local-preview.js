'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const WebSocket = require('ws');

const PORT = Number(process.env.AURALIS_PORT || 4173);
const BACKEND = new URL(process.env.AURALIS_BACKEND_URL || 'https://rustcord.hostless.app');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8',
  '.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8',
  '.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg',
  '.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.mp3':'audio/mpeg',
  '.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2'
};

function serveFile(req, res) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); return res.end('Bad request'); }
  const relative = pathname === '/' ? 'index.html' : (pathname.startsWith('/') ? pathname.slice(1) : pathname);
  const candidate = path.resolve(PUBLIC_DIR, relative);
  if (!candidate.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  const target = fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    ? candidate
    : path.join(PUBLIC_DIR, 'index.html');
  const stat = fs.statSync(target);
  const contentType = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size, 'Accept-Ranges': 'bytes' });
      return res.end();
    }
    let start, end;
    if (!match[1]) {
      const suffixLength = Number(match[2]);
      start = Math.max(0, stat.size - suffixLength);
      end = stat.size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
    }
    if (start >= stat.size || end < start) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size, 'Accept-Ranges': 'bytes' });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Length': end - start + 1,
      'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(target, { start, end }).pipe(res);
  }
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(target).pipe(res);
}

function proxyApi(req, res) {
  const transport = BACKEND.protocol === 'https:' ? https : http;
  const headers = { ...req.headers, host: BACKEND.host, origin: BACKEND.origin };
  delete headers['content-length'];
  const upstream = transport.request({
    protocol: BACKEND.protocol,
    hostname: BACKEND.hostname,
    port: BACKEND.port || undefined,
    method: req.method,
    path: req.url,
    headers
  }, (response) => {
    res.writeHead(response.statusCode || 502, response.headers);
    response.pipe(res);
  });
  upstream.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type':'application/json' });
    res.end(JSON.stringify({ error:'Auralis local proxy error', detail:err.message }));
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/api' || pathname.startsWith('/api/')) return proxyApi(req, res);
  if (req.method === 'GET' || req.method === 'HEAD') return serveFile(req, res);
  res.writeHead(404); res.end('Not found');
});

const wss = new WebSocket.Server({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (client) => {
    const wsProtocol = BACKEND.protocol === 'https:' ? 'wss:' : 'ws:';
    const remote = new WebSocket(wsProtocol + '//' + BACKEND.host + req.url, {
      headers: { origin: BACKEND.origin }
    });
    const pending = [];
    client.on('message', (data, binary) => {
      if (remote.readyState === WebSocket.OPEN) remote.send(data, { binary });
      else if (remote.readyState === WebSocket.CONNECTING) pending.push([data, binary]);
    });
    remote.on('open', () => {
      for (const [data, binary] of pending) remote.send(data, { binary });
      pending.length = 0;
    });
    remote.on('message', (data, binary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
    });
    remote.on('close', (code, reason) => {
      if (client.readyState !== WebSocket.OPEN) return;
      // RFC 6455 reserves 1005/1006/1015 for local reporting only; ws.close()
      // rejects these codes when a peer closes without a proper close frame.
      const validCloseCode =
        (Number.isInteger(code) && code >= 1000 && code <= 1014 &&
          ![1004, 1005, 1006].includes(code)) ||
        (Number.isInteger(code) && code >= 3000 && code <= 4999);
      const safeCode = validCloseCode ? code : 1011;
      const safeReason = validCloseCode && reason && Buffer.byteLength(reason) <= 123
        ? reason
        : (validCloseCode ? '' : 'Backend connection closed unexpectedly');
      try {
        client.close(safeCode, safeReason);
      } catch (err) {
        console.error('[Auralis proxy] Could not close client WebSocket cleanly:', err.message);
        try { client.terminate(); } catch {}
      }
    });
    remote.on('error', (err) => {
      console.error('[Auralis proxy] WebSocket:', err.message);
      if (client.readyState === WebSocket.OPEN) client.close(1011, 'Backend connection failed');
    });
    client.on('close', () => {
      try {
        if (remote.readyState === WebSocket.OPEN || remote.readyState === WebSocket.CONNECTING) {
          remote.close(1000, 'Local preview client disconnected');
        }
      } catch (err) {
        console.error('[Auralis proxy] Could not close backend WebSocket:', err.message);
        try { remote.terminate(); } catch {}
      }
    });
    client.on('error', () => { try { remote.terminate(); } catch {} });
    client.emit('auralis:connected');
  });
});

function startLocalPreview() {
  return new Promise((resolve, reject) => {
    if (server.listening) return resolve(server);
    const onError = (err) => { server.off('listening', onListening); reject(err); };
    const onListening = () => {
      server.off('error', onError);
      console.log('');
      console.log('  AURALIS — local preview');
      console.log('  UI:      http://127.0.0.1:' + PORT);
      console.log('  Backend: ' + BACKEND.origin);
      console.log('');
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(PORT, '127.0.0.1');
  });
}
if (require.main === module) {
  startLocalPreview().catch((err) => { console.error('[Auralis preview] Не удалось запустить локальный сервер:', err); process.exitCode = 1; });
}
module.exports = { startLocalPreview, server, PORT, BACKEND };
