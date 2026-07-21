'use strict';
const sf = require('./sf');

const PREFILL_FIELDS = [
  'Id', 'Name', 'TypeLigne__c', 'TypeTarifs__c', 'MargeGlobale__c',
  'PrixU__c', 'PrixHP__c', 'PrixHC__c', 'PrixHPH__c', 'PrixHCH__c', 'PrixHPE__c', 'PrixHCE__c', 'PrixHPTE__c',
  'PrixCAPA__c', 'PrixCapaHP__c', 'PrixCapaHC__c', 'PrixCapaHPH__c', 'PrixCapaHCH__c', 'PrixCapaHPE__c', 'PrixCapaHCE__c', 'PrixCapaHPTE__c',
  'PrixAbo__c', 'EnergieVerte__c', 'CEE_user__c', 'CPB__c', 'TICGN__c', 'PrixPartVarDistri__c',
  'TurpeInclus__c', 'CAPAInclus__c', 'CEEInclus__c', 'Acheminement_gaz__c',
  'Prix_Moyen_Pondere_Non_Marge__c', 'DureeMois__c', 'DateDebut__c', 'DateFin__c',
  'Offre__r.Compteur__c', 'Offre__r.Name', 'Offre__r.Date_de_fin_contrat_CE__c', 'LastModifiedDate',
];

function soqlEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function num(x) { return x == null ? null : Number(x); }

function toInputs(r) {
  return {
    typeTarifs: r.TypeTarifs__c || 'Unique',
    margeGlobal: num(r.MargeGlobale__c),
    prixU: num(r.PrixU__c), prixHP: num(r.PrixHP__c), prixHC: num(r.PrixHC__c),
    prixHPH: num(r.PrixHPH__c), prixHCH: num(r.PrixHCH__c), prixHPE: num(r.PrixHPE__c),
    prixHCE: num(r.PrixHCE__c), prixHPTE: num(r.PrixHPTE__c),
    prixCAPA: num(r.PrixCAPA__c), prixCapaHP: num(r.PrixCapaHP__c), prixCapaHC: num(r.PrixCapaHC__c),
    prixCapaHPH: num(r.PrixCapaHPH__c), prixCapaHCH: num(r.PrixCapaHCH__c), prixCapaHPE: num(r.PrixCapaHPE__c),
    prixCapaHCE: num(r.PrixCapaHCE__c), prixCapaHPTE: num(r.PrixCapaHPTE__c),
    prixAbo: num(r.PrixAbo__c), energieVerte: num(r.EnergieVerte__c), ceeUser: num(r.CEE_user__c),
    cpbUser: num(r.CPB__c), ticgn: num(r.TICGN__c), prixPartVarDistri: num(r.PrixPartVarDistri__c),
    turpeInclus: !!r.TurpeInclus__c, capaInclus: !!r.CAPAInclus__c, ceeInclus: !!r.CEEInclus__c,
  };
}

async function byAccount(accountId) {
  const id = soqlEscape(accountId.trim());
  const base = `SELECT ${PREFILL_FIELDS.join(', ')} FROM LigneOffre__c WHERE`;
  const typeCond = `AND TypeLigne__c IN ('Actuelle','Actuellement') ORDER BY LastModifiedDate DESC LIMIT 200`;

  let rows = await sf.query(`${base} Offre__r.Compteur__r.Compte__c = '${id}' ${typeCond}`);

  // Chercher les comptes enfants (hiérarchie)
  let childIds = [];
  try {
    const children = await sf.query(`SELECT Id FROM Account WHERE ParentId = '${id}'`);
    childIds = children.map(a => a.Id);
  } catch (e) { /* ignore */ }

  if (childIds.length) {
    const inList = childIds.map(i => `'${soqlEscape(i)}'`).join(',');
    try {
      const enfantRows = await sf.query(`${base} Offre__r.Compteur__r.Compte__c IN (${inList}) ${typeCond}`);
      rows = rows.concat(enfantRows);
    } catch (e) { /* ignore */ }
  } else if (!rows.length) {
    rows = await sf.query(`${base} Offre__r.Compteur__r.Compte_Siege__c = '${id}' ${typeCond}`);
  }

  const byCompteur = {};
  for (const r of rows) {
    const cId = r.Offre__r && r.Offre__r.Compteur__c;
    if (!cId) continue;
    if (byCompteur[cId]) continue;
    byCompteur[cId] = {
      ligneOffreId: r.Id,
      ligneOffreName: r.Name,
      offreName: r.Offre__r.Name,
      inputs: toInputs(r),
      dureeMois: num(r.DureeMois__c),
      prixMoyenNonMarge: num(r.Prix_Moyen_Pondere_Non_Marge__c),
      dateDebutContrat: r.DateDebut__c || null,
      dateFinContrat: r.DateFin__c || null,
      dateFinContratCE: (r.Offre__r && r.Offre__r.Date_de_fin_contrat_CE__c) || null,
      acheminementGaz: num(r.Acheminement_gaz__c),
    };
  }
  return byCompteur;
}

module.exports = { byAccount };
