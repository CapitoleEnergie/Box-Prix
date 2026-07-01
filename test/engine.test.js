'use strict';
/**
 * Tests unitaires du moteur — déterministes, fixture de référence locale (aucune dépendance org).
 * Usage : node test/engine.test.js
 */
const engine = require('../lib/engine');

let pass = 0, fail = 0;
const fails = [];
function approx(a, b, t = 0.01) { return Math.abs(a - b) <= t; }
function ok(name, cond) { if (cond) { pass++; } else { fail++; fails.push(name); console.log('  ❌ ' + name); } }
function eq(name, got, exp, t = 0.01) {
  const c = approx(got, exp, t);
  if (!c) console.log(`  ❌ ${name}: got ${got}, exp ${exp}`);
  if (c) pass++; else { fail++; fails.push(name); }
}

// --- Fixture de référence (valeurs représentatives de l'org) ---
const ref = {
  labels: {
    TaxTauxCta: 15, TaxTauxTvaNormale: 20, TaxTauxTvaReduite: 5.5,
    TaxTauxCspe: 26.58, TaxTauxCspeBelow36kva: 30.85, TaxTauxCspeSup249: 26.58,
    TaxTauxTicgn: 16.39, TurpeCiTaux: 0, TCK: 398.08,
    CtaGazBySegment: { T1: 13.56, T2: 46.01, T3: 321.70 },
  },
  turpeCG: [{ Tension__c: 'Basse Tension', CARD__c: false, AutoProducteur__c: false, BTSup36kVA__c: true, Tarif__c: 217.8 }],
  turpeCC: [{ Tension__c: 'Basse Tension', Propri_t_AOD__c: false, BT36kVA__c: true, Tarif__c: 283.27 }],
  turpeCS: [
    { coefficient__c: 'bi', Tension__c: 'Basse Tension', Profil__c: 'CU4', Type_de_pointe__c: null, AutoProduction__c: false, Part_autoproduction__c: null, BTSup36kVA__c: true, Tarif_HPH__c: 10, Tarif_HCH__c: 8, Tarif_HPB__c: 6, Tarif_HCB__c: 4, Tarif_PTE__c: 12, Tarif_Base__c: 0, Tarif_HC__c: 0, Tarif_HP__c: 0 },
    { coefficient__c: 'ci', Tension__c: 'Basse Tension', Profil__c: 'CU4', Type_de_pointe__c: null, AutoProduction__c: false, Part_autoproduction__c: null, BTSup36kVA__c: true, Tarif_HPH__c: 2, Tarif_HCH__c: 1, Tarif_HPB__c: 1, Tarif_HCB__c: 0.5, Tarif_PTE__c: 3, Tarif_Base__c: 1, Tarif_HC__c: 1, Tarif_HP__c: 1.5 },
  ],
  atrdBySegment: { T1: 57.48, T2: 196.68, T3: 1858.68, T4: 21705.72 },
  coeffA: [], coeffZI: [], clientDistribution: [],
  turpeCSPartial: false,
};

const elecC4 = {
  recordTypeDeveloperName: 'Elec', Segment__c: 'C4', TensionCompteur__c: 'Basse Tension',
  ProfilCompteur__c: 'BTSUPCU4', Type2Pointe__c: null, Code_Acheminement__c: 'BTSUPCU4',
  Superieur36kVA__c: true, CARD__c: false, Autoproducteur__c: false, AutoproductionPart__c: null, ProprieteAOD__c: false,
  PuissanceSouscrite__c: 60, PuissanceHPH__c: 60, PuissanceHCH__c: 60, PuissanceHPE__c: 60, PuissanceHCE__c: 60,
  VolumeTotalAnnuel__c: 100, VolumeHPH__c: 25, VolumeHCH__c: 25, VolumeHPE__c: 25, VolumeHCE__c: 25,
  apenaf: { CEE__c: false, CSPE__c: true, TICGN__c: false, CPB__c: false },
};

const gazT3 = {
  recordTypeDeveloperName: 'Gaz', Segment__c: 'T3', ProfilCompteurGaz__c: 'P018',
  VolumeEstime__c: 500, VolumeReference__c: 500, VolumeReel__c: 500,
  apenaf: { CEE__c: true, CSPE__c: false, TICGN__c: true, CPB__c: true }, pitd: null,
};

