'use strict';
/**
 * Chargement et mise en cache des données de référence du moteur :
 *  - Custom Labels (snapshot labels.json — taux de taxes, TCK, prix distribution gaz)
 *  - Grilles TURPE (TURPE_CG__c, TURPE_CC__c, TURPE_CS__c)  [live]
 *  - ATRD par segment (ATRD_Fixe__mdt)                       [live]
 *  - Métadonnées acheminement gaz (Coeff_A, Coeff_ZI, Client_Distribution) [live]
 *
 * Les grilles/métadonnées sont interrogées en direct via la CLI puis mises en cache
 * en mémoire, de sorte que l'outil reste synchronisé avec l'org sans figer les barèmes.
 */
const fs = require('fs');
const path = require('path');
const sf = require('./sf');

const labels = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'labels.json'), 'utf8'));

let cache = null;

async function safeQuery(soql, opts) {
  try { return await sf.query(soql, opts); }
  catch (e) { console.warn('[reference] requête ignorée:', e.message.split('\n')[0]); return []; }
}

// TURPE_CS : certains champs (Tarif_Base/HC/HP) peuvent être masqués par la FLS de l'utilisateur.
// On tente la requête complète, et en cas d'échec on retombe sur le jeu de champs « cœur ».
async function loadTurpeCS() {
  const full = 'SELECT coefficient__c, BTSup36kVA__c, Tension__c, Profil__c, Type_de_pointe__c, AutoProduction__c, Part_autoproduction__c, Tarif_HCB__c, Tarif_HCH__c, Tarif_HPB__c, Tarif_HPH__c, Tarif_PTE__c, Tarif_Base__c, Tarif_HC__c, Tarif_HP__c FROM TURPE_CS__c';
  const core = 'SELECT coefficient__c, BTSup36kVA__c, Tension__c, Profil__c, Type_de_pointe__c, AutoProduction__c, Part_autoproduction__c, Tarif_HCB__c, Tarif_HCH__c, Tarif_HPB__c, Tarif_HPH__c, Tarif_PTE__c FROM TURPE_CS__c';
  try { return { rows: await sf.query(full), partial: false }; }
  catch (e) {
    console.warn('[reference] TURPE_CS complet refusé (FLS ?), repli sur champs cœur:', e.message.split('\n')[0]);
    try { return { rows: await sf.query(core), partial: true }; }
    catch (e2) { console.warn('[reference] TURPE_CS indisponible:', e2.message.split('\n')[0]); return { rows: [], partial: true }; }
  }
}

async function load(force = false) {
  if (cache && !force) return cache;

  const [turpeCG, turpeCC, csRes, atrdRows, coeffA, coeffZI, clientDistribution] = await Promise.all([
    safeQuery('SELECT Tension__c, CARD__c, AutoProducteur__c, BTSup36kVA__c, Tarif__c FROM TURPE_CG__c'),
    safeQuery('SELECT Tension__c, Propri_t_AOD__c, BT36kVA__c, Tarif__c FROM TURPE_CC__c'),
    loadTurpeCS(),
    safeQuery('SELECT DeveloperName, T1__c, T2__c, T3__c, T4__c FROM ATRD_Fixe__mdt'),
    safeQuery('SELECT GRT__c, Code_GRD__c, Valeur_Coeff_A__c FROM Coeff_A__mdt'),
    safeQuery('SELECT Code_Station_Meteo__c, P011__c, P012__c, P013__c, P014__c, P015__c, P016__c, P017__c, P018__c, P019__c FROM Coeff_ZI__mdt'),
    safeQuery('SELECT DeveloperName, TCS__c, TCR__c, TCL__c FROM Client_Distribution__mdt'),
  ]);
  const turpeCS = csRes.rows;

  // ATRD : on prend l'enregistrement "ATRD_Fixe" sinon le premier
  let atrdBySegment = null;
  if (atrdRows.length) {
    const row = atrdRows.find(r => r.DeveloperName === 'ATRD_Fixe') || atrdRows[0];
    atrdBySegment = { T1: row.T1__c, T2: row.T2__c, T3: row.T3__c, T4: row.T4__c };
  }

  cache = {
    labels, turpeCG, turpeCC, turpeCS, atrdBySegment, coeffA, coeffZI, clientDistribution,
    turpeCSPartial: csRes.partial,
    loadedAt: new Date().toISOString(),
    counts: {
      turpeCG: turpeCG.length, turpeCC: turpeCC.length, turpeCS: turpeCS.length,
      turpeCSPartial: csRes.partial,
      atrd: atrdRows.length, coeffA: coeffA.length, coeffZI: coeffZI.length,
      clientDistribution: clientDistribution.length,
    },
  };
  return cache;
}

module.exports = { load, labels };
