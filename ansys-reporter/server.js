#!/usr/bin/env node
'use strict';
/**
 * Ansys Report Builder server — zero npm dependencies.
 *
 *   node server.js            → http://localhost:4000
 *   PORT=8080 node server.js
 *
 * The server only serves static files; every bit of analysis happens in the
 * browser, so nothing an engineer drops in ever leaves the machine.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const TEMPLATE_DIR = path.join(ROOT, 'templates');
const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function serve(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, JSON.stringify({ error: 'not found', file: path.basename(file) }));
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'content-length': buf.length,
      'cache-control': 'no-store',
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (pathname === '/api/status') {
    return send(res, 200, JSON.stringify({ app: 'ansys-report-builder', version: 1, offline: true }));
  }

  // templates are served read-only; the UI can also keep an edited copy locally
  if (pathname.startsWith('/templates/')) {
    const file = path.join(TEMPLATE_DIR, path.basename(pathname));
    if (!file.startsWith(TEMPLATE_DIR)) return send(res, 403, JSON.stringify({ error: 'forbidden' }));
    return serve(res, file);
  }

  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, JSON.stringify({ error: 'forbidden' }));
  serve(res, file);
});

server.listen(PORT, HOST, () => {
  console.log(`Ansys Report Builder running on http://localhost:${PORT}`);
  console.log('All analysis runs in the browser — images are never uploaded.');
});
