'use strict';
/**
 * Moteur de calcul du budget énergie — port fidèle de la chaîne Apex Salesforce.
 *
 * Chaîne d'origine :
 *   ComputeLignesOffreDTO.calculateLineValues()
 *     -> LigneOffreTarifCalculator (tarif, capacité, énergie verte, HTVA, marge, différence)
 *     -> TaxCalculator / ComputeTaxService (CTA, CSPE/TICFE, TICGN, TVA)
 *     -> TurpeCalculator (CC, CG, CS fixe/var, CI)  [électricité]
 *     -> ATRTService / ATRTCalculator (acheminement gaz)
 *
 * Le budget HTVA d'une ligne (= Calcul_TarifHorsTVA__c) est la grandeur centrale :
 *   - "budget actuel"  = HTVA de la ligne "Actuellement"
 *   - "budget estimé"  = HTVA de la ligne "Proposition"
 *   - "différence"     = estimé - actuel
 *
 * Toutes les entrées de prix sont en €/MWh (sauf abonnement en €/mois), les volumes en MWh,
 * les puissances en kVA. Les sorties sont en €/an.
 */

// Utils.getValue : null -> 0
const v = (x) => (x === null || x === undefined || Number.isNaN(x) ? 0 : Number(x));

const TENSION_BT = 'Basse Tension';
const TENSION_HT = 'Haute Tension';
const SEGMENT_C4 = 'C4';
const SEGMENT_C5 = 'C5';
const ACHEMINEMENT_BTSU = 'BTSUPCU4';
const TYPETARIF_UNIQUE = 'Unique';
const TYPETARIF_HORO = 'Horosaisonnalisé';
const TYPETARIF_HORO_HPHC = 'Horosaisonnalisé Heures Pleines/Heures Creuses';

/**
 * Construit le "CompteurDTO" à partir d'un enregistrement Compteur__c (champs API bruts)
 * + les drapeaux APE/NAF (computeCEE/CSPE/TICGN/CPB) issus du compte.
 * Port de CompteurDTOBuilder.createBasic + create + setApeNaf.
 */