console.log('\n=== Tests unitaires moteur ===');

// 1. Élec Unique — fourniture, abo, énergie
{
  const r = engine.simulateCompteur(elecC4, {}, { typeTarifs: 'Unique', prixU: 60, margeGlobal: 5, prixAbo: 10, prixCAPA: 2 }, ref, {});
  eq('elec Unique calculTarif = vol×(marge+prixU)', r.estime.calculTarif, 100 * (5 + 60));
  eq('elec Unique calculAboAnnuel = abo×12', r.estime.calculAboAnnuel, 120);
  eq('elec Unique calculCapacite = vol×prixCAPA', r.estime.calculCapacite, 200);
  eq('elec Unique calculEnergie = tarif+capa+cee+ev', r.estime.calculEnergie, 6500 + 200 + 0 + 0);
  ok('elec TURPE chargé', r.turpeLoaded === true);
  ok('elec calculTurpe > 0', r.estime.calculTurpe > 0);
  eq('elec CTA = 15% (CC+CG+CSfixe)', r.estime.calculCTA, 0.15 * (283.27 + 217.8 + (10 * 60 + 8 * (60 - 60) + 6 * (60 - 60) + 4 * (60 - 60))), 0.05);
  eq('elec TICFE (>36kVA) = 26.58 × vol', r.estime.calculCSPE, 26.58 * 100, 0.05);
}

// 2. Drapeau CEE selon APE/NAF
{
  const off = engine.simulateCompteur(elecC4, {}, { typeTarifs: 'Unique', prixU: 60, ceeUser: 5 }, ref, {});
  eq('CEE non applicable (APE/NAF CEE=false) → 0', off.estime.calculCEE, 0);
  const onC = { ...elecC4, apenaf: { CEE__c: true, CSPE__c: true } };
  const on = engine.simulateCompteur(onC, {}, { typeTarifs: 'Unique', prixU: 60, ceeUser: 5 }, ref, {});
  eq('CEE applicable → ceeUser×vol', on.estime.calculCEE, 5 * 100);
}

// 3. TICFE selon puissance (≤36 vs >36)
{
  const petit = { ...elecC4, PuissanceSouscrite__c: 30 };
  const r = engine.simulateCompteur(petit, {}, { typeTarifs: 'Unique', prixU: 60 }, ref, {});
  eq('TICFE ≤36kVA = 30.85 × vol', r.estime.calculCSPE, 30.85 * 100, 0.05);
}

// 4. Gaz — fourniture, part var, TICGN, CTA segment, HTVA
{
  const r = engine.simulateCompteur(gazT3, {}, { prixU: 30, margeGlobal: 3, prixAbo: 20, prixPartVarDistri: 7.57, ticgn: 16.39, ceeUser: 0, cpbUser: 0 }, ref, { acheminementGaz: 8000 });
  eq('gaz calculTarif = (marge+prixU)×volRef', r.estime.calculTarif, (3 + 30) * 500);
  eq('gaz calculPartVarDistri = pvd×volRef', r.estime.calculPartVarDistri, 7.57 * 500);
  eq('gaz calculTICGN = ticgn×vol', r.estime.calculTICGN, 16.39 * 500, 0.05);
  eq('gaz CTA = barème segment T3', r.estime.calculCTA, 321.70);
  const energie = (3 + 30) * 500 + 0 + 0 + 0 + 7.57 * 500;
  const htva = energie + (321.70 + 16.39 * 500) + 240 + 8000;
  eq('gaz HTVA = energie+taxes+abo+achem', r.estime.calculTarifHorsTVA, htva, 0.1);
  eq('gaz TVA = 20% × HTVA', r.estime.calculTVA, 0.2 * htva, 0.1);
}

// 5. Différence actuel/estimé
{
  const r = engine.simulateCompteur(elecC4,
    { typeTarifs: 'Unique', prixU: 70, margeGlobal: 0 },
    { typeTarifs: 'Unique', prixU: 60, margeGlobal: 0 }, ref, {});
  eq('difference = estimé - actuel', r.difference, r.budgetEstime - r.budgetActuel, 0.02);
  ok('estimé < actuel (prix plus bas) → diff négative', r.difference < 0);
  eq('differencePct cohérent', r.differencePct, (r.difference / r.budgetActuel) * 100, 0.05);
}

