'use strict';
/**
 * Récupération des compteurs d'un compte + enrichissement (RefGeo, APE/NAF, PITD, RecordType)
 * dans la forme attendue par le moteur (engine.buildCompteurDTO).
 */
const sf = require('./sf');

const COMPTEUR_FIELDS = [
  'Id', 'Name', 'Energie__c', 'Segment__c', 'Segment_turpe__c',
  'TensionCompteur__c', 'ProfilCompteur__c', 'Type2Pointe__c', 'Code_Acheminement__c',
  'Superieur36kVA__c', 'CARD__c', 'Autoproducteur__c', 'AutoproductionPart__c', 'ProprieteAOD__c',
  'PuissanceSouscrite__c', 'PuissanceHCE__c', 'PuissanceHCH__c', 'PuissanceHPE__c',
  'PuissanceHPH__c', 'PuissanceHC__c', 'PuissanceHP__c', 'PuissanceHPTE__c',
  'VolumeTotalAnnuel__c', 'VolumeReference__c', 'VolumeEstime__c', 'VolumeBase__c', 'VolumeReel__c',
  'VolumeHCE__c', 'VolumeHCH__c', 'VolumeHPE__c', 'VolumeHPH__c', 'VolumeHC__c', 'VolumeHP__c', 'VolumeHPTE__c',
  'ProfilCompteurGaz__c', 'EtatPDL__c', 'Fournisseur_Actuel_Nom__c',
  'RecordType.DeveloperName',
  'RefGeo__r.TaxeCom_TarifPro_Tranche1__c', 'RefGeo__r.TaxeCom_TarifPro_Tranche2__c',
  'RefGeo__r.TaxeDep_TarifPro_Tranche1__c', 'RefGeo__r.TaxeDep_TarifPro_Tranche2__c',
  'PITD__r.Nom_GRT__c', 'PITD__r.Nom_GRD__c', 'PITD__r.Code_GRD__c',
  'PITD__r.Code_station_meteo__c', 'PITD__r.Niveau_Tarifaire_Regional_NTR__c',
  'Compte__r.Name', 'Compte__r.APE_NAF__r.CEE__c', 'Compte__r.APE_NAF__r.CSPE__c',
  'Compte__r.APE_NAF__r.TICGN__c', 'Compte__r.APE_NAF__r.CPB__c', 'Compte__r.APE_NAF__r.Categorie__c',
];

function num(x) { return x == null ? null : Number(x); }

