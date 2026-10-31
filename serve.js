// Optional zero-dependency local server for NEON RIG. index.html also works when opened
// directly; this is for browsers that refuse audio from file:// pages.
// Usage: node serve.js [port]   (listens on 127.0.0.1 only)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const root = __dirname;
const port = Number(process.argv[2]) || 8417;
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

// Only answer requests addressed to this machine by name, so a web page can't reach the server
// through a DNS name it controls that points at 127.0.0.1 (DNS rebinding).
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

http.createServer((req, res) => {
  if (!LOCAL_HOST.test(req.headers.host || '')) { res.writeHead(421).end('Misdirected request'); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { rel = ''; }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(root, rel));
  if (!rel || !file.startsWith(root + path.sep)) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store',
      // No Content-Security-Policy: tested in Chromium, even a narrow one stalls the AudioWorklet load.
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/`;
  console.log(`NEON RIG is running at ${url}\nLeave this window open while you play. Press Ctrl+C to stop.`);
  if (process.argv.includes('--no-open')) return;
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd);
});
