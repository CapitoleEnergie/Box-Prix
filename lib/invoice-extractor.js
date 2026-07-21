'use strict';
/**
 * Extraction structurée d'une facture d'énergie via OpenAI (gpt-4o-mini).
 *
 * Pipeline :
 *   PDF ─► python lib/pdf_anonymize.py ─► texte anonymisé
 *        (nom, adresse, SIRET, IBAN, email, téléphone masqués)
 *        ─► OpenAI Chat Completions API avec JSON Schema strict
 *        ─► JSON structuré normalisé (prix en €/MWh, volume annualisé…)
 *
 * Aucune dépendance npm : appel HTTPS natif (Node >=18 : global fetch).
 * Clé OpenAI lue dans .env (jamais dans le code, jamais loguée).
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ---------- .env loader (zéro dépendance) ----------
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
}
loadEnv();

// ---------- Anonymisation (Python) ----------
function anonymizePdf(pdfPath) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, 'pdf_anonymize.py');
    const proc = spawn('python', [script, pdfPath], { windowsHide: true });
    let out = '', err = '';
    proc.stdout.on('data', (d) => { out += d.toString('utf8'); });
    proc.stderr.on('data', (d) => { err += d.toString('utf8'); });
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error('Anonymisation échouée : ' + err));
      resolve(out);
    });
    proc.on('error', reject);
  });
}

// ---------- Schéma JSON d'extraction (structured outputs OpenAI) ----------
const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fournisseur: {
      type: 'string',
      description: 'Nom du fournisseur (EDF, MET Energie France, Plenitude, Picoty Gaz, TotalEnergies, Engie, Ekwateur…).',
    },
    energie: { type: 'string', enum: ['elec', 'gaz'] },
    reference_pdl: {
      type: ['string', 'null'],
      description: 'Point de Livraison élec (PDL/PRM 14 chiffres) OU Point de Comptage gaz (PCE 14 chiffres). Conservé tel quel.',
    },
    date_facture: { type: ['string', 'null'], description: 'Date d’émission de la facture (YYYY-MM-DD).' },
    periode_debut: { type: ['string', 'null'], description: 'Début période de consommation (YYYY-MM-DD).' },
    periode_fin: { type: ['string', 'null'], description: 'Fin période de consommation (YYYY-MM-DD).' },
    date_debut_contrat: { type: ['string', 'null'], description: 'Date de souscription du contrat, si mentionnée.' },
    date_fin_contrat: { type: ['string', 'null'], description: 'Date d’échéance du contrat, si mentionnée.' },

    // Config tarifaire
    type_tarif: {
      type: 'string',
      enum: ['Unique', 'HP_HC', 'Horo_4postes', 'Horo_5postes', 'Inconnu'],
      description: 'Structure des postes de prix (Unique = Base ; HP_HC = 2 postes ; Horo_4postes = HPH/HCH/HPE/HCE ; Horo_5postes = + Pointe).',
    },
    segment: {
      type: ['string', 'null'],
      description: 'Segment déduit (C1..C5 pour élec, T1..T4 pour gaz). Si non certain, laisser null.',
    },
    puissance_souscrite_kva: { type: ['number', 'null'] },

    // Volumes (annualisés autant que possible)
    volume_annuel_mwh: {
      type: ['number', 'null'],
      description: 'Consommation annuelle en MWh. Si un CAR (Consommation Annuelle de Référence) ou un bilan annuel est indiqué, l’utiliser. Sinon, extrapoler depuis la période facturée (ratio 365 / nb_jours).',
    },
    volume_periode_kwh: {
      type: ['number', 'null'],
      description: 'Consommation kWh sur la période de facturation (avant annualisation).',
    },
    volume_par_poste_mwh: {
      type: 'object',
      additionalProperties: false,
      properties: {
        Base: { type: ['number', 'null'] },
        HP: { type: ['number', 'null'] },
        HC: { type: ['number', 'null'] },
        HPH: { type: ['number', 'null'] },
        HCH: { type: ['number', 'null'] },
        HPE: { type: ['number', 'null'] },
        HCE: { type: ['number', 'null'] },
        HPTE: { type: ['number', 'null'] },
      },
      required: ['Base', 'HP', 'HC', 'HPH', 'HCH', 'HPE', 'HCE', 'HPTE'],
      description: 'Volumes annualisés par poste (MWh). Renseigner uniquement les postes présents sur la facture.',
    },

    // Prix (fourniture, marge incluse — c’est le prix tout compris du contrat en cours)
    prix_fourniture_eur_mwh: {
      type: 'object',
      additionalProperties: false,
      properties: {
        Base: { type: ['number', 'null'] },
        HP: { type: ['number', 'null'] },
        HC: { type: ['number', 'null'] },
        HPH: { type: ['number', 'null'] },
        HCH: { type: ['number', 'null'] },
        HPE: { type: ['number', 'null'] },
        HCE: { type: ['number', 'null'] },
        HPTE: { type: ['number', 'null'] },
      },
      required: ['Base', 'HP', 'HC', 'HPH', 'HCH', 'HPE', 'HCE', 'HPTE'],
      description: 'Prix de fourniture HT par poste, TOUJOURS en €/MWh (convertir depuis c€/kWh ×10 ou €/kWh ×1000). Renseigner uniquement les postes tarifés.',
    },

    // Autres composantes utiles pour le simulateur
    abonnement_eur_mois: {
      type: ['number', 'null'],
      description: 'Abonnement mensuel total (fourniture seule ou fourniture + acheminement + stockage — préciser dans notes). En €/mois HT.',
    },
    cee_eur_mwh: {
      type: ['number', 'null'],
      description: 'Certificats d’économie d’énergie totaux (classique + précarité si séparés). En €/MWh HT.',
    },
    capacite_eur_mwh: { type: ['number', 'null'], description: 'Mécanisme de capacité (élec, si séparé). En €/MWh HT.' },
    ticfe_eur_mwh: { type: ['number', 'null'], description: 'Accise sur l’électricité (ex-TICFE/CSPE). En €/MWh.' },
    ticgn_eur_mwh: { type: ['number', 'null'], description: 'TICGN (gaz). En €/MWh.' },
    cpb_eur_mwh: { type: ['number', 'null'], description: 'Contribution Production Biogaz (gaz). En €/MWh.' },

    // Diagnostic
    notes: {
      type: ['string', 'null'],
      description: 'Points d’attention pour la revue humaine : hypothèses d’annualisation, unités converties, ambiguïtés, ce qui a été laissé null.',
    },
    confidence: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description: 'Confiance globale dans l’extraction.',
    },
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
⚠️ CHAQUE FOURNISSEUR UTILISE SES PROPRES UNITÉS. Avant toute conversion, IDENTIFIER l'unité source dans le texte de la facture.

**Étape 1 — Détecter l'unité source du prix :**
  • Chercher l'en-tête de colonne ou l'indication d'unité à côté du prix : "€/kWh", "c€/kWh", "€/MWh"
  • Si la colonne dit "€/kWh" et la valeur est petite (ex: 0,05177) → c'est bien en €/kWh
  • Si la colonne dit "c€/kWh" et la valeur est à 2 chiffres (ex: 13,160) → c'est bien en c€/kWh
  • Si la colonne dit "€/MWh" et la valeur est à 2-3 chiffres (ex: 38,90) → c'est déjà en €/MWh

**Étape 2 — Convertir en €/MWh HT :**
  • Prix en **€/kWh** → **multiplier par 1000** (1 MWh = 1000 kWh)
      ex : 0,05177 €/kWh × 1000 = 51,77 €/MWh
      ex : 0,10586910 €/kWh × 1000 = 105,87 €/MWh
      ex : 0,0300 €/kWh × 1000 = 30,00 €/MWh
      ex : 0,00429 €/kWh × 1000 = 4,29 €/MWh
      ex : 0,01084 €/kWh × 1000 = 10,84 €/MWh (CEE)
      ex : 0,02658 €/kWh × 1000 = 26,58 €/MWh (TICFE)
  • Prix en **c€/kWh** (centimes d'euro par kWh) → **multiplier par 10**
      ex : 13,160 c€/kWh × 10 = 131,60 €/MWh   (PAS 1316 !)
      ex : 2,998 c€/kWh × 10 = 29,98 €/MWh
  • Prix déjà en **€/MWh** → laisser tel quel
      ex : 38,90 €/MWh → 38,90

**Étape 3 — VÉRIFIER le résultat (garde-fous) :**
  • Prix fourniture : entre 20 et 300 €/MWh (typiquement 40-200). Si > 300 → erreur de conversion probable, REFAIRE le calcul
  • Prix CEE : entre 1 et 20 €/MWh
  • Prix TICFE/accise élec : entre 20 et 40 €/MWh
  • Prix TICGN : entre 8 et 25 €/MWh
  • Prix capacité : < 5 €/MWh
  Si une valeur dépasse ces plages, c'est probablement une confusion d'unité ou un montant total en €.

════════ VOLUMES — TOUJOURS EN MWh ════════
Les volumes sur la facture sont généralement en **kWh**. TOUJOURS diviser par 1000 pour obtenir des MWh.
  • volume_periode_kwh : rester en kWh (c'est le champ kWh)
  • volume_annuel_mwh : TOUJOURS en MWh (÷ 1000 si la source est en kWh)
  • volume_par_poste_mwh : TOUJOURS en MWh (÷ 1000 si la source est en kWh)
      ex : "HP: 10 061 kWh" → volume_par_poste_mwh.HP = 10,061 MWh (PAS 10061 !)
      ex : "Consommation annuelle: 14 906 kWh" → volume_annuel_mwh = 14,906 MWh (PAS 14906 !)

════════ PRIX UNITAIRE ≠ MONTANT TOTAL ════════
Ne JAMAIS confondre "Prix unitaire" (colonne Prix HT €/kWh ou €/MWh) et "Montant" (colonne Montants HT € — total facturé pour la période).
Si une "valeur candidate" est un nombre à 3+ chiffres entiers (ex: 517, 1316), c'est probablement un montant total en euros ou une erreur de conversion — REFAIRE le calcul.

════════ ANNUALISATION DES VOLUMES ════════
volume_annuel_mwh doit TOUJOURS être en MWh sur 12 mois.
Ordre de priorité :
  1. **CAR** (Consommation Annuelle de Référence) — gaz — ATTENTION : souvent en kWh → diviser par 1000
      ex : "CAR : BASE:195141 kWh" → 195,141 MWh   (÷ 1000)
  2. **Bilan annuel** — élec — chercher "Bilan annuel des consommations facturées" → utiliser le kWh total annuel ÷ 1000
      ex : "14 906 kWh" → 14,906 MWh
  3. **Extrapolation** — si aucun des deux : volume_periode_kwh × 365 / nb_jours_periode / 1000
     ex : 2611 kWh sur 30 jours → 2611 × 365 / 30 / 1000 = 31,77 MWh (PAS 3 MWh !)
     ex : 5324 kWh sur 30 jours → 5324 × 365 / 30 / 1000 = 64,77 MWh (PAS 5,32 MWh !)
     ex : 11773 kWh sur 31 jours → 11773 × 365 / 31 / 1000 = 138,62 MWh

Les volumes par poste (volume_par_poste_mwh) doivent aussi être annualisés (même méthode).
⚠️ VÉRIFICATION : volume_annuel_mwh doit être cohérent avec volume_periode_kwh × (365/nb_jours)/1000. Si l'écart est > 50%, refaire le calcul.

════════ CEE ════════
- Sommer CEE classique + CEE précarité s'ils sont séparés (ex : Plenitude 4,29 + 2,66 = 6,95 €/MWh)
- Utiliser le prix EFFECTIVEMENT APPLIQUÉ sur la période facturée, PAS les évolutions futures annoncées dans les notes d'information
  (ex : Picoty facture à 7,72 €/MWh en 2025 avec annonce de 12,00 pour 2026 → mettre 7,72)

════════ OÙ METTRE LE PRIX DE FOURNITURE (IMPORTANT) ════════
Le prix de fourniture va TOUJOURS dans **prix_fourniture_eur_mwh** selon la structure tarifaire :
  • **Gaz** (toujours) : mettre le prix dans le poste **Base**
      ex : MET "Facturation Consommation GRD 38,90 €/MWh" → prix_fourniture_eur_mwh.Base = 38.90
      ex : Picoty "Gaz Naturel 158,84 €/MWh" → prix_fourniture_eur_mwh.Base = 158.84
  • **Élec Unique** (Tarif Bleu Base) : poste **Base**
  • **Élec 2 postes** (HP/HC) : postes **HP** et **HC**
  • **Élec 4 postes** (Horosaisonnalisé) : postes **HPH/HCH/HPE/HCE** (+ HPTE si Pointe)

════════ AUTRES RÈGLES ════════
- Segment élec : ≤ 36 kVA = C5, > 36 kVA BT = C4, HTA = C1/C2/C3 (préciser dans notes si ambigu)
- Segment gaz : d'abord chercher "Tarif : T1/T2/T3/T4" (MET l'écrit ainsi) ; sinon déduire par le CAR CONVERTI EN MWh (< 300 MWh = T1, 300-5000 MWh = T2, 5000-50000 MWh = T3, > 50000 MWh = T4)
      ⚠️ ATTENTION : si le CAR est affiché en kWh (ex : "CAR : BASE:195141 kWh" = 195,141 MWh = T1), CONVERTIR d'abord en MWh (÷1000) avant de comparer aux seuils
      ex : CAR 13,376 MWh → T1 (PAS T2 — 13 est bien < 300)
      ex : CAR 195,141 MWh → T1 (< 300)
      ex : CAR 1500 MWh → T2 (entre 300 et 5000)
- Le prix "Base" désigne le tarif unique (Option Base / Tarif Bleu Base) ; il ne coexiste pas avec HP/HC ou HPH/HCH/etc
- Abonnement (€/mois) : sommer les sous-postes fourniture + acheminement + stockage. NE PAS inclure les CTA (ce sont des taxes). NE PAS inclure la location de compteur/bloc détente (ce sont des services). Préciser dans notes le détail de la somme.
- Prix TICFE = "Accise sur l'Électricité"
- Ne rien inventer. Si une valeur n'est pas explicitement présente ou dérivable, laisser null et le signaler dans notes
- Confiance "high" = tout est net ; "medium" = quelques déductions ; "low" = ambiguïtés majeures`;

// ---------- Appel OpenAI ----------
async function callOpenAI(anonymizedText) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY manquante (voir .env)');

  const body = {
    model: 'gpt-4.1-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'Extraire les données de la facture ci-dessous (texte anonymisé, marqueurs [...] à ignorer).\n\n' + anonymizedText },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'facture_energie', strict: true, schema: EXTRACTION_SCHEMA },
    },
    temperature: 0,
  };

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`OpenAI ${resp.status} : ${errText.slice(0, 400)}`);
  }
  const json = await resp.json();
  const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!content) throw new Error('Réponse OpenAI vide');
  const usage = json.usage || null;
  return { data: JSON.parse(content), usage };
}

// ---------- Validation post-extraction (garde-fous ordres de grandeur) ----------
function validate(data) {
  const warnings = [];
  const check = (val, min, max, label) => {
    if (val == null) return;
    if (val < min || val > max) warnings.push(`${label} = ${val} hors plage attendue [${min} ; ${max}]`);
  };

  // Prix fourniture : typiquement 20-300 €/MWh, > 300 = erreur de conversion probable
  for (const [poste, val] of Object.entries(data.prix_fourniture_eur_mwh || {})) {
    if (val != null) check(val, 5, 300, `prix_fourniture_eur_mwh.${poste}`);
  }
  check(data.cee_eur_mwh, 0, 20, 'cee_eur_mwh');
  check(data.capacite_eur_mwh, 0, 5, 'capacite_eur_mwh');
  check(data.ticfe_eur_mwh, 15, 40, 'ticfe_eur_mwh');
  check(data.ticgn_eur_mwh, 5, 30, 'ticgn_eur_mwh');
  check(data.cpb_eur_mwh, 0, 30, 'cpb_eur_mwh');
  check(data.abonnement_eur_mois, 0, 5000, 'abonnement_eur_mois');
  check(data.volume_annuel_mwh, 0.1, 200000, 'volume_annuel_mwh');
  check(data.puissance_souscrite_kva, 0, 100000, 'puissance_souscrite_kva');

  // Cohérence type de tarif vs prix
  const P = data.prix_fourniture_eur_mwh || {};
  if (data.type_tarif === 'HP_HC' && (P.HP == null || P.HC == null)) {
    warnings.push('type_tarif=HP_HC mais prix HP/HC manquants');
  }
  if (data.type_tarif === 'Horo_4postes' && (P.HPH == null && P.HCH == null && P.HPE == null && P.HCE == null)) {
    warnings.push('type_tarif=Horo_4postes mais aucun prix HPH/HCH/HPE/HCE');
  }
  if (data.type_tarif === 'Unique' && P.Base == null && data.energie === 'elec') {
    warnings.push('type_tarif=Unique mais prix Base manquant');
  }

  if (warnings.length) {
    data.validation_warnings = warnings;
    if (data.confidence !== 'low') data.confidence = 'medium';
  }
  return data;
}

// ---------- API publique ----------
async function extractFromPdf(pdfPath) {
  if (!fs.existsSync(pdfPath)) throw new Error('PDF introuvable : ' + pdfPath);
  const anonymized = await anonymizePdf(pdfPath);
  if (!anonymized || anonymized.length < 100) throw new Error('Texte anonymisé trop court — extraction PDF probablement échouée');
  const { data, usage } = await callOpenAI(anonymized);
  return { data: validate(data), usage, anonymizedTextLength: anonymized.length };
}

module.exports = { extractFromPdf, anonymizePdf };