function buildCompteurDTO(c, ref) {
  const recordType = (c.recordTypeDeveloperName || '').toLowerCase();
  const isElec = recordType === 'elec';
  const isGaz = recordType === 'gaz';
  const tension = c.TensionCompteur__c || '';
  const segment = c.Segment__c || '';

  const volumeTotalAnnuel = v(c.VolumeTotalAnnuel__c);
  // VolumeEstime__c prioritaire sinon VolumeReference__c (formule)
  const volumeReference = c.VolumeEstime__c != null ? Number(c.VolumeEstime__c) : v(c.VolumeReference__c);

  const dto = {
    isElec,
    isGaz,
    isBasseTension: tension === TENSION_BT,
    isHauteTension: tension === TENSION_HT,
    isC5: segment.toUpperCase() === SEGMENT_C5,
    segment,
    tension,
    profile: c.ProfilCompteur__c || '',
    typePointe: c.Type2Pointe__c || '',
    codeAcheminement: c.Code_Acheminement__c || '',
    superieur36kVA: !!c.Superieur36kVA__c,
    card: !!c.CARD__c,
    autoProducer: !!c.Autoproducteur__c,
    autoProductionPart: c.AutoproductionPart__c || null,
    propertyAOD: !!c.ProprieteAOD__c,

    volumeTotalAnnuel,
    volumeReference,
    // volume : élec -> total annuel ; gaz -> volume de référence
    volume: isElec ? volumeTotalAnnuel : volumeReference,

    puissanceSouscrite: v(c.PuissanceSouscrite__c),
    puissanceHCE: v(c.PuissanceHCE__c),
    puissanceHCH: v(c.PuissanceHCH__c),
    puissanceHPE: v(c.PuissanceHPE__c),
    puissanceHPH: v(c.PuissanceHPH__c),
    puissanceHC: v(c.PuissanceHC__c),
    puissanceHP: v(c.PuissanceHP__c),
    puissanceHPTE: v(c.PuissanceHPTE__c),

    volumeHCE: v(c.VolumeHCE__c),
    volumeHCH: v(c.VolumeHCH__c),
    volumeHPE: v(c.VolumeHPE__c),
    volumeHPH: v(c.VolumeHPH__c),
    volumeHC: v(c.VolumeHC__c),
    volumeHP: v(c.VolumeHP__c),
    volumeHPTE: v(c.VolumeHPTE__c),
    volumeBase: v(c.VolumeBase__c),

    // Taxes locales (RefGeo) — TCCFE/TDCFE neutralisés dans le calcul actuel, gardés pour fidélité
    taxComTarifProTranche1: v(c.refgeo_TaxeCom_Tranche1),
    taxComTarifProTranche2: v(c.refgeo_TaxeCom_Tranche2),
    taxDepTarifProTranche1: v(c.refgeo_TaxeDep_Tranche1),
    taxDepTarifProTranche2: v(c.refgeo_TaxeDep_Tranche2),

    // Profil gaz / PITD (acheminement)
    profilGaz: c.ProfilCompteurGaz__c || '',
    volumeReel: v(c.VolumeReel__c),

    // Drapeaux APE/NAF (taxes applicables). Si non renseignés -> false (comme Apex sans APE/NAF).
    computeCEE: !!(c.apenaf && c.apenaf.CEE__c),
    computeCSPE: !!(c.apenaf && c.apenaf.CSPE__c),
    computeTICGN: !!(c.apenaf && c.apenaf.TICGN__c),
    computeCPB: !!(c.apenaf && c.apenaf.CPB__c),
    isOptimized: false,
  };

  // TICFE (ex-CSPE) : taux selon puissance souscrite (TaxCalculator.calculateTICFETax)
  dto.ticfeRate = dto.puissanceSouscrite <= 36
    ? v(ref.labels.TaxTauxCspeBelow36kva)
    : v(ref.labels.TaxTauxCspe); // 36-249 et >249 identiques dans l'org

  return dto;
}

/* --------------------------- TURPE (électricité) --------------------------- */

// TurpeDTOBuilder.extractCompteurProfileForTurpe
function extractProfileForTurpe(p) {
  if (!p) return '';
  if (p.includes('CU')) return p.includes('CU4') ? 'CU4' : 'CU';
  if (p.includes('MU')) {
    if (p.includes('MUDT')) return 'MUDT';
    if (p.includes('MU4')) return 'MU4';
    return 'MU';
  }
  if (p.includes('LU')) return 'LU';
  return '';
}

// Égalité tolérante : null / undefined / '' sont considérés équivalents (Apex compare null==null,
// alors que nos défauts coercent parfois en chaîne vide).
function eqEmpty(a, b) {
  const na = a === null || a === undefined || a === '';
  const nb = b === null || b === undefined || b === '';
  if (na && nb) return true;
  return a === b;
}

// Sélection des lignes de grille TURPE pour un compteur (port de TurpeDTOBuilder)
function selectTurpe(dto, ref) {
  const profil = extractProfileForTurpe(dto.profile);
  const cg = ref.turpeCG.find(r =>
    eqEmpty(r.Tension__c, dto.tension) &&
    !!r.CARD__c === dto.card &&
    !!r.AutoProducteur__c === dto.autoProducer &&
    !!r.BTSup36kVA__c === dto.superieur36kVA);
  const cc = ref.turpeCC.find(r =>
    eqEmpty(r.Tension__c, dto.tension) &&
    !!r.Propri_t_AOD__c === dto.propertyAOD &&
    !!r.BT36kVA__c === dto.superieur36kVA);
  const csRows = ref.turpeCS.filter(r =>
    eqEmpty(r.Tension__c, dto.tension) &&
    eqEmpty(r.Type_de_pointe__c, dto.typePointe) &&
    !!r.AutoProduction__c === dto.autoProducer &&
    eqEmpty(r.Part_autoproduction__c, dto.autoProductionPart) &&
    !!r.BTSup36kVA__c === dto.superieur36kVA &&
    eqEmpty(r.Profil__c, profil));
  const csByCoeff = {};
  for (const r of csRows) csByCoeff[(r.coefficient__c || '').toLowerCase()] = r;
  const isLoaded = !!cc && !!cg && Object.keys(csByCoeff).length > 0;
  return { cg, cc, csByCoeff, isLoaded };
}

