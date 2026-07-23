'use strict';
/**
 * Prix marché & CEE — extraction en direct des lignes d'offre « Proposition » récentes.
 *
 * On renvoie les enregistrements BRUTS (déjà nettoyés des valeurs aberrantes et des
 * fournisseurs non pertinents). L'agrégation (médiane par segment × catégorie, filtre par
 * période de livraison, split proposition/retenue) est faite côté client pour permettre un
 * filtrage dynamique par période sans re-requêter Salesforce.
 *
 * Garde-fous appliqués ici :
 *  - fenêtre glissante (CreatedDate = LAST_N_DAYS)
 *  - plancher/plafond de plausibilité du prix (élec ≥ 20, gaz ≥ 10, < 150 €/MWh)
 *  - exclusion des fournisseurs non représentatifs
 * Champs par enregistrement : en, seg, cat, p (prix HT non margé), c (CEE €/MWh), dd/df
 * (période de livraison DateDebut/DateFin), ret (offre retenue = signée).
 */
const sf = require('./sf');

const EXCLUDED = new Set([
  'lucia', 'volterres', 'elmy fourniture', 'fournisseur inconnu',
  'electricite de france', 'soregies', 'selia', 'enercoop', 'gazelenergie solutions',
]);
const FLOOR = { elec: 20, gaz: 10 }; // €/MWh : en-dessous = donnée aberrante
const CEIL = 150;                    // €/MWh : plafond prix
const CEE_CEIL = 100;                // €/MWh : plafond plausibilité CEE

let cache = null;

async function load(days = 30, force = false) {
  if (cache && !force) return cache;
  const soql = `SELECT CreatedDate, Name, Prix_Moyen_Pondere__c, Offre__r.Name, Offre__r.Opportunity__r.Name, Offre__r.Compteur__r.RecordType.DeveloperName, Offre__r.Compteur__r.Segment__c, Offre__r.Categorie_APE_NAF__c, Fournisseur__r.Name, Statut__c, Prix_Moyen_Pondere_Non_Marge__c, CEE_user__c, Volume_du_compteur__c, DateDebut__c, DateFin__c FROM LigneOffre__c WHERE TypeLigne__c='Proposition' AND CreatedDate = LAST_N_DAYS:${days} AND Prix_Moyen_Pondere_Non_Marge__c != null AND Prix_Moyen_Pondere_Non_Marge__c > 0 AND Prix_Moyen_Pondere_Non_Marge__c < ${CEIL}`;
  const rows = await sf.query(soql);

  const records = [];
  let excluded = 0;
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

    // CEE (€/MWh) : conservé si présent et plausible
    let cee = r.CEE_user__c == null ? null : Number(r.CEE_user__c);
    if (cee != null && (cee < 0 || cee >= CEE_CEIL)) cee = null;

    const pm = r.Prix_Moyen_Pondere__c;
    records.push({
      en, seg, cat: cat || '—',
      p: Math.round(prix * 100) / 100,
      pm: pm != null ? Math.round(Number(pm) * 100) / 100 : null,
      lo: r.Name || null,
      c: cee == null ? null : Math.round(cee * 100) / 100,
      dd: r.DateDebut__c || null,
      df: r.DateFin__c || null,
      ret: r.Statut__c === 'Retenue',
      frs: frs || null,
      offre: (r.Offre__r && r.Offre__r.Name) || null,
      opp: (r.Offre__r && r.Offre__r.Opportunity__r && r.Offre__r.Opportunity__r.Name) || null,
      volC: r.Volume_du_compteur__c != null ? Math.round(Number(r.Volume_du_compteur__c) * 100) / 100 : null,
      cd: r.CreatedDate ? r.CreatedDate.slice(0, 10) : null,
    });
  }

  cache = {
    records,
    meta: { days, total: rows.length, kept: records.length, excluded, loadedAt: new Date().toISOString() },
  };
  return cache;
}

module.exports = { load };
