'use strict';
/**
 * Validation de fidélité EN MASSE : compare la sortie du moteur aux valeurs Calcul_*
 * réellement stockées dans Salesforce, sur un large échantillon de lignes d'offre réelles.
 *
 * Usage : node test/fidelity.js [limit]
 */
const sf = require('../lib/sf');
const reference = require('../lib/reference');
const compteurs = require('../lib/compteurs');
const engine = require('../lib/engine');

const LIMIT = parseInt(process.argv[2] || '300', 10);

const LINE_FIELDS = [
  'Id', 'TypeLigne__c', 'TypeTarifs__c', 'MargeGlobale__c',
  'PrixU__c', 'PrixHP__c', 'PrixHC__c', 'PrixHPH__c', 'PrixHCH__c', 'PrixHPE__c', 'PrixHCE__c', 'PrixHPTE__c',
  'PrixCAPA__c', 'PrixCapaHP__c', 'PrixCapaHC__c', 'PrixCapaHPH__c', 'PrixCapaHCH__c', 'PrixCapaHPE__c', 'PrixCapaHCE__c', 'PrixCapaHPTE__c',
  'PrixAbo__c', 'EnergieVerte__c', 'CEE_user__c', 'CPB__c', 'TICGN__c', 'PrixPartVarDistri__c',
  'TurpeInclus__c', 'CAPAInclus__c', 'CEEInclus__c', 'Acheminement_gaz__c',
  'Calcul_Tarif__c', 'Calcul_Capacite__c', 'Calcul_CEE__c', 'Calcul_CPB__c', 'Calcul_PartVarDistri__c',
  'Calcul_Energie__c', 'Calcul_AboAnnuel__c', 'Calcul_Turpe__c', 'Calcul_CTA__c', 'Calcul_CSPE__c',
  'Calcul_TICGN__c', 'Calcul_TaxesHorsTVA__c', 'Calcul_TarifHorsTVA__c',
  'Offre__r.Compteur__c', 'Offre__r.Compteur__r.RecordType.DeveloperName', 'Offre__r.Compteur__r.Segment__c',
];

// Mappe une LigneOffre__c (record SOQL) vers l'objet "line" attendu par le moteur
function toLine(r) {
  return {
    typeTarifs: r.TypeTarifs__c || 'Unique',
    margeGlobal: r.MargeGlobale__c,
    prixU: r.PrixU__c, prixHP: r.PrixHP__c, prixHC: r.PrixHC__c,
    prixHPH: r.PrixHPH__c, prixHCH: r.PrixHCH__c, prixHPE: r.PrixHPE__c, prixHCE: r.PrixHCE__c, prixHPTE: r.PrixHPTE__c,
    prixCAPA: r.PrixCAPA__c, prixCapaHP: r.PrixCapaHP__c, prixCapaHC: r.PrixCapaHC__c,
    prixCapaHPH: r.PrixCapaHPH__c, prixCapaHCH: r.PrixCapaHCH__c, prixCapaHPE: r.PrixCapaHPE__c,
    prixCapaHCE: r.PrixCapaHCE__c, prixCapaHPTE: r.PrixCapaHPTE__c,
    prixAbo: r.PrixAbo__c, energieVerte: r.EnergieVerte__c, ceeUser: r.CEE_user__c, cpbUser: r.CPB__c,
    ticgn: r.TICGN__c, prixPartVarDistri: r.PrixPartVarDistri__c,
    turpeInclus: r.TurpeInclus__c, capaInclus: r.CAPAInclus__c, ceeInclus: r.CEEInclus__c,
  };
}

// Champs comparés : clé moteur -> champ Salesforce stocké
const COMPARE = [
  ['calculTarif', 'Calcul_Tarif__c'],
  ['calculCapacite', 'Calcul_Capacite__c'],
  ['calculCEE', 'Calcul_CEE__c'],
  ['calculCPB', 'Calcul_CPB__c'],
  ['calculPartVarDistri', 'Calcul_PartVarDistri__c'],
  ['calculEnergie', 'Calcul_Energie__c'],
  ['calculAboAnnuel', 'Calcul_AboAnnuel__c'],
  ['calculTurpe', 'Calcul_Turpe__c'],
  ['calculCTA', 'Calcul_CTA__c'],
  ['calculCSPE', 'Calcul_CSPE__c'],
  ['calculTICGN', 'Calcul_TICGN__c'],
  ['calculTaxesHorsTVA', 'Calcul_TaxesHorsTVA__c'],
  ['calculTarifHorsTVA', 'Calcul_TarifHorsTVA__c'],
];

function num(x) { return x == null ? 0 : Number(x); }
function tol(exp) { return Math.max(0.5, Math.abs(exp) * 0.005); } // 0,5 € ou 0,5 %

