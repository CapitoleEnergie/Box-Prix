'use strict';
const fs = require('fs');
const path = require('path');
const { anonymizePdf } = require('./invoice-extractor');

// ---------- .env loader ----------
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
}
loadEnv();

// ---------- Schema & Prompt (imported from invoice-extractor.js) ----------
const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fournisseur: { type: 'string', description: 'Nom du fournisseur.' },
    energie: { type: 'string', enum: ['elec', 'gaz'] },
    reference_pdl: { type: ['string', 'null'], description: 'PDL/PRM ou PCE.' },
    date_facture: { type: ['string', 'null'], description: 'Date emission (YYYY-MM-DD).' },
    periode_debut: { type: ['string', 'null'], description: 'Debut periode (YYYY-MM-DD).' },
    periode_fin: { type: ['string', 'null'], description: 'Fin periode (YYYY-MM-DD).' },
    date_debut_contrat: { type: ['string', 'null'] },
    date_fin_contrat: { type: ['string', 'null'] },
    type_tarif: { type: 'string', enum: ['Unique', 'HP_HC', 'Horo_4postes', 'Horo_5postes', 'Inconnu'] },
    segment: { type: ['string', 'null'] },
    puissance_souscrite_kva: { type: ['number', 'null'] },
    volume_annuel_mwh: { type: ['number', 'null'] },
    volume_periode_kwh: { type: ['number', 'null'] },
    volume_par_poste_mwh: {
      type: 'object', additionalProperties: false,
      properties: {
        Base: { type: ['number', 'null'] }, HP: { type: ['number', 'null'] }, HC: { type: ['number', 'null'] },
        HPH: { type: ['number', 'null'] }, HCH: { type: ['number', 'null'] },
        HPE: { type: ['number', 'null'] }, HCE: { type: ['number', 'null'] }, HPTE: { type: ['number', 'null'] },
      },
      required: ['Base', 'HP', 'HC', 'HPH', 'HCH', 'HPE', 'HCE', 'HPTE'],
    },
    prix_fourniture_eur_mwh: {
      type: 'object', additionalProperties: false,
      properties: {
        Base: { type: ['number', 'null'] }, HP: { type: ['number', 'null'] }, HC: { type: ['number', 'null'] },
        HPH: { type: ['number', 'null'] }, HCH: { type: ['number', 'null'] },
        HPE: { type: ['number', 'null'] }, HCE: { type: ['number', 'null'] }, HPTE: { type: ['number', 'null'] },
      },
      required: ['Base', 'HP', 'HC', 'HPH', 'HCH', 'HPE', 'HCE', 'HPTE'],
    },
    abonnement_eur_mois: { type: ['number', 'null'] },
    cee_eur_mwh: { type: ['number', 'null'] },
    capacite_eur_mwh: { type: ['number', 'null'] },
    ticfe_eur_mwh: { type: ['number', 'null'] },
    ticgn_eur_mwh: { type: ['number', 'null'] },
    cpb_eur_mwh: { type: ['number', 'null'] },
    notes: { type: ['string', 'null'] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: [
    'fournisseur', 'energie', 'reference_pdl',
    'date_facture', 'periode_debut', 'periode_fin', 'date_debut_contrat', 'date_fin_contrat',
    'type_tarif', 'segment', 'puissance_souscrite_kva',
    'volume_annuel_mwh', 'volume_periode_kwh', 'volume_par_poste_mwh',
    'prix_fourniture_eur_mwh',
    'abonnement_eur_mois', 'cee_eur_mwh', 'capacite_eur_mwh',
    'ticfe_eur_mwh', 'ticgn_eur_mwh', 'cpb_eur_mwh',
    'notes', 'confidence',
  ],
};