// TurpeCalculator.calculateFixedTurpeCs (bi)
function calcFixedTurpeCs(dto, csBi) {
  if (!csBi) return 0;
  let total = 0;
  if (dto.isBasseTension) {
    if (dto.superieur36kVA) total += v(csBi.Tarif_HPH__c) * dto.puissanceHPH;
    else total += v(csBi.Tarif_HPH__c) * dto.puissanceSouscrite;
  } else {
    total += v(csBi.Tarif_PTE__c) * dto.puissanceHPTE;
    total += v(csBi.Tarif_HPH__c) * (dto.puissanceHPH - dto.puissanceHPTE);
  }
  if (dto.isHauteTension || dto.superieur36kVA) {
    total += v(csBi.Tarif_HCH__c) * (dto.puissanceHCH - dto.puissanceHPH);
    total += v(csBi.Tarif_HPB__c) * (dto.puissanceHPE - dto.puissanceHCH);
    total += v(csBi.Tarif_HCB__c) * (dto.puissanceHCE - dto.puissanceHPE);
  }
  return total;
}

// TurpeCalculator.calculateVariableTurpeCs (ci)
function calcVariableTurpeCs(dto, csCi) {
  if (!csCi) return 0;
  let total = 0;
  if (dto.isC5) {
    total += v(csCi.Tarif_Base__c) * dto.volumeBase;
    if (dto.profile !== 'LU') {
      total += v(csCi.Tarif_HPH__c) * dto.volumeHPH;
      total += v(csCi.Tarif_HCH__c) * dto.volumeHCH;
      total += v(csCi.Tarif_HPB__c) * dto.volumeHPE;
      total += v(csCi.Tarif_HCB__c) * dto.volumeHCE;
      total += v(csCi.Tarif_HC__c) * dto.volumeHC;
      total += v(csCi.Tarif_HP__c) * dto.volumeHP;
    }
  } else {
    if (dto.isHauteTension) total += v(csCi.Tarif_PTE__c) * dto.volumeHPTE;
    total += v(csCi.Tarif_HPH__c) * dto.volumeHPH;
    total += v(csCi.Tarif_HCH__c) * dto.volumeHCH;
    total += v(csCi.Tarif_HPB__c) * dto.volumeHPE;
    total += v(csCi.Tarif_HCB__c) * dto.volumeHCE;
  }
  return total;
}

/* --------------------------- Tarif énergie --------------------------- */

function shouldComputeHpte(dto) {
  return !(dto.segment.toUpperCase() === SEGMENT_C4 &&
    (dto.codeAcheminement || '').toUpperCase() === ACHEMINEMENT_BTSU);
}

// LigneOffreTarifCalculator.calculateTarif (élec) — €/an de fourniture (marge incluse)
function calcTarifElec(line, dto) {
  let r = 0;
  const m = v(line.margeGlobal);
  switch (line.typeTarifs) {
    case TYPETARIF_UNIQUE:
      r += dto.volume * (m + v(line.prixU));
      break;
    case TYPETARIF_HORO:
      if (shouldComputeHpte(dto)) r += dto.volumeHPTE * (m + v(line.prixHPTE));
      r += dto.volumeHPH * (m + v(line.prixHPH));
      r += dto.volumeHCH * (m + v(line.prixHCH));
      r += dto.volumeHPE * (m + v(line.prixHPE));
      r += dto.volumeHCE * (m + v(line.prixHCE));
      break;
    case TYPETARIF_HORO_HPHC:
      if ((!dto.volumeHP) || (!dto.volumeHC)) {
        r += dto.volumeHPTE * (m + v(line.prixHP));
        r += dto.volumeHPH * (m + v(line.prixHP));
        r += dto.volumeHCH * (m + v(line.prixHC));
        r += dto.volumeHPE * (m + v(line.prixHP));
        r += dto.volumeHCE * (m + v(line.prixHC));
      } else {
        r += dto.volumeHP * (m + v(line.prixHP));
        r += dto.volumeHC * (m + v(line.prixHC));
      }
      break;
  }
  return r;
}

