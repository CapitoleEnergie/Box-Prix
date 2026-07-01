'use strict';
/**
 * Tests d'intégration de l'API HTTP. Nécessite le serveur démarré (node server.js).
 * Usage : node test/api.test.js   (PORT optionnel, défaut 4173)
 */
const PORT = process.env.PORT || 4173;
const BASE = `http://localhost:${PORT}`;

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond) { if (cond) pass++; else { fail++; fails.push(name); console.log('  ❌ ' + name); } }

async function jget(path) {
  const r = await fetch(BASE + path);
  let body = null; try { body = await r.json(); } catch (_) {}
  return { status: r.status, body };
}
async function jpost(path, obj) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
  let body = null; try { body = await r.json(); } catch (_) {}
  return { status: r.status, body };
}

async function main() {
  console.log('\n=== Tests d\'intégration API ===');

  // Serveur joignable ?
  try { await fetch(BASE + '/api/health'); }
  catch (e) { console.error(`❌ Serveur injoignable sur ${BASE}. Lancez 'node server.js' d'abord.`); process.exit(2); }

  // 1. Health
  const h = await jget('/api/health');
  ok('health → 200', h.status === 200);
  ok('health → org connectée (ok=true)', h.body && h.body.ok === true);
  ok('health → référence chargée', h.body && h.body.reference && h.body.reference.counts.turpeCG > 0);
  ok('health → labels exposés', h.body && h.body.labels && h.body.labels.TaxTauxCta === 15);
  ok('health → CtaGazBySegment exposé', h.body && h.body.labels && h.body.labels.CtaGazBySegment && h.body.labels.CtaGazBySegment.T3 === 321.7);

  // 2. Page statique
  const idx = await fetch(BASE + '/');
  const html = await idx.text();
  ok('GET / → 200', idx.status === 200);
  ok('GET / → contient le titre', html.includes('Simulateur'));

  // 3. Route inconnue → 404 JSON
  const nf = await jget('/api/inconnue');
  ok('route API inconnue → 404', nf.status === 404);
  ok('route API inconnue → JSON erreur', nf.body && !!nf.body.error);

  // 4. Compute sans compteur → 400
  const bad = await jpost('/api/compute', { actuel: {}, estime: {} });
  ok('compute sans compteur → 400', bad.status === 400);

  // 5. Compute gaz synthétique (déterministe via overrides)
  const gaz = {
    recordTypeDeveloperName: 'Gaz', Segment__c: 'T3', ProfilCompteurGaz__c: 'P018',
    VolumeEstime__c: 500, VolumeReference__c: 500, VolumeReel__c: 500,
    apenaf: { CEE__c: true, CSPE__c: false, TICGN__c: true, CPB__c: true }, pitd: null,
  };
  const cg = await jpost('/api/compute', {
    compteur: gaz, actuel: { prixU: 35, margeGlobal: 0, prixAbo: 20, prixPartVarDistri: 7.57, ticgn: 16.39 },
    estime: { prixU: 30, margeGlobal: 3, prixAbo: 20, prixPartVarDistri: 7.57, ticgn: 16.39 },
    overrides: { acheminementGaz: 8000, ctaGaz: 321.70 },
  });
  ok('compute gaz → 200', cg.status === 200);
  ok('compute gaz → energie = Gaz', cg.body && cg.body.energie === 'Gaz');
  ok('compute gaz → budgets numériques', cg.body && Number.isFinite(cg.body.budgetActuel) && Number.isFinite(cg.body.budgetEstime));
  ok('compute gaz → difference = estimé - actuel', cg.body && Math.abs(cg.body.difference - (cg.body.budgetEstime - cg.body.budgetActuel)) < 0.02);
  // reconstruction HTVA estimé
  if (cg.body && cg.body.estime) {
    const e = cg.body.estime;
    const recon = e.calculEnergie + e.calculTaxesHorsTVA + e.calculAboAnnuel + e.acheminementGaz;
    ok('compute gaz → HTVA = energie+taxes+abo+achem', Math.abs(recon - e.calculTarifHorsTVA) < 0.1);
    ok('compute gaz → CTA = 321.70 (override)', Math.abs(e.calculCTA - 321.70) < 0.01);
    ok('compute gaz → acheminement = 8000 (override)', Math.abs(e.acheminementGaz - 8000) < 0.01);
  }

  // 6. Compute élec synthétique
  const elec = {
    recordTypeDeveloperName: 'Elec', Segment__c: 'C4', TensionCompteur__c: 'Basse Tension',
    ProfilCompteur__c: 'BTSUPCU4', Superieur36kVA__c: true, CARD__c: false, Autoproducteur__c: false, ProprieteAOD__c: false,
    PuissanceSouscrite__c: 60, PuissanceHPH__c: 60, PuissanceHCH__c: 60, PuissanceHPE__c: 60, PuissanceHCE__c: 60,
    VolumeTotalAnnuel__c: 100, apenaf: { CSPE__c: true },
  };
  const ce = await jpost('/api/compute', { compteur: elec, actuel: {}, estime: { typeTarifs: 'Unique', prixU: 60, margeGlobal: 5, prixAbo: 10 } });
  ok('compute élec → 200', ce.status === 200);
  ok('compute élec → energie = Électricité', ce.body && ce.body.energie === 'Électricité');
  ok('compute élec → calculTarif = 100×65', ce.body && Math.abs(ce.body.estime.calculTarif - 6500) < 0.01);
  ok('compute élec → flags présents', ce.body && ce.body.flags && typeof ce.body.flags.isC5 === 'boolean');

  // 6b. Prix marché
  const mp = await jget('/api/marketprice');
  ok('marketprice → 200', mp.status === 200);
  ok('marketprice → byKey présent', mp.body && typeof mp.body.byKey === 'object');
  ok('marketprice → meta.kept > 0', mp.body && mp.body.meta && mp.body.meta.kept > 0);
  ok('marketprice → médiane cohérente si cellule présente', (() => {
    const cells = mp.body && mp.body.byKey ? Object.values(mp.body.byKey) : [];
    return !cells.length || cells.every(c => c.median > 0 && c.p25 <= c.p75 && c.n >= 1);
  })());

  // 7. Compte avec ID invalide → réponse JSON gérée (pas de crash)
  const acc = await jget('/api/account/000000000000000/compteurs');
  ok('account ID invalide → réponse JSON (pas de crash)', acc.body !== null && (acc.status === 200 || acc.status === 500));

  console.log(`\n=== ${pass} réussis, ${fail} échoués ===`);
  if (fail) { console.log('Échecs:', fails.join(', ')); process.exit(1); }
  console.log('✅ Tous les tests d\'intégration API passent.');
}

main().catch(e => { console.error('ERREUR:', e); process.exit(1); });
