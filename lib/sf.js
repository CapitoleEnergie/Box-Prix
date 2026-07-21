'use strict';
/**
 * Couche d'accès Salesforce via la CLI `sf`.
 * Lance `sf data query` en sous-processus et parse le JSON.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Localise l'exécutable sf : variable d'env > chemin par défaut Windows > "sf" dans le PATH
function resolveSfPath() {
  if (process.env.SF_CLI_PATH && fs.existsSync(process.env.SF_CLI_PATH)) return process.env.SF_CLI_PATH;
  const def = 'C:\\Program Files\\sf\\bin\\sf.cmd';
  if (fs.existsSync(def)) return def;
  return process.platform === 'win32' ? 'sf.cmd' : 'sf';
}

const SF_PATH = resolveSfPath();
const ORG = process.env.SF_ORG || 'prod';

let seq = 0;

/**
 * Exécute une requête SOQL et renvoie les records. tooling=true pour la Tooling API.
 * La requête est écrite dans un fichier temporaire (--file) pour éviter tout problème
 * de quoting sur la ligne de commande. shell:true est requis pour exécuter sf.cmd sous Windows.
 */
function query(soql, { tooling = false } = {}) {
  return new Promise((resolve, reject) => {
    const file = path.join(os.tmpdir(), `sfq_${process.pid}_${Date.now()}_${seq++}.soql`);
    try { fs.writeFileSync(file, soql, 'utf8'); }
    catch (e) { return reject(e); }

    const args = ['data', 'query', '--file', `"${file}"`, '-o', ORG, '--json'];
    if (tooling) args.push('-t');
    // shell:true => on cite nous-mêmes l'exécutable (chemin avec espaces) et le fichier.
    const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };
    execFile(`"${SF_PATH}"`, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true, shell: true, env }, (err, stdout, stderr) => {
      fs.unlink(file, () => {});
      let parsed = null;
      // Strip ANSI escape codes + warnings avant le JSON
      let jsonStr = stdout.replace(/\x1b\[[0-9;]*m/g, '');
      const jsonStart = jsonStr.indexOf('{');
      if (jsonStart > 0) jsonStr = jsonStr.slice(jsonStart);
      try { parsed = JSON.parse(jsonStr); } catch (_) { /* ignore */ }
      if (parsed && parsed.status === 0 && parsed.result) return resolve(parsed.result.records || []);
      const msg = (parsed && parsed.message) || (stderr || '').replace(/\x1b\[[0-9;]*m/g, '').trim() || (err && err.message) || 'Erreur SOQL inconnue';
      reject(new Error(msg));
    });
  });
}

/** Vérifie la connexion à l'org. */
async function whoami() {
  const rows = await query('SELECT Id, Name FROM Organization LIMIT 1');
  return rows[0] || null;
}

module.exports = { query, whoami, SF_PATH, ORG };
