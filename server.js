'use strict';
/**
 * Serveur local du Simulateur Budgétaire (dev).
 * En prod (Vercel), c'est api/index.js qui répond aux routes API.
 *
 * - Sert le frontend statique (public/)
 * - Délègue les routes /api/* à lib/api-handler.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const apiHandler = require('./lib/api-handler');
const reference = require('./lib/reference');
const marketprice = require('./lib/marketprice');
const sf = require('./lib/sf');

const PORT = process.env.PORT || 4173;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const handled = await apiHandler.handle(req, res);
  if (handled) return;
  const u = new URL(req.url, `http://localhost:${PORT}`);
  serveStatic(req, res, u.pathname);
});

server.listen(PORT, () => {
  console.log(`\n  Simulateur Budgétaire — http://localhost:${PORT}`);
  console.log(`  Salesforce : ${sf.SF_PATH}   |   User : ${sf.ORG}\n`);
  reference.load()
    .then(r => console.log('  Données de référence chargées :', JSON.stringify(r.counts)))
    .catch(e => console.warn('  Référence non chargée :', (e.message || '').split('\n')[0]));
  marketprice.load()
    .then(m => console.log('  Prix marché chargés :', JSON.stringify(m.meta)))
    .catch(e => console.warn('  Prix marché non chargés :', (e.message || '').split('\n')[0]));
});