async function main() {
  console.log(`\n=== Validation de fidélité en masse (limit ${LIMIT}) ===`);
  const ref = await reference.load();
  console.log('Référence:', JSON.stringify(ref.counts));

  // 1) Récupère un échantillon varié de lignes (tous types confondus)
  const q = `SELECT ${LINE_FIELDS.join(', ')} FROM LigneOffre__c WHERE Calcul_TarifHorsTVA__c > 0 AND Offre__r.Compteur__c != null ORDER BY LastModifiedDate DESC LIMIT ${LIMIT}`;
  const lines = await sf.query(q);
  console.log(`Lignes récupérées: ${lines.length}`);

  // 2) Récupère les compteurs en lot
  const compteurIds = [...new Set(lines.map(l => l.Offre__r && l.Offre__r.Compteur__c).filter(Boolean))];
  const compteurList = await compteurs.byIds(compteurIds);
  const compteurById = {};
  compteurList.forEach(c => compteurById[c.Id] = c);
  console.log(`Compteurs récupérés: ${compteurList.length}\n`);

  // 3) Compare
  const stats = {}; // field -> {ok, close, fail, total}
  const byGroup = {}; // group -> {total, htvaOk, htvaFail}
  const fails = []; // détails des échecs HTVA

  for (const l of lines) {
    const cId = l.Offre__r && l.Offre__r.Compteur__c;
    const c = compteurById[cId];
    if (!c) continue;
    const en = (c.recordTypeDeveloperName || '').toLowerCase();
    const seg = c.Segment__c || '?';
    const tt = l.TypeTarifs__c || 'Unique';
    const group = `${en}/${seg}/${tt}`;
    byGroup[group] = byGroup[group] || { total: 0, htvaOk: 0, htvaFail: 0 };

    // Override acheminement gaz avec la valeur stockée (null -> 0) pour isoler fourniture/taxes
    // du calcul d'acheminement auto (testé séparément).
    const overrides = {};
    if (en === 'gaz') overrides.acheminementGaz = Number(l.Acheminement_gaz__c || 0);

    let res;
    try { res = engine.simulateCompteur(c, {}, toLine(l), ref, overrides); }
    catch (e) { fails.push({ id: l.Id, group, err: e.message }); continue; }
    const got = res.estime;

    byGroup[group].total++;
    let htvaMatch = true;
    for (const [k, sfField] of COMPARE) {
      const exp = num(l[sfField]);
      const g = num(got[k]);
      // ignore les champs non pertinents (ex: TICGN pour élec, Turpe pour gaz) si les deux sont ~0
      if (Math.abs(exp) < 0.01 && Math.abs(g) < 0.01) continue;
      stats[k] = stats[k] || { ok: 0, close: 0, fail: 0, total: 0 };
      stats[k].total++;
      const d = Math.abs(g - exp);
      if (d <= tol(exp)) stats[k].ok++;
      else if (d <= Math.abs(exp) * 0.02) stats[k].close++;
      else { stats[k].fail++; if (k === 'calculTarifHorsTVA') htvaMatch = false; }
    }
    if (htvaMatch) byGroup[group].htvaOk++;
    else {
      byGroup[group].htvaFail++;
      // Contrôle de cohérence INTERNE des valeurs stockées : la HTVA stockée doit = somme de ses
      // composants stockés. Si non, la ligne stockée est périmée (recalcul partiel) -> pas un bug moteur.
      const storedSum = num(l.Calcul_Energie__c) + num(l.Calcul_TaxesHorsTVA__c) + num(l.Calcul_AboAnnuel__c)
        + (en === 'gaz' ? num(l.Acheminement_gaz__c) : num(l.Calcul_Turpe__c));
      const storedConsistent = Math.abs(storedSum - num(l.Calcul_TarifHorsTVA__c)) <= tol(num(l.Calcul_TarifHorsTVA__c));
      if (!storedConsistent) byGroup[group].stale = (byGroup[group].stale || 0) + 1;
      if (fails.length < 30) fails.push({
        id: l.Id, group, vol: res.volume, staleData: !storedConsistent,
        htvaGot: got.calculTarifHorsTVA, htvaExp: num(l.Calcul_TarifHorsTVA__c), storedSum: Math.round(storedSum * 100) / 100,
        energieGot: got.calculEnergie, energieExp: num(l.Calcul_Energie__c),
        turpeGot: got.calculTurpe, turpeExp: num(l.Calcul_Turpe__c),
        acheminement: en === 'gaz' ? num(l.Acheminement_gaz__c) : null,
        ctaGot: got.calculCTA, ctaExp: num(l.Calcul_CTA__c),
        flags: res.flags, turpeLoaded: res.turpeLoaded, csPartial: ref.turpeCSPartial,
      });
    }
  }

  // 4) Rapport
  console.log('--- Fidélité par champ (ok = Δ≤0,5% ; close = Δ≤2% ; fail = Δ>2%) ---');
  for (const [k, s] of Object.entries(stats)) {
    const pct = s.total ? ((s.ok / s.total) * 100).toFixed(1) : '—';
    console.log(`  ${k.padEnd(22)} ok ${String(s.ok).padStart(4)}/${String(s.total).padStart(4)} (${pct}%)  close ${s.close}  FAIL ${s.fail}`);
  }

  console.log('\n--- HTVA par groupe (énergie/segment/type) ---');
  for (const [g, s] of Object.entries(byGroup).sort()) {
    const flag = s.htvaFail > 0 ? ` ⚠️ (dont ${s.stale || 0} données périmées)` : '';
    console.log(`  ${g.padEnd(34)} HTVA ok ${s.htvaOk}/${s.total}${flag}`);
  }

  if (fails.length) {
    console.log(`\n--- Échecs HTVA (${fails.length} premiers) ---`);
    fails.forEach(f => console.log('  ' + JSON.stringify(f)));
  }

  const htvaStats = stats['calculTarifHorsTVA'] || { ok: 0, total: 0 };
  console.log(`\n=== RÉSULTAT : HTVA exact ${htvaStats.ok}/${htvaStats.total} (${((htvaStats.ok / htvaStats.total) * 100).toFixed(1)}%) ===`);
}

main().catch(e => { console.error('ERREUR:', e); process.exit(1); });