// LigneOffreTarifCalculator.calculateCapa
function calcCapa(line, dto) {
  let r = 0;
  if (dto.isElec && ((dto.isC5 && !line.capaInclus) || !dto.isC5)) {
    switch (line.typeTarifs) {
      case TYPETARIF_UNIQUE:
        r += dto.volume * v(line.prixCAPA);
        break;
      case TYPETARIF_HORO:
        r += dto.volumeHPTE * v(line.prixCapaHPTE);
        r += dto.volumeHPH * v(line.prixCapaHPH);
        r += dto.volumeHCH * v(line.prixCapaHCH);
        r += dto.volumeHPE * v(line.prixCapaHPE);
        r += dto.volumeHCE * v(line.prixCapaHCE);
        break;
      case TYPETARIF_HORO_HPHC:
        if ((!dto.volumeHP) || (!dto.volumeHC)) {
          r += dto.volumeHPTE * v(line.prixCapaHP);
          r += dto.volumeHPH * v(line.prixCapaHP);
          r += dto.volumeHCH * v(line.prixCapaHC);
          r += dto.volumeHPE * v(line.prixCapaHP);
          r += dto.volumeHCE * v(line.prixCapaHC);
        } else {
          r += dto.volumeHP * v(line.prixCapaHP);
          r += dto.volumeHC * v(line.prixCapaHC);
        }
        break;
    }
  }
  return round2(r);
}

// LigneOffreTarifCalculator.calculateTarifGaz
function calcTarifGaz(line, dto) {
  return (v(line.margeGlobal) + v(line.prixU)) * dto.volumeReference;
}

function calcEnergieVerte(line, dto) {
  return v(line.energieVerte) * dto.volume;
}

/* --------------------------- ATRT (acheminement gaz) --------------------------- */
// Port de ATRTService.apply + ATRTCalculator. Nécessite PITD + métadonnées.
// Renvoie l'acheminement gaz (€/an) ou null si données insuffisantes.
function calcAcheminementGaz(dto, c, ref) {
  if (!dto.isGaz) return null;
  if (dto.segment.toUpperCase() === 'T4') return 0; // reset T4
  const pitd = c.pitd;
  if (!pitd) return null;

  const atrd = ref.atrdBySegment ? ref.atrdBySegment[dto.segment] : null;
  const coefA = findCoeffA(ref.coeffA, pitd.Nom_GRT__c, pitd.Code_GRD__c);
  const coefZi = findCoefZi(ref.coeffZI, dto.profilGaz, pitd.Code_station_meteo__c);
  const car = dto.volumeReference || dto.volumeReel;
  const tck = v(ref.labels.TCK);
  if (coefA == null || coefZi == null || car == null) return null;

  const cja = coefA * coefZi * car;
  const profilP13P14 = ['P013', 'P014'].includes((dto.profilGaz || '').toUpperCase());
  const modulationClient = profilP13P14 ? 0 : cja - (car / 365);
  const partStockage = profilP13P14 ? 0 : modulationClient * tck;

  const cd = findClientDistribution(ref.clientDistribution, pitd.Nom_GRT__c);
  const ntr = v(pitd.Niveau_Tarifaire_Regional_NTR__c);
  if (!cd || cja == null || ntr == null) return null;
  const secondTerme = v(cd.TCS__c) + (v(cd.TCR__c) * ntr) + v(cd.TCL__c);
  const partTransport = cja * secondTerme;
  const acheminement = partTransport + v(atrd) + partStockage;
  return acheminement;
}

