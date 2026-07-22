'use strict';
/**
 * Handler API partagé — utilisé par server.js (dev local, HTTP natif Node)
 * et par api/index.js (fonction serverless Vercel).
 *
 * Contrat commun : (req, res) où req.method/req.url sont conformes au module http.
 * Renvoie true si la route a été gérée (JSON ou PDF), false sinon.
 */
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const sf = require('./sf');
const reference = require('./reference');
const compteurs = require('./compteurs');
const engine = require('./engine');
const marketprice = require('./marketprice');
const prefill = require('./prefill');
const account = require('./account');
const invoiceExtractor = require('./invoice-extractor');
const { htmlToPdf } = require('./pdf-generate');

// ---------- .env loader (dev local seulement — no-op sur Vercel) ----------
(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[m[1]]) process.env[m[1]] = val;
    }
  } catch { /* ignore */ }
})();

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, maxBytes = 12e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > maxBytes) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const u = new URL(req.url, `http://localhost`);
  const p = u.pathname;

  try {
    if (p === '/api/health') {
      let org = null, orgErr = null;
      try { org = await sf.whoami(); } catch (e) { orgErr = (e.message || '').split('\n')[0]; }
      let ref = null, refErr = null;
      try { ref = await reference.load(); } catch (e) { refErr = (e.message || '').split('\n')[0]; }
      sendJSON(res, 200, {
        ok: !!org, org, orgErr,
        sfPath: sf.SF_PATH, orgAlias: sf.ORG,
        reference: ref ? { loadedAt: ref.loadedAt, counts: ref.counts } : null,
        labels: ref ? ref.labels : reference.labels,
        refErr,
      });
      return true;
    }

    if (p === '/api/marketprice') {
      try { sendJSON(res, 200, await marketprice.load()); }
      catch (e) { sendJSON(res, 200, { byKey: {}, bySeg: {}, meta: { error: (e.message || '').split('\n')[0] } }); }
      return true;
    }

    const mAcc = p.match(/^\/api\/account\/([^/]+)\/compteurs$/);
    if (mAcc) {
      const id = decodeURIComponent(mAcc[1]);
      const list = await compteurs.byAccount(id);
      sendJSON(res, 200, { accountId: id, count: list.length, compteurs: list });
      return true;
    }

    const mPrefill = p.match(/^\/api\/account\/([^/]+)\/prefill$/);
    if (mPrefill) {
      const id = decodeURIComponent(mPrefill[1]);
      const data = await prefill.byAccount(id);
      sendJSON(res, 200, { accountId: id, byCompteur: data });
      return true;
    }

    const mMeta = p.match(/^\/api\/account\/([^/]+)\/meta$/);
    if (mMeta) {
      const id = decodeURIComponent(mMeta[1]);
      const data = await account.meta(id);
      sendJSON(res, 200, { accountId: id, ...data });
      return true;
    }

    if (p === '/api/compute' && req.method === 'POST') {
      const body = await readBody(req);
      const ref = await reference.load();
      const { compteur, actuel, estime, overrides } = body;
      if (!compteur) { sendJSON(res, 400, { error: 'compteur manquant' }); return true; }
      const result = engine.simulateCompteur(compteur, actuel, estime, ref, overrides || {});
      sendJSON(res, 200, result);
      return true;
    }

    if (p === '/api/export-pdf' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.html) { sendJSON(res, 400, { error: 'html manquant' }); return true; }
      try {
        const pdf = await htmlToPdf(body.html);
        const filename = body.filename || 'simulation.pdf';
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': pdf.length,
        });
        res.end(pdf);
      } catch (e) {
        sendJSON(res, 500, { error: 'Échec génération PDF: ' + ((e.message || '').split('\n')[0]) });
      }
      return true;
    }

    if (p === '/api/extract-invoice' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.pdfBase64) { sendJSON(res, 400, { error: 'pdfBase64 manquant' }); return true; }
      try {
        const buffer = Buffer.from(body.pdfBase64, 'base64');
        const result = await invoiceExtractor.extractFromPdf(buffer);
        sendJSON(res, 200, result);
      } catch (e) {
        sendJSON(res, 500, { error: 'Extraction échouée : ' + ((e.message || '').split('\n')[0]) });
      }
      return true;
    }

    if (p.startsWith('/api/')) { sendJSON(res, 404, { error: 'route inconnue' }); return true; }
    return false;
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
    return true;
  }
}

module.exports = { handle };