// Aplatit un record SOQL en objet plat consommable par le moteur
function flatten(r) {
  const rt = r.RecordType ? r.RecordType.DeveloperName : null;
  const refgeo = r.RefGeo__r || {};
  const pitd = r.PITD__r || null;
  const apenaf = (r.Compte__r && r.Compte__r.APE_NAF__r) ? r.Compte__r.APE_NAF__r : null;
  return {
    Id: r.Id,
    Name: r.Name,
    recordTypeDeveloperName: rt,
    Energie__c: r.Energie__c,
    Segment__c: r.Segment__c,
    TensionCompteur__c: r.TensionCompteur__c,
    ProfilCompteur__c: r.ProfilCompteur__c,
    Type2Pointe__c: r.Type2Pointe__c,
    Code_Acheminement__c: r.Code_Acheminement__c,
    Superieur36kVA__c: r.Superieur36kVA__c,
    CARD__c: r.CARD__c,
    Autoproducteur__c: r.Autoproducteur__c,
    AutoproductionPart__c: r.AutoproductionPart__c,
    ProprieteAOD__c: r.ProprieteAOD__c,
    PuissanceSouscrite__c: num(r.PuissanceSouscrite__c),
    PuissanceHCE__c: num(r.PuissanceHCE__c), PuissanceHCH__c: num(r.PuissanceHCH__c),
    PuissanceHPE__c: num(r.PuissanceHPE__c), PuissanceHPH__c: num(r.PuissanceHPH__c),
    PuissanceHC__c: num(r.PuissanceHC__c), PuissanceHP__c: num(r.PuissanceHP__c),
    PuissanceHPTE__c: num(r.PuissanceHPTE__c),
    VolumeTotalAnnuel__c: num(r.VolumeTotalAnnuel__c),
    VolumeReference__c: num(r.VolumeReference__c),
    VolumeEstime__c: num(r.VolumeEstime__c),
    VolumeBase__c: num(r.VolumeBase__c),
    VolumeReel__c: num(r.VolumeReel__c),
    VolumeHCE__c: num(r.VolumeHCE__c), VolumeHCH__c: num(r.VolumeHCH__c),
    VolumeHPE__c: num(r.VolumeHPE__c), VolumeHPH__c: num(r.VolumeHPH__c),
    VolumeHC__c: num(r.VolumeHC__c), VolumeHP__c: num(r.VolumeHP__c),
    VolumeHPTE__c: num(r.VolumeHPTE__c),
    ProfilCompteurGaz__c: r.ProfilCompteurGaz__c,
    EtatPDL__c: r.EtatPDL__c,
    Fournisseur_Actuel_Nom__c: r.Fournisseur_Actuel_Nom__c,
    compteNom: r.Compte__r ? r.Compte__r.Name : null,
    categorie: (r.Compte__r && r.Compte__r.APE_NAF__r) ? r.Compte__r.APE_NAF__r.Categorie__c : null,
    refgeo_TaxeCom_Tranche1: num(refgeo.TaxeCom_TarifPro_Tranche1__c),
    refgeo_TaxeCom_Tranche2: num(refgeo.TaxeCom_TarifPro_Tranche2__c),
    refgeo_TaxeDep_Tranche1: num(refgeo.TaxeDep_TarifPro_Tranche1__c),
    refgeo_TaxeDep_Tranche2: num(refgeo.TaxeDep_TarifPro_Tranche2__c),
    pitd: pitd ? {
      Nom_GRT__c: pitd.Nom_GRT__c, Nom_GRD__c: pitd.Nom_GRD__c, Code_GRD__c: pitd.Code_GRD__c,
      Code_station_meteo__c: pitd.Code_station_meteo__c,
      Niveau_Tarifaire_Regional_NTR__c: num(pitd.Niveau_Tarifaire_Regional_NTR__c),
    } : null,
    apenaf: apenaf ? {
      CEE__c: apenaf.CEE__c, CSPE__c: apenaf.CSPE__c,
      TICGN__c: apenaf.TICGN__c, CPB__c: apenaf.CPB__c,
    } : null,
  };
}

// Échappe une valeur pour une clause SOQL (anti-injection basique)
function soqlEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// Récupère un lot de compteurs par leurs Ids (utilisé par les tests de fidélité)
async function byIds(ids) {
  if (!ids || !ids.length) return [];
  const list = ids.map(i => `'${soqlEscape(i)}'`).join(',');
  const select = `SELECT ${COMPTEUR_FIELDS.join(', ')} FROM Compteur__c WHERE Id IN (${list})`;
  const rows = await sf.query(select);
  return rows.map(flatten);
}

async function byAccount(accountId) {
  const id = soqlEscape(accountId.trim());

  const select = `SELECT ${COMPTEUR_FIELDS.join(', ')} FROM Compteur__c WHERE Compte__c = '${id}' ORDER BY Name`;
  let rows = await sf.query(select);

  // Chercher les comptes enfants (hiérarchie)
  let childIds = [];
  try {
    const children = await sf.query(`SELECT Id FROM Account WHERE ParentId = '${id}'`);
    childIds = children.map(a => a.Id);
  } catch (e) { /* ignore */ }

  if (childIds.length) {
    const inList = childIds.map(i => `'${soqlEscape(i)}'`).join(',');
    try {
      const enfantRows = await sf.query(`SELECT ${COMPTEUR_FIELDS.join(', ')} FROM Compteur__c WHERE Compte__c IN (${inList}) ORDER BY Compte__r.Name, Name`);
      rows = rows.concat(enfantRows);
    } catch (e) { console.warn('[compteurs] hiérarchie ignorée:', e.message.split('\n')[0]); }
  } else if (!rows.length) {
    // fallback : compteurs rattachés via le compte siège
    const select2 = `SELECT ${COMPTEUR_FIELDS.join(', ')} FROM Compteur__c WHERE Compte_Siege__c = '${id}' ORDER BY Name`;
    rows = await sf.query(select2);
  }

  // Dédoublonner par Id (un compteur peut apparaître via les 2 chemins)
  const seen = new Set();
  const unique = [];
  for (const r of rows) {
    if (!seen.has(r.Id)) { seen.add(r.Id); unique.push(r); }
  }
  return unique.map(flatten);
}

module.exports = { byAccount, byIds, flatten, COMPTEUR_FIELDS };