const SYSTEM_PROMPT = `Tu es un expert du secteur de l'énergie en France (électricité + gaz). Tu extrais les données d'une facture d'énergie professionnelle (texte anonymisé — les marqueurs [NOM_CLIENT], [ADRESSE], [IBAN], [EMAIL], [TÉLÉPHONE], [SIREN/SIRET] sont normaux, ignore-les).

════════ CONVERSIONS D'UNITÉS — À APPLIQUER OBLIGATOIREMENT ════════
Les prix doivent TOUS être retournés en **€/MWh HT** :
  • Prix en **c€/kWh** (centimes d'euro par kWh) → **multiplier par 10**
      ex : 13,160 c€/kWh × 10 = 131,60 €/MWh   (PAS 1316 !)
      ex : 2,998 c€/kWh × 10 = 29,98 €/MWh
  • Prix en **€/kWh** (euros par kWh) → **multiplier par 1000**
      ex : 0,10586910 €/kWh × 1000 = 105,87 €/MWh
      ex : 0,0300 €/kWh × 1000 = 30,00 €/MWh
      ex : 0,00429 €/kWh × 1000 = 4,29 €/MWh
  • Prix déjà en **€/MWh** → laisser tel quel
      ex : 38,90 €/MWh → 38,90

════════ PRIX UNITAIRE ≠ MONTANT TOTAL ════════
Ne JAMAIS confondre "Prix unitaire" (colonne Prix HT €/kWh ou €/MWh) et "Montant" (colonne Montants HT € — total facturé pour la période).
  • Un prix de fourniture est TOUJOURS < 500 €/MWh (au-delà, tu t'es trompé)
  • Un prix CEE est TOUJOURS < 30 €/MWh
  • Un prix TICFE (accise élec) est TOUJOURS entre 20 et 40 €/MWh
  • Un prix TICGN (gaz) est TOUJOURS entre 8 et 25 €/MWh
  • Un prix capacité est TOUJOURS < 5 €/MWh
Si une "valeur candidate" dépasse ces plafonds, c'est un montant total, pas un prix unitaire → chercher le vrai prix unitaire €/kWh ou €/MWh dans la même ligne du tableau.

════════ ANNUALISATION DES VOLUMES ════════
volume_annuel_mwh doit TOUJOURS être en MWh sur 12 mois.
Ordre de priorité :
  1. **CAR** (Consommation Annuelle de Référence) — gaz — utiliser tel quel : "CAR : BASE:195141 kWh" → 195,141 MWh
  2. **Bilan annuel** — élec — chercher "Bilan annuel des consommations facturées" → utiliser le kWh total annuel
  3. **Extrapolation** — si aucun des deux : volume_periode_kwh × 365 / nb_jours_periode / 1000
     ex : 2611 kWh sur 30 jours → 2611 × 365 / 30 / 1000 = 31,77 MWh (PAS 3 MWh !)
     ex : 5324 kWh sur 30 jours → 5324 × 365 / 30 / 1000 = 64,77 MWh (PAS 5,32 MWh !)

Les volumes par poste (volume_par_poste_mwh) doivent aussi être annualisés (même méthode).

════════ CEE ════════
- Sommer CEE classique + CEE précarité s'ils sont séparés (ex : Plenitude 4,29 + 2,66 = 6,95 €/MWh)
- Utiliser le prix EFFECTIVEMENT APPLIQUÉ sur la période facturée, PAS les évolutions futures annoncées dans les notes d'information

════════ OÙ METTRE LE PRIX DE FOURNITURE (IMPORTANT) ════════
Le prix de fourniture va TOUJOURS dans **prix_fourniture_eur_mwh** selon la structure tarifaire :
  • **Gaz** (toujours) : mettre le prix dans le poste **Base**
  • **Élec Unique** (Tarif Bleu Base) : poste **Base**
  • **Élec 2 postes** (HP/HC) : postes **HP** et **HC**
  • **Élec 4 postes** (Horosaisonnalisé) : postes **HPH/HCH/HPE/HCE** (+ HPTE si Pointe)

════════ AUTRES RÈGLES ════════
- Segment élec : ≤ 36 kVA = C5, > 36 kVA BT = C4, HTA = C1/C2/C3
- Segment gaz : d'abord chercher "Tarif : T1/T2/T3/T4" ; sinon déduire par le CAR CONVERTI EN MWh (< 300 MWh = T1, 300-5000 MWh = T2, 5000-50000 MWh = T3, > 50000 MWh = T4)
      ⚠️ ATTENTION : si le CAR est affiché en kWh, CONVERTIR d'abord en MWh (÷1000) avant de comparer aux seuils
- Le prix "Base" désigne le tarif unique ; il ne coexiste pas avec HP/HC ou HPH/HCH/etc
- Abonnement (€/mois) : sommer les sous-postes fourniture + acheminement + stockage. NE PAS inclure les CTA ni la location compteur.
- Prix TICFE = "Accise sur l'Électricité"
- Ne rien inventer. Si une valeur n'est pas explicitement présente ou dérivable, laisser null et le signaler dans notes
- Confiance "high" = tout est net ; "medium" = quelques déductions ; "low" = ambiguïtés majeures`;

