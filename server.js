'use strict';
/**
 * Serveur local du Simulateur Budgétaire.
 * - Sert le frontend statique (public/)
 * - API :
 *     GET  /api/health                  -> état + connexion org + compteurs de référence chargés
 *     GET  /api/account/:id/compteurs   -> compteurs d'un compte
 *     POST /api/compute                 -> simulation (budget actuel / estimé / différence)
 *
 * Zéro dépendance externe (modules Node natifs uniquement).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const sf = require('./lib/sf');
const reference = require('./lib/reference');
const compteurs = require('./lib/compteurs');
const engine = require('./lib/engine');
const marketprice = require('./lib/marketprice');
const prefill = require('./lib/prefill');

const PORT = process.env.PORT || 4173;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;
  try {
    if (p === '/api/health') {
      let org = null, orgErr = null;
      try { org = await sf.whoami(); } catch (e) { orgErr = e.message.split('\n')[0]; }
      let ref = null, refErr = null;
      try { ref = await reference.load(); } catch (e) { refErr = e.message.split('\n')[0]; }
      return sendJSON(res, 200, {
        ok: !!org, org, orgErr,
        sfPath: sf.SF_PATH, orgAlias: sf.ORG,
        reference: ref ? { loadedAt: ref.loadedAt, counts: ref.counts } : null,
        labels: ref ? ref.labels : reference.labels,
        refErr,
      });
    }

    if (p === '/api/marketprice') {
      try { return sendJSON(res, 200, await marketprice.load()); }
      catch (e) { return sendJSON(res, 200, { byKey: {}, bySeg: {}, meta: { error: e.message.split('\n')[0] } }); }
    }

    const mAcc = p.match(/^\/api\/account\/([^/]+)\/compteurs$/);
    if (mAcc) {
      const id = decodeURIComponent(mAcc[1]);
      const list = await compteurs.byAccount(id);
      return sendJSON(res, 200, { accountId: id, count: list.length, compteurs: list });
    }

    const mPrefill = p.match(/^\/api\/account\/([^/]+)\/prefill$/);
    if (mPrefill) {
      const id = decodeURIComponent(mPrefill[1]);
      const data = await prefill.byAccount(id);
      return sendJSON(res, 200, { accountId: id, byCompteur: data });
    }

    if (p === '/api/compute' && req.method === 'POST') {
      const body = await readBody(req);
      const ref = await reference.load();
      const { compteur, actuel, estime, overrides } = body;
      if (!compteur) return sendJSON(res, 400, { error: 'compteur manquant' });
      const result = engine.simulateCompteur(compteur, actuel, estime, ref, overrides || {});
      return sendJSON(res, 200, result);
    }

    if (p.startsWith('/api/')) return sendJSON(res, 404, { error: 'route inconnue' });

    return serveStatic(req, res, p);
  } catch (e) {
    return sendJSON(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Simulateur Budgétaire — http://localhost:${PORT}`);
  console.log(`  Org Salesforce : ${sf.ORG}   |   CLI : ${sf.SF_PATH}\n`);
  reference.load()
    .then(r => console.log('  Données de référence chargées :', JSON.stringify(r.counts)))
    .catch(e => console.warn('  Référence non chargée :', e.message.split('\n')[0]));
  marketprice.load()
    .then(m => console.log('  Prix marché chargés :', JSON.stringify(m.meta)))
    .catch(e => console.warn('  Prix marché non chargés :', e.message.split('\n')[0]));
});
