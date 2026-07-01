'use strict';
/**
 * Prix marché « estimé » — agrégation en direct des lignes d'offre Proposition récentes.
 *
 * Réplique le rapport Salesforce « box prix v2 » : prix moyen pondéré NON MARGÉ
 * (Prix_Moyen_Pondere_Non_Marge__c, €/MWh) des propositions des N derniers jours,
 * groupé par énergie × segment × catégorie APE/NAF, hors fournisseurs non pertinents.
 *
 * Choix de robustesse (vs le simple export) :
 *  - médiane (insensible aux outliers) + fourchette interquartile P25–P75,
 *  - plancher de plausibilité (élec ≥ 20, gaz ≥ 10 €/MWh) pour écarter les erreurs,
 *  - taille d'échantillon exposée, repli au niveau segment si cellule trop mince.
 */
const sf = require('./sf');

// Fournisseurs exclus (repris du filtre du rapport) — comparaison en minuscules.
const EXCLUDED = new Set([
  'lucia', 'volterres', 'elmy fourniture', 'fournisseur inconnu',
  'electricite de france', 'soregies', 'selia', 'enercoop', 'gazelenergie solutions',
]);
const FLOOR = { elec: 20, gaz: 10 }; // €/MWh : en-dessous = donnée aberrante
const CEIL = 150;                    // €/MWh : plafond (comme le rapport)
const MIN_N_EXACT = 3;               // taille mini pour une suggestion (segment × catégorie)

let cache = null;

function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function pct(a, p) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1)))); return s[i]; }
function r2(x) { return x == null ? null : Math.round(x * 100) / 100; }

function statsOf(prices) {
  return { n: prices.length, median: r2(median(prices)), mean: r2(prices.reduce((a, b) => a + b, 0) / prices.length), p25: r2(pct(prices, 25)), p75: r2(pct(prices, 75)), min: r2(Math.min(...prices)), max: r2(Math.max(...prices)) };
}

async function load(days = 30, force = false) {
  if (cache && !force) return cache;
  const soql = `SELECT Offre__r.Compteur__r.RecordType.DeveloperName rt, Offre__r.Compteur__r.Segment__c seg, Offre__r.Categorie_APE_NAF__c cat, Fournisseur__r.Name frs, Prix_Moyen_Pondere_Non_Marge__c prix FROM LigneOffre__c WHERE TypeLigne__c='Proposition' AND CreatedDate = LAST_N_DAYS:${days} AND Prix_Moyen_Pondere_Non_Marge__c != null AND Prix_Moyen_Pondere_Non_Marge__c > 0 AND Prix_Moyen_Pondere_Non_Marge__c < ${CEIL}`;
  let rows;
  try { rows = await sf.query(soql); }
  catch (e) {
    // SOQL n'accepte pas les alias hors agrégation : on retombe sur les chemins complets.
    const soql2 = `SELECT Offre__r.Compteur__r.RecordType.DeveloperName, Offre__r.Compteur__r.Segment__c, Offre__r.Categorie_APE_NAF__c, Fournisseur__r.Name, Prix_Moyen_Pondere_Non_Marge__c FROM LigneOffre__c WHERE TypeLigne__c='Proposition' AND CreatedDate = LAST_N_DAYS:${days} AND Prix_Moyen_Pondere_Non_Marge__c != null AND Prix_Moyen_Pondere_Non_Marge__c > 0 AND Prix_Moyen_Pondere_Non_Marge__c < ${CEIL}`;
    rows = await sf.query(soql2);
  }

  const byKey = {}, bySeg = {};
  let kept = 0, excluded = 0;
  for (const r of rows) {
    const c = r.Offre__r && r.Offre__r.Compteur__r;
    const en = ((c && c.RecordType && c.RecordType.DeveloperName) || '').toLowerCase();
    const seg = (c && c.Segment__c) || null;
    const cat = (r.Offre__r && r.Offre__r.Categorie_APE_NAF__c) || null;
    const frs = ((r.Fournisseur__r && r.Fournisseur__r.Name) || '').trim();
    const prix = Number(r.Prix_Moyen_Pondere_Non_Marge__c);
    if ((en !== 'elec' && en !== 'gaz') || !seg) continue;
    if (EXCLUDED.has(frs.toLowerCase())) { excluded++; continue; }
    if (prix < (FLOOR[en] || 0)) { excluded++; continue; } // plancher de plausibilité
    kept++;
    const k = `${en}|${seg}|${cat || '—'}`;
    (byKey[k] = byKey[k] || []).push(prix);
    const ks = `${en}|${seg}`;
    (bySeg[ks] = bySeg[ks] || []).push(prix);
  }

  const tableKey = {}; for (const k of Object.keys(byKey)) tableKey[k] = statsOf(byKey[k]);
  const tableSeg = {}; for (const k of Object.keys(bySeg)) tableSeg[k] = statsOf(bySeg[k]);

  cache = {
    byKey: tableKey, bySeg: tableSeg,
    meta: { days, kept, excluded, total: rows.length, loadedAt: new Date().toISOString() },
  };
  return cache;
}

/** Suggestion pour un compteur. level: 'exact' (segment×catégorie) | 'segment' | 'none'. */
function suggest(mp, energie, segment, categorie) {
  if (!mp || !segment) return { level: 'none' };
  const k = `${energie}|${segment}|${categorie || '—'}`;
  const exact = mp.byKey[k];
  if (exact && exact.n >= MIN_N_EXACT) return { level: 'exact', segment, categorie, ...exact };
  const seg = mp.bySeg[`${energie}|${segment}`];
  if (seg && seg.n >= 1) return { level: 'segment', segment, categorie, ...seg };
  return { level: 'none' };
}

module.exports = { load, suggest };