function findCoeffA(rows, grt, codeGrd) {
  if (!rows) return null;
  const g = grt ? grt.toLowerCase() : null;
  const cg = codeGrd ? codeGrd.toLowerCase() : null;
  const row = rows.find(r =>
    (r.GRT__c ? r.GRT__c.toLowerCase() : null) === g &&
    (r.Code_GRD__c ? r.Code_GRD__c.toLowerCase() : null) === cg);
  return row ? Number(row.Valeur_Coeff_A__c) : null;
}

function normalizeStation(s) {
  if (!s) return null;
  let val = String(s).trim().toLowerCase();
  if (val.endsWith('.0')) val = val.slice(0, -2);
  while (val.startsWith('0') && val.length > 1) val = val.slice(1);
  return val;
}

function findCoefZi(rows, profilGaz, station) {
  if (!profilGaz || !rows || rows.length === 0) return null;
  const key = normalizeStation(station);
  let sel = rows.find(r => normalizeStation(r.Code_Station_Meteo__c) === key);
  if (!sel) sel = rows[0];
  const field = profilGaz.toUpperCase() + '__c';
  const val = sel[field];
  return val == null ? null : Number(val);
}

function findClientDistribution(rows, grt) {
  if (!rows || rows.length === 0) return null;
  if (grt) {
    const g = grt.toLowerCase();
    const row = rows.find(r => (r.DeveloperName || '').toLowerCase() === g);
    if (row) return row;
  }
  return rows[0];
}

/* --------------------------- Orchestration --------------------------- */

