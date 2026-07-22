'use strict';
/**
 * Extraction texte + anonymisation d'une facture d'énergie.
 * Port JS de lib/pdf_anonymize.py — mêmes règles regex, sortie identique.
 * Utilise pdfjs-dist (pur JS, compatible serverless / Vercel).
 *
 * Anonymisé : nom/raison sociale, adresse, SIRET/SIREN, IBAN/BIC, TVA, email, téléphone.
 * Conservé : fournisseur, PDL/PCE/PRM, prix, volumes, dates, puissance, tarif, taxes.
 */

const RE_IBAN = new RegExp(
  '\\b(?:FR|BE|DE|LU|IT|ES|NL|CH|GB|IE)\\s?[X\\d]{2}(?:\\s+[X\\d]{4,5})+(?:\\s+\\d{5,15})?(?:\\s+[X\\d]{1,4})?\\b'
  + '|\\b(?:FR|BE|DE|LU|IT|ES|NL|CH|GB|IE)\\d{10,30}\\b',
  'gi'
);
const RE_BIC = /\bBIC\s*:?\s*[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/gi;
const RE_SIREN_CTX = /((?:N[°o]?\s*)?SIRE[NT]\s*:?\s*)([X\d]{3}[\sX\d]{6,18})/gi;
const RE_TVA_FR = /\bFR\s?\d{2}\s?\d{9}\b/g;
const RE_EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const RE_PHONE = /(?<!\d)(?:\+33|0)\s*[1-9](?:[\s.-]?\d{2}){4}(?!\d)/g;
const RE_CP_VILLE = /\b\d{5}\s*,?\s*[A-ZÉÈÊÀÂÎÏÔÙÛÇ][A-Za-zÉÈÊÀÂÎÏÔÙÛÇéèêàâîïôùûç'\- ]{1,50}\b/g;
const RE_RUE = new RegExp(
  '\\b\\d{1,4}\\s?(?:BIS|TER)?\\s*(?:RUE|AVENUE|AV\\.?|BOULEVARD|BD\\.?|CHEMIN|CHE|IMPASSE|IMP\\.?|ROUTE|RTE|ALL[ÉE]E|PLACE|PL\\.?|Z\\.?I\\.?|ZAC|ZONE\\s+INDUSTRIELLE|ZONE|Z\\s+INDUSTRIELLE|ZI)\\s+[A-Za-zÉÈÊÀÂÎÏÔÙÛÇéèêàâîïôùûç\'\\-. 0-9]{2,100}'
  + '|\\b(?:Z\\s+INDUSTRIELLE|ZONE\\s+INDUSTRIELLE|Z\\.?I\\.?|ZAC|ZONE\\s+D[EA]?\\s*ACTIVIT[ÉE])\\s+DE?\\s+[A-ZÉÈ][A-Za-zÉÈÊÀÂÎÏÔÙÛÇéèêàâîïôùûç\'\\-. 0-9]{2,60}',
  'gi'
);
const CLIENT_KEYWORDS = /(Nom du client|Raison sociale|Adresse du client|Adresse du site|Lieu de consommation|Envoi\s*\/\s*Email)/i;
const RE_UPPER_LINE = /^[A-Z0-9ÉÈÊÀÂÎÏÔÙÛÇ'\-&.,\s]{4,100}$/;
const RE_TECH_LABELS = /\b(TVA|SIREN|SIRET|FACTURE|PAGE|CEE|CPB|TICGN|CTA|EDF|MET|PICOTY|PLENITUDE|ENGIE|TOTALENERGIES|EKWATEUR|BASE|OPTION|TARIF)\b/i;

function collectClientNames(lines) {
  const names = new Set();
  let triggered = 0;
  for (const line of lines) {
    const stripped = line.trim();
    if (triggered > 0 && stripped) {
      if (RE_UPPER_LINE.test(stripped) && /[A-Za-zÉÈÊÀÂÎÏÔÙÛÇ]/.test(stripped) && stripped.length >= 4) {
        if (!RE_TECH_LABELS.test(stripped)) names.add(stripped);
        triggered--;
        continue;
      }
      if (RE_CP_VILLE.test(stripped) || RE_RUE.test(stripped) || /^\d{1,4}\s/.test(stripped)) {
        RE_CP_VILLE.lastIndex = 0; RE_RUE.lastIndex = 0;
        triggered--;
        continue;
      }
      RE_CP_VILLE.lastIndex = 0; RE_RUE.lastIndex = 0;
      triggered = 0;
    }
    if (CLIENT_KEYWORDS.test(line)) triggered = 4;
  }
  return names;
}

function anonymizeLines(lines) {
  const out = [];
  let skipNext = 0;
  for (const line of lines) {
    const stripped = line.trim();
    if (skipNext > 0 && stripped) {
      const looksLikePII = RE_UPPER_LINE.test(stripped)
        || RE_CP_VILLE.test(stripped)
        || RE_RUE.test(stripped)
        || /^\d{1,4}\s/.test(stripped);
      RE_CP_VILLE.lastIndex = 0; RE_RUE.lastIndex = 0;
      if (looksLikePII) {
        out.push('[CLIENT_ANONYMISÉ]');
        skipNext--;
        continue;
      }
      skipNext = 0;
    }
    if (CLIENT_KEYWORDS.test(line)) {
      out.push(line);
      skipNext = 4;
      continue;
    }
    out.push(line);
  }
  return out;
}

function maskAddressesAndNamesAround(text) {
  text = text.replace(RE_RUE, '[ADRESSE]');
  text = text.replace(RE_CP_VILLE, '[ADRESSE]');

  const lines = text.split('\n');
  const toMask = new Set();
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (stripped.includes('[ADRESSE]') || stripped.includes('[CLIENT_ANONYMISÉ]')) {
      for (const k of [1, 2, 3]) {
        const j = i - k;
        if (j < 0) break;
        const s = lines[j].trim();
        if (!s || s.includes('[ADRESSE]') || s.includes('[CLIENT_ANONYMISÉ]')) continue;
        if (RE_UPPER_LINE.test(s) && s.length >= 4 && /[A-Za-zÉÈÊÀÂÎÏÔÙÛÇ]/.test(s)) {
          if (RE_TECH_LABELS.test(s)) continue;
          toMask.add(j);
        }
      }
    }
  }
  for (const j of toMask) lines[j] = '[NOM_CLIENT]';

  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1].trim();
    const cur = lines[i].trim();
    if (prev.includes('[ADRESSE]') && cur && cur.length <= 40) {
      if (RE_UPPER_LINE.test(cur) && /[A-Za-zÉÈÊÀÂÎÏÔÙÛÇ]/.test(cur)) {
        if (!/\b(TVA|SIREN|SIRET|FACTURE|PAGE|CEE|CPB|TICGN|CTA|EDF|MET|PICOTY|PLENITUDE|ENGIE|TOTAL|EKWATEUR)\b/i.test(cur)) {
          lines[i] = '[VILLE]';
        }
      }
    }
  }
  return lines.join('\n');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function anonymizeText(text) {
  let lines = text.split('\n');
  const clientNames = collectClientNames(lines);
  lines = anonymizeLines(lines);
  text = lines.join('\n');

  const sortedNames = [...clientNames].sort((a, b) => b.length - a.length);
  for (const name of sortedNames) {
    text = text.replace(new RegExp(escapeRegex(name), 'g'), '[NOM_CLIENT]');
  }

  text = text.replace(RE_IBAN, '[IBAN]');
  text = text.replace(RE_BIC, 'BIC : [BIC]');
  text = text.replace(RE_TVA_FR, '[TVA]');
  text = text.replace(RE_SIREN_CTX, (_, g1) => g1 + '[SIREN/SIRET]');
  text = text.replace(RE_EMAIL, '[EMAIL]');
  text = text.replace(RE_PHONE, '[TÉLÉPHONE]');

  text = maskAddressesAndNamesAround(text);

  text = text.replace(/(\[(?:CLIENT_ANONYMISÉ|NOM_CLIENT|ADRESSE)\][\s\n]*){3,}/g, '[CLIENT_ANONYMISÉ]\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text;
}

/**
 * Extrait le texte d'un PDF (buffer) via pdfjs-dist, page par page,
 * puis anonymise et renvoie le résultat.
 */
async function extractAndAnonymize(pdfBuffer) {
  // pdfjs-dist v4 est ESM-only : import dynamique.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(pdfBuffer);
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, disableFontFace: true, isEvalSupported: false }).promise;

  const parts = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    parts.push(`\n--- PAGE ${i} ---\n`);
    parts.push(reconstructText(content));
    page.cleanup();
  }
  await doc.destroy();
  return anonymizeText(parts.join(''));
}

/**
 * Réordonne les items d'une page en lignes (regroupement par Y, tri X),
 * pour se rapprocher du rendu texte que produit PyMuPDF.
 */
function reconstructText(content) {
  if (!content || !content.items || !content.items.length) return '';
  const items = content.items.map(it => {
    const t = it.transform || [1, 0, 0, 1, 0, 0];
    return { str: it.str || '', x: t[4], y: t[5], hasEOL: !!it.hasEOL };
  });
  items.sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const lines = [];
  let cur = [];
  let curY = null;
  const yTolerance = 3;
  for (const it of items) {
    if (curY == null || Math.abs(it.y - curY) <= yTolerance) {
      cur.push(it);
      curY = curY == null ? it.y : curY;
    } else {
      lines.push(cur);
      cur = [it];
      curY = it.y;
    }
  }
  if (cur.length) lines.push(cur);

  return lines
    .map(line => line.sort((a, b) => a.x - b.x).map(i => i.str).join(' ').replace(/\s+/g, ' ').trim())
    .filter(s => s.length)
    .join('\n');
}

module.exports = { extractAndAnonymize, anonymizeText };
