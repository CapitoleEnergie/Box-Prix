'use strict';
/**
 * Test d'extraction de facture : lance l'extracteur sur chaque PDF listé et affiche le résultat.
 * Ne fait AUCUN appel Salesforce — utilise uniquement OpenAI (clé lue dans .env).
 */
const path = require('path');
const { extractFromPdf } = require('../lib/invoice-extractor');

const FILES = [
  'C:/Users/DamienLauger/Music/EDF facture fourneaux.pdf',
  'C:/Users/DamienLauger/Music/F01365_MET FRANCE_F-260241262.pdf',
  'C:/Users/DamienLauger/Music/FACTURE ELECTRICITE MAGASIN hamon.pdf',
  'C:/Users/DamienLauger/Music/FACTURE GAZ MAGASIN hamon.pdf',
];

function fmt(n) { return n == null ? '—' : Number(n).toFixed(2); }
function nonNull(o) { return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== 0)); }

(async () => {
  let totalIn = 0, totalOut = 0;
  for (const f of FILES) {
    const label = path.basename(f);
    process.stdout.write(`\n═══ ${label} ═══\n`);
    try {
      const t0 = Date.now();
      const { data, usage } = await extractFromPdf(f);
      const ms = Date.now() - t0;
      console.log('  Fournisseur      :', data.fournisseur, '·', data.energie);
      console.log('  Segment / Tarif  :', data.segment || '—', '·', data.type_tarif);
      console.log('  Puissance        :', data.puissance_souscrite_kva ? data.puissance_souscrite_kva + ' kVA' : '—');
      console.log('  Volume annuel    :', fmt(data.volume_annuel_mwh), 'MWh');
      console.log('  Prix fourniture  :', JSON.stringify(nonNull(data.prix_fourniture_eur_mwh)));
      console.log('  Volumes/poste    :', JSON.stringify(nonNull(data.volume_par_poste_mwh)));
      console.log('  Abonnement       :', fmt(data.abonnement_eur_mois), '€/mois');
      console.log('  CEE / TICFE/TICGN:', fmt(data.cee_eur_mwh), '/', fmt(data.ticfe_eur_mwh), '/', fmt(data.ticgn_eur_mwh), '€/MWh');
      console.log('  Capacité / CPB   :', fmt(data.capacite_eur_mwh), '/', fmt(data.cpb_eur_mwh), '€/MWh');
      console.log('  PDL / Dates      :', data.reference_pdl || '—', '·', data.date_facture, '· contrat', data.date_debut_contrat || '?', '→', data.date_fin_contrat || '?');
      console.log('  Confiance        :', data.confidence);
      if (data.notes) console.log('  Notes            :', data.notes);
      if (usage) {
        totalIn += usage.prompt_tokens || 0;
        totalOut += usage.completion_tokens || 0;
        console.log(`  ⏱  ${ms}ms · tokens: ${usage.prompt_tokens} in / ${usage.completion_tokens} out`);
      }
    } catch (e) {
      console.error('  ❌', e.message);
    }
  }
  // Coût gpt-4o-mini : 0,15 $ / 1M input · 0,60 $ / 1M output
  const costUsd = (totalIn * 0.15 + totalOut * 0.60) / 1_000_000;
  console.log(`\n💰 Total : ${totalIn} in + ${totalOut} out tokens ≈ $${costUsd.toFixed(4)} (${(costUsd * 0.92).toFixed(4)} €)`);
})();
