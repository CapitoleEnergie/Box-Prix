'use strict';
/**
 * Client Salesforce REST (compatible serverless / Vercel).
 *
 * Authentification : OAuth 2.0 Client Credentials Flow (server-to-server).
 * Le "Run As User" est configuré côté Salesforce dans l'External Client App.
 * Le token d'accès est mis en cache en mémoire jusqu'à son expiration.
 *
 * Variables d'environnement requises :
 *   SF_LOGIN_URL       (défaut https://login.salesforce.com — pour sandbox : https://test.salesforce.com ;
 *                       pour Client Credentials il faut souvent utiliser l'URL "My Domain" :
 *                       https://<mondomain>.my.salesforce.com)
 *   SF_CLIENT_ID       — Consumer Key de l'External Client App
 *   SF_CLIENT_SECRET   — Consumer Secret de l'External Client App
 *   SF_API_VERSION     — défaut '60.0'
 */

const LOGIN_URL = (process.env.SF_LOGIN_URL || 'https://login.salesforce.com').replace(/\/$/, '');
const API_VERSION = process.env.SF_API_VERSION || '60.0';

let tokenCache = null; // { accessToken, instanceUrl, expiresAt }

async function getToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache;

  const clientId = process.env.SF_CLIENT_ID;
  const clientSecret = process.env.SF_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Config Salesforce manquante : SF_CLIENT_ID, SF_CLIENT_SECRET');
  }

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const resp = await fetch(`${LOGIN_URL}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`Auth SF non-JSON (HTTP ${resp.status}) : ${text.slice(0, 200)}`); }
  if (!resp.ok) {
    throw new Error(`Auth SF échouée (${resp.status} ${json.error || ''}) : ${json.error_description || text.slice(0, 200)}`);
  }

  tokenCache = {
    accessToken: json.access_token,
    instanceUrl: json.instance_url,
    // Client Credentials → token valide ~30 min ; on cache 25 min et on refresh sur 401
    expiresAt: Date.now() + 25 * 60 * 1000,
  };
  return tokenCache;
}

function invalidateToken() { tokenCache = null; }

async function apiRequest(pathAndQuery, { retry = true } = {}) {
  const tk = await getToken();
  const url = `${tk.instanceUrl}/services/data/v${API_VERSION}${pathAndQuery}`;
  const resp = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${tk.accessToken}`,
      'Accept': 'application/json',
    },
  });
  if (resp.status === 401 && retry) {
    invalidateToken();
    return apiRequest(pathAndQuery, { retry: false });
  }
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`Réponse SF non-JSON (HTTP ${resp.status}) : ${text.slice(0, 300)}`); }
  if (!resp.ok) {
    const msg = Array.isArray(json) ? (json[0] && (json[0].message || json[0].errorCode)) : (json.message || json.error);
    throw new Error(`SF ${resp.status} : ${msg || text.slice(0, 200)}`);
  }
  return json;
}

/**
 * Exécute une requête SOQL et renvoie tous les records (gère la pagination nextRecordsUrl).
 * tooling=true → API Tooling ; sinon API standard.
 */
async function query(soql, { tooling = false } = {}) {
  const endpoint = tooling ? '/tooling/query' : '/query';
  let path = `${endpoint}/?q=${encodeURIComponent(soql)}`;
  const records = [];
  while (true) {
    const result = await apiRequest(path);
    if (Array.isArray(result.records)) records.push(...result.records);
    if (result.done !== false || !result.nextRecordsUrl) break;
    // nextRecordsUrl est un chemin absolu de type /services/data/v.../query/01g...-2000
    const idx = result.nextRecordsUrl.indexOf('/services/data/');
    if (idx < 0) break;
    // Reconstruire le path relatif à /services/data/v{API}
    const after = result.nextRecordsUrl.slice(idx + `/services/data/v${API_VERSION}`.length);
    path = after;
  }
  return records;
}

async function whoami() {
  const rows = await query('SELECT Id, Name FROM Organization LIMIT 1');
  return rows[0] || null;
}

module.exports = {
  query,
  whoami,
  get SF_PATH() { return `REST v${API_VERSION} @ ${LOGIN_URL}`; },
  get ORG() { return process.env.SF_CLIENT_ID ? process.env.SF_CLIENT_ID.slice(0, 12) + '…' : 'sf'; },
};