// 6. TURPE s'annule dans la différence (même compteur, seuls les prix changent)
{
  const r = engine.simulateCompteur(elecC4,
    { typeTarifs: 'Unique', prixU: 70 }, { typeTarifs: 'Unique', prixU: 60 }, ref, {});
  eq('TURPE identique actuel/estimé', r.actuel.calculTurpe, r.estime.calculTurpe);
  eq('CTA identique actuel/estimé', r.actuel.calculCTA, r.estime.calculCTA);
  // la différence ne doit dépendre que de la fourniture
  eq('diff = ΔcalculTarif', r.difference, r.estime.calculTarif - r.actuel.calculTarif, 0.05);
}

// 7. Robustesse — entrées vides / volume nul
{
  const r = engine.simulateCompteur(elecC4, {}, {}, ref, {});
  ok('ligne vide → HTVA fini', Number.isFinite(r.estime.calculTarifHorsTVA));
  const zero = { ...elecC4, VolumeTotalAnnuel__c: 0, VolumeHPH__c: 0, VolumeHCH__c: 0, VolumeHPE__c: 0, VolumeHCE__c: 0 };
  const rz = engine.simulateCompteur(zero, {}, { prixU: 60 }, ref, {});
  ok('volume nul → prix moyen 0 (pas de division par 0)', rz.prixMoyenEstime === 0);
  ok('volume nul → pas de NaN', Number.isFinite(rz.estime.calculTarifHorsTVA));
}

// 8. Drapeau turpeIncomplete (C5 Base + grille partielle)
{
  const c5base = {
    recordTypeDeveloperName: 'Elec', Segment__c: 'C5', TensionCompteur__c: 'Basse Tension',
    ProfilCompteur__c: 'BTINFCU4', Type2Pointe__c: null, Superieur36kVA__c: false,
    CARD__c: false, Autoproducteur__c: false, ProprieteAOD__c: false,
    PuissanceSouscrite__c: 6, VolumeTotalAnnuel__c: 5, VolumeBase__c: 5,
    apenaf: { CSPE__c: true },
  };
  const partial = { ...ref, turpeCSPartial: true };
  const r = engine.simulateCompteur(c5base, {}, { typeTarifs: 'Unique', prixU: 60 }, partial, {});
  ok('C5 Base + grille partielle → turpeIncomplete = true', r.turpeIncomplete === true);
  const r2 = engine.simulateCompteur(c5base, {}, { typeTarifs: 'Unique', prixU: 60 }, ref, {});
  ok('grille complète → turpeIncomplete = false', r2.turpeIncomplete === false);
}

// 9. Gaz CTA T4 (hors barème) → 0 sauf override
{
  const gazT4 = { ...gazT3, Segment__c: 'T4' };
  const r = engine.simulateCompteur(gazT4, {}, { prixU: 30 }, ref, { acheminementGaz: 0 });
  eq('gaz T4 CTA auto = 0 (hors barème)', r.estime.calculCTA, 0);
  const ro = engine.simulateCompteur(gazT4, {}, { prixU: 30 }, ref, { acheminementGaz: 0, ctaGaz: 8569.37 });
  eq('gaz T4 CTA override pris en compte', ro.estime.calculCTA, 8569.37);
}

// 10. Type de tarif Horosaisonnalisé — somme des postes
{
  const r = engine.simulateCompteur(elecC4, {}, {
    typeTarifs: 'Horosaisonnalisé', margeGlobal: 0,
    prixHPH: 100, prixHCH: 80, prixHPE: 90, prixHCE: 70, prixHPTE: 120,
  }, ref, {});
  // C4 BTSU non concerné par HPTE ? ici codeAcheminement BTSUPCU4 ≠ BTSUPCU4? -> shouldComputeHpte vrai si pas (C4 && BTSUPCU4)
  // volumes 25 chacun (HPH,HCH,HPE,HCE), HPTE=0
  const exp = 25 * 100 + 25 * 80 + 25 * 90 + 25 * 70; // HPTE vol = 0
  eq('Horo calculTarif = Σ vol×prix', r.estime.calculTarif, exp);
}

console.log(`\n=== ${pass} réussis, ${fail} échoués ===`);
if (fail) { console.log('Échecs:', fails.join(', ')); process.exit(1); }
console.log('✅ Tous les tests unitaires passent.');