// ---------- Models to benchmark ----------
const MODELS = [
  { id: 'gpt-4o-mini',  label: 'GPT-4o mini',  inputPer1M: 0.15,  outputPer1M: 0.60,  isReasoning: false },
  { id: 'gpt-4.1-nano', label: 'GPT-4.1 nano', inputPer1M: 0.10,  outputPer1M: 0.40,  isReasoning: false },
  { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', inputPer1M: 0.40,  outputPer1M: 1.60,  isReasoning: false },
  { id: 'gpt-4o',       label: 'GPT-4o',       inputPer1M: 2.50,  outputPer1M: 10.00, isReasoning: false },
  { id: 'gpt-4.1',      label: 'GPT-4.1',      inputPer1M: 2.00,  outputPer1M: 8.00,  isReasoning: false },
  { id: 'o4-mini',      label: 'o4-mini',       inputPer1M: 1.10,  outputPer1M: 4.40,  isReasoning: true },
];

const INVOICES = [
  // Originales (Downloads)
  { file: 'FACTURE ELECTRICITE MOTOCULTURE.pdf', label: 'Elec Motoculture', dir: 'downloads' },
  { file: 'FACTURE ELECTRICITE MAGASIN hamon.pdf', label: 'Elec Hamon', dir: 'downloads' },
  { file: 'EDF facture fourneaux.pdf', label: 'EDF Fourneaux', dir: 'downloads' },
  { file: 'FACTURE GAZ MAGASIN hamon.pdf', label: 'Gaz Hamon', dir: 'downloads' },
  { file: 'Energie AMbapharm 03.2023.pdf', label: 'Ambapharm 2023', dir: 'downloads' },
  // Nouvelles (Music/Facture new)
  { file: '020040489260 (2).pdf', label: '020040489260', dir: 'new' },
  { file: '20260720130806.pdf', label: '20260720130806', dir: 'new' },
  { file: '640000519261 (2).pdf', label: '640000519261', dir: 'new' },
  { file: 'edf 08-2023 PLOIR.pdf', label: 'EDF Ploir 2023', dir: 'new' },
  { file: 'ELMY 01052026 CINE.pdf', label: 'Elmy Ciné 2026', dir: 'new' },
  { file: 'FME003868918.pdf', label: 'FME003868918', dir: 'new' },
  { file: 'P26020651-BP91946752277903E-23129377672342-932971 (2).pdf', label: 'P26020651', dir: 'new' },
  { file: 'SEFE 11052026.pdf', label: 'SEFE 2026', dir: 'new' },
];

const DIRS = {
  downloads: 'C:\\Users\\DamienLauger\\Downloads',
  new: 'C:\\Users\\DamienLauger\\Music\\Facture new',
};

// ---------- API call ----------
async function callModel(modelCfg, anonymizedText) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY manquante');

  const messages = [
    { role: modelCfg.isReasoning ? 'developer' : 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: 'Extraire les données de la facture ci-dessous (texte anonymisé, marqueurs [...] à ignorer).\n\n' + anonymizedText },
  ];

  const body = {
    model: modelCfg.id,
    messages,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'facture_energie', strict: true, schema: EXTRACTION_SCHEMA },
    },
  };
  if (!modelCfg.isReasoning) body.temperature = 0;

  const t0 = Date.now();
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify(body),
  });

  const latencyMs = Date.now() - t0;

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`${modelCfg.id} HTTP ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const json = await resp.json();
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error(`${modelCfg.id}: réponse vide`);

  const usage = json.usage || {};
  const promptTokens = usage.prompt_tokens || 0;
  const completionTokens = usage.completion_tokens || 0;
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens || 0;

  const costInput = (promptTokens / 1_000_000) * modelCfg.inputPer1M;
  const costOutput = (completionTokens / 1_000_000) * modelCfg.outputPer1M;

  return {
    data: JSON.parse(content),
    promptTokens,
    completionTokens,
    reasoningTokens,
    costUsd: costInput + costOutput,
    latencyMs,
  };
}

// ---------- Precision scoring ----------
const KEY_FIELDS = [
  'fournisseur', 'energie', 'type_tarif', 'segment',
  'volume_annuel_mwh', 'volume_periode_kwh', 'puissance_souscrite_kva',
  'cee_eur_mwh', 'capacite_eur_mwh', 'ticfe_eur_mwh', 'ticgn_eur_mwh',
  'abonnement_eur_mois', 'confidence',
];

function getPrixFields(data) {
  const p = data.prix_fourniture_eur_mwh || {};
  const out = {};
  for (const k of ['Base', 'HP', 'HC', 'HPH', 'HCH', 'HPE', 'HCE', 'HPTE']) {
    if (p[k] != null) out['prix_' + k] = p[k];
  }
  return out;
}

function extractKeyValues(data) {
  const vals = {};
  for (const f of KEY_FIELDS) vals[f] = data[f] ?? null;
  Object.assign(vals, getPrixFields(data));
  return vals;
}

function buildConsensus(allResults) {
  const fieldVotes = {};
  for (const r of allResults) {
    if (!r || !r.data) continue;
    const vals = extractKeyValues(r.data);
    for (const [k, v] of Object.entries(vals)) {
      if (v == null) continue;
      if (!fieldVotes[k]) fieldVotes[k] = [];
      fieldVotes[k].push(v);
    }
  }
  const consensus = {};
  for (const [k, votes] of Object.entries(fieldVotes)) {
    if (typeof votes[0] === 'number') {
      const groups = {};
      for (const v of votes) {
        const rounded = Math.round(v * 100) / 100;
        groups[rounded] = (groups[rounded] || 0) + 1;
      }
      let best = null, bestCount = 0;
      for (const [val, count] of Object.entries(groups)) {
        if (count > bestCount) { best = parseFloat(val); bestCount = count; }
      }
      consensus[k] = best;
    } else {
      const counts = {};
      for (const v of votes) counts[v] = (counts[v] || 0) + 1;
      let best = null, bestCount = 0;
      for (const [val, count] of Object.entries(counts)) {
        if (count > bestCount) { best = val; bestCount = count; }
      }
      consensus[k] = best;
    }
  }
  return consensus;
}

function scorePrecision(data, consensus) {
  const vals = extractKeyValues(data);
  let total = 0, match = 0;
  for (const [k, expected] of Object.entries(consensus)) {
    total++;
    const actual = vals[k];
    if (actual == null && expected == null) { match++; continue; }
    if (actual == null || expected == null) continue;
    if (typeof expected === 'number') {
      const tolerance = Math.max(Math.abs(expected) * 0.02, 0.5);
      if (Math.abs(actual - expected) <= tolerance) match++;
    } else {
      if (String(actual).toLowerCase() === String(expected).toLowerCase()) match++;
    }
  }
  return total > 0 ? Math.round((match / total) * 100) : 0;
}

// ---------- Main ----------
async function main() {
  console.log('=== BENCHMARK MODELES OPENAI - EXTRACTION FACTURES ===\n');

  // Step 1: anonymize all PDFs once
  console.log('--- Anonymisation des PDFs ---');
  const anonymizedTexts = {};
  for (const inv of INVOICES) {
    const pdfPath = path.join(DIRS[inv.dir], inv.file);
    console.log(`  Anonymisation: ${inv.label}...`);
    try {
      anonymizedTexts[inv.label] = await anonymizePdf(pdfPath);
      console.log(`    OK (${anonymizedTexts[inv.label].length} chars)`);
    } catch (e) {
      console.error(`    ERREUR: ${e.message}`);
    }
  }

  const validInvoices = INVOICES.filter(inv => anonymizedTexts[inv.label]);
  console.log(`\n${validInvoices.length}/${INVOICES.length} factures anonymisées avec succès.\n`);

  // Step 2: run each model on each invoice
  const results = {};
  for (const model of MODELS) {
    results[model.id] = { model: model, invoices: {} };
    console.log(`--- ${model.label} (${model.id}) ---`);

    for (const inv of validInvoices) {
      process.stdout.write(`  ${inv.label}... `);
      try {
        const r = await callModel(model, anonymizedTexts[inv.label]);
        results[model.id].invoices[inv.label] = r;
        console.log(`OK (${r.latencyMs}ms, ${r.promptTokens}+${r.completionTokens} tokens, $${r.costUsd.toFixed(4)})`);
      } catch (e) {
        results[model.id].invoices[inv.label] = { error: e.message };
        console.log(`ERREUR: ${e.message.slice(0, 100)}`);
      }
    }
  }

  // Step 3: compute precision scores (consensus-based)
  console.log('\n--- Calcul de la précision (consensus inter-modèles) ---');
  const precisionScores = {};

  for (const inv of validInvoices) {
    const allForInvoice = MODELS.map(m => results[m.id].invoices[inv.label]).filter(r => r && !r.error);
    const consensus = buildConsensus(allForInvoice);

    for (const model of MODELS) {
      const r = results[model.id].invoices[inv.label];
      if (!r || r.error) continue;
      const score = scorePrecision(r.data, consensus);
      if (!precisionScores[model.id]) precisionScores[model.id] = [];
      precisionScores[model.id].push({ invoice: inv.label, score, confidence: r.data.confidence });
    }
  }

  // Step 4: aggregate
  const summary = MODELS.map(m => {
    const invResults = Object.values(results[m.id].invoices).filter(r => !r.error);
    const totalCost = invResults.reduce((s, r) => s + (r.costUsd || 0), 0);
    const avgLatency = invResults.length ? Math.round(invResults.reduce((s, r) => s + (r.latencyMs || 0), 0) / invResults.length) : 0;
    const totalInput = invResults.reduce((s, r) => s + (r.promptTokens || 0), 0);
    const totalOutput = invResults.reduce((s, r) => s + (r.completionTokens || 0), 0);
    const totalReasoning = invResults.reduce((s, r) => s + (r.reasoningTokens || 0), 0);
    const scores = (precisionScores[m.id] || []).map(s => s.score);
    const avgPrecision = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
    const confidences = (precisionScores[m.id] || []).map(s => s.confidence);
    const highCount = confidences.filter(c => c === 'high').length;
    const medCount = confidences.filter(c => c === 'medium').length;
    const lowCount = confidences.filter(c => c === 'low').length;

    return {
      model: m.id,
      label: m.label,
      nbInvoices: invResults.length,
      avgPrecision,
      precisionScores: scores,
      confidence: { high: highCount, medium: medCount, low: lowCount },
      avgLatencyMs: avgLatency,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalReasoningTokens: totalReasoning,
      totalCostUsd: Math.round(totalCost * 10000) / 10000,
      costPerInvoiceUsd: invResults.length ? Math.round((totalCost / invResults.length) * 10000) / 10000 : 0,
      inputPer1M: m.inputPer1M,
      outputPer1M: m.outputPer1M,
    };
  });

  // Step 5: output
  console.log('\n========================================');
  console.log('         RESULTATS DU BENCHMARK');
  console.log('========================================\n');

  const colW = [18, 10, 10, 12, 12, 10, 12, 10];
  const header = ['Modèle', 'Précis.%', 'Confiance', 'Latence ms', 'Tokens in', 'Tokens out', 'Coût total', 'Coût/fact'];
  console.log(header.map((h, i) => h.padEnd(colW[i])).join(' | '));
  console.log(colW.map(w => '-'.repeat(w)).join('-+-'));

  for (const s of summary) {
    const conf = `H:${s.confidence.high} M:${s.confidence.medium} L:${s.confidence.low}`;
    const row = [
      s.label.padEnd(colW[0]),
      `${s.avgPrecision}%`.padEnd(colW[1]),
      conf.padEnd(colW[2]),
      `${s.avgLatencyMs}`.padEnd(colW[3]),
      `${s.totalInputTokens}`.padEnd(colW[4]),
      `${s.totalOutputTokens}`.padEnd(colW[5]),
      `$${s.totalCostUsd.toFixed(4)}`.padEnd(colW[6]),
      `$${s.costPerInvoiceUsd.toFixed(4)}`.padEnd(colW[7]),
    ];
    console.log(row.join(' | '));
  }

  // Save full results to JSON
  const outputPath = path.join(__dirname, '..', 'benchmark-results.json');
  const fullOutput = { timestamp: new Date().toISOString(), summary, details: {} };
  for (const model of MODELS) {
    fullOutput.details[model.id] = {};
    for (const inv of validInvoices) {
      const r = results[model.id].invoices[inv.label];
      if (r && !r.error) {
        fullOutput.details[model.id][inv.label] = {
          data: r.data,
          promptTokens: r.promptTokens,
          completionTokens: r.completionTokens,
          reasoningTokens: r.reasoningTokens,
          costUsd: r.costUsd,
          latencyMs: r.latencyMs,
        };
      }
    }
  }
  fs.writeFileSync(outputPath, JSON.stringify(fullOutput, null, 2), 'utf8');
  console.log(`\nRésultats détaillés sauvegardés dans: ${outputPath}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