function round2(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

/**
 * Calcule une ligne (actuel ou proposition) sur un compteur.
 * @param line   entrées tarifaires saisies par l'utilisateur
 * @param dto    CompteurDTO
 * @param turpe  résultat de selectTurpe (élec)
 * @param ref    données de référence (labels, grilles…)
 * @param ctx    { acheminementGaz: number|null } acheminement gaz (auto ou saisi)
 * @returns un objet "breakdown" avec tous les Calcul_* + le budget HTVA
 */
function computeLine(line, dto, turpe, ref, ctx) {
  const RATE_CTA = v(ref.labels.TaxTauxCta) / 100.0;
  const RATE_TVA_NORMAL = v(ref.labels.TaxTauxTvaNormale) / 100.0;
  const TURPECI_TAUX = v(ref.labels.TurpeCiTaux);

  const out = {
    calculTarif: 0, calculCapacite: 0, calculCEE: 0, calculCPB: 0,
    calculEnergieVerte: 0, calculPartVarDistri: 0, calculEnergie: 0,
    calculAboAnnuel: 0, calculCTA: 0, calculCSPE: 0, calculTICGN: 0,
    calculTurpe: 0, calculTurpeCC: 0, calculTurpeCG: 0,
    calculTurpeCSFixe: 0, calculTurpeCSVar: 0, calculTurpeCI: 0,
    acheminementGaz: 0, calculTaxesHorsTVA: 0, calculTarifHorsTVA: 0,
    calculTVA: 0, calculTTC: 0,
  };

  out.calculAboAnnuel = v(line.prixAbo) * 12;
  out.calculEnergieVerte = calcEnergieVerte(line, dto);

  if (dto.isElec) {
    out.calculTarif = calcTarifElec(line, dto);
    out.calculCapacite = calcCapa(line, dto);
    // CEE : ceeUser × volume si computeCEE et pas (C5 && ceeInclus)
    if (dto.computeCEE && !(dto.isC5 && line.ceeInclus)) {
      out.calculCEE = v(line.ceeUser) * dto.volume;
    }
    out.calculEnergie = v(out.calculTarif) + v(out.calculCapacite) + v(out.calculCEE) + v(out.calculEnergieVerte);

    // TURPE
    if (turpe.isLoaded) {
      const skipTurpe = dto.isC5 && line.turpeInclus;
      out.calculTurpeCC = skipTurpe ? 0 : v(turpe.cc.Tarif__c);
      out.calculTurpeCG = skipTurpe ? 0 : v(turpe.cg.Tarif__c);
      out.calculTurpeCSFixe = skipTurpe ? 0 : calcFixedTurpeCs(dto, turpe.csByCoeff['bi']);
      out.calculTurpeCSVar = skipTurpe ? 0 : calcVariableTurpeCs(dto, turpe.csByCoeff['ci']);
      out.calculTurpeCI = skipTurpe ? 0 : TURPECI_TAUX * dto.volume;
      out.calculTurpe = skipTurpe ? 0 :
        out.calculTurpeCC + out.calculTurpeCG + out.calculTurpeCSFixe + out.calculTurpeCSVar + out.calculTurpeCI;
    }

    // CTA = 15% × (CC + CG + CS fixe)
    if (turpe.isLoaded) {
      const fixedCs = calcFixedTurpeCs(dto, turpe.csByCoeff['bi']);
      out.calculCTA = RATE_CTA * (v(turpe.cc.Tarif__c) + v(turpe.cg.Tarif__c) + fixedCs);
    }
    // CSPE/TICFE = taux × volume
    out.calculCSPE = dto.ticfeRate * dto.volume;
    // Taxes hors TVA (TCCFE/TDCFE neutralisés) = CTA + CSPE
    out.calculTaxesHorsTVA = v(out.calculCTA) + v(out.calculCSPE);
    // Budget HTVA = abo + énergie + taxes + turpe
    out.calculTarifHorsTVA = v(out.calculAboAnnuel) + v(out.calculEnergie) + v(out.calculTaxesHorsTVA) + v(out.calculTurpe);
    // TVA normale
    out.calculTVA = RATE_TVA_NORMAL * (v(out.calculEnergie) + v(out.calculTurpe) + v(out.calculCTA) + v(out.calculAboAnnuel) + v(out.calculCSPE));
  } else if (dto.isGaz) {
    out.calculTarif = calcTarifGaz(line, dto);
    out.calculPartVarDistri = round2(v(line.prixPartVarDistri) * dto.volumeReference);
    if (dto.computeCEE) out.calculCEE = v(line.ceeUser) * dto.volume;
    const cpbUser = dto.computeCPB ? v(line.cpbUser) : 0;
    if (dto.computeCPB) out.calculCPB = cpbUser * dto.volume;
    out.calculEnergie = v(out.calculTarif) + v(out.calculCEE) + v(out.calculCPB) + v(out.calculEnergieVerte) + v(out.calculPartVarDistri);
    // TICGN = ticgn × volume
    const ticgn = line.ticgn != null ? v(line.ticgn) : v(ref.labels.TaxTauxTicgn);
    out.calculTICGN = ticgn * dto.volume;
    // Acheminement gaz (auto si dispo, sinon valeur fournie)
    out.acheminementGaz = ctx && ctx.acheminementGaz != null ? v(ctx.acheminementGaz) : 0;
    // CTA gaz (constant par segment T1/T2/T3, sinon saisi). N'est pas calculé par le moteur
    // Apex (chemin gaz) : fixé par segment = 20,71% × abonnement annuel ATRD.
    out.calculCTA = ctx && ctx.ctaGaz != null ? v(ctx.ctaGaz) : 0;
    // Taxes hors TVA gaz = CTA + TICGN
    out.calculTaxesHorsTVA = v(out.calculCTA) + v(out.calculTICGN);
    // Budget HTVA = énergie + taxes + abo + acheminement
    out.calculTarifHorsTVA = v(out.calculEnergie) + v(out.calculTaxesHorsTVA) + v(out.calculAboAnnuel) + v(out.acheminementGaz);
    // TVA normale = 20% × HTVA
    out.calculTVA = RATE_TVA_NORMAL * v(out.calculTarifHorsTVA);
  }

  out.calculTTC = v(out.calculTarifHorsTVA) + v(out.calculTVA);

  // Arrondis d'affichage
  for (const k of Object.keys(out)) out[k] = round2(out[k]);
  return out;
}

/**
 * Simule un compteur : calcule budget actuel + estimé + différence.
 * @param compteur  enregistrement Compteur__c enrichi (refgeo_*, apenaf, pitd, recordTypeDeveloperName)
 * @param actuelLine, estimeLine  entrées tarifaires
 * @param ref       données de référence
 * @param overrides { acheminementGazActuel, acheminementGazEstime } optionnels (gaz)
 */
function simulateCompteur(compteur, actuelLine, estimeLine, ref, overrides = {}) {
  const dto = buildCompteurDTO(compteur, ref);
  const turpe = dto.isElec ? selectTurpe(dto, ref) : { isLoaded: false, csByCoeff: {} };

  // TURPE potentiellement incomplet : compteur C5 utilisant Base/HC/HP alors que ces colonnes
  // de la grille TURPE_CS sont masquées par la FLS (cf. ref.turpeCSPartial).
  const turpeIncomplete = !!(dto.isElec && dto.isC5 && ref.turpeCSPartial &&
    ((dto.volumeBase || 0) > 0 || (dto.volumeHC || 0) > 0 || (dto.volumeHP || 0) > 0));

  // Acheminement gaz : auto-calc (PITD), sinon override utilisateur. Identique pour les 2 colonnes.
  let achemAuto = null;
  if (dto.isGaz) achemAuto = calcAcheminementGaz(dto, compteur, ref);
  const achem = overrides.acheminementGaz != null ? Number(overrides.acheminementGaz)
    : (achemAuto != null ? achemAuto : 0);

  // CTA gaz : barème par segment (T1/T2/T3), sinon override. Identique pour les 2 colonnes.
  const ctaTable = (ref.labels && ref.labels.CtaGazBySegment) || {};
  const ctaAuto = dto.isGaz ? (ctaTable[(dto.segment || '').toUpperCase()] ?? null) : null;
  const cta = overrides.ctaGaz != null ? Number(overrides.ctaGaz) : (ctaAuto != null ? ctaAuto : 0);

  const ctx = { acheminementGaz: achem, ctaGaz: cta };
  const actuel = computeLine(actuelLine || {}, dto, turpe, ref, ctx);
  const estime = computeLine(estimeLine || {}, dto, turpe, ref, ctx);

  const budgetActuel = actuel.calculTarifHorsTVA;
  const budgetEstime = estime.calculTarifHorsTVA;
  const difference = round2(budgetEstime - budgetActuel);
  const differencePct = budgetActuel === 0 ? 0 : round2((difference / budgetActuel) * 100);

  // Prix moyen (€/MWh) = budget fourniture / volume — ici budget HTVA / volume comme indicateur
  const vol = dto.volume || 0;
  const prixMoyenActuel = vol === 0 ? 0 : round2(budgetActuel / vol);
  const prixMoyenEstime = vol === 0 ? 0 : round2(budgetEstime / vol);

  return {
    energie: dto.isElec ? 'Électricité' : (dto.isGaz ? 'Gaz' : 'Inconnu'),
    segment: dto.segment,
    tension: dto.tension,
    volume: vol,
    turpeLoaded: turpe.isLoaded,
    turpeIncomplete,
    acheminementGazAuto: achemAuto,
    acheminementGazUsed: dto.isGaz ? achem : null,
    ctaGazAuto: ctaAuto,
    ctaGazUsed: dto.isGaz ? cta : null,
    actuel,
    estime,
    budgetActuel,
    budgetEstime,
    difference,
    differencePct,
    prixMoyenActuel,
    prixMoyenEstime,
    flags: {
      computeCEE: dto.computeCEE, computeCPB: dto.computeCPB,
      computeTICGN: dto.computeTICGN, computeCSPE: dto.computeCSPE,
      isC5: dto.isC5,
    },
  };
}

module.exports = { buildCompteurDTO, selectTurpe, computeLine, simulateCompteur, calcAcheminementGaz, v, round2 };
