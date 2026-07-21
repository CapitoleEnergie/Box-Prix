"""
Extraction texte + anonymisation des données personnelles d'une facture d'énergie.
Retourne (stdout) le texte nettoyé, prêt à être envoyé à OpenAI.

Anonymisé : nom/raison sociale, adresse, SIRET/SIREN, IBAN/TVA, email, téléphone.
Conservé : fournisseur, PDL/PCE/PRM, prix, volumes, dates, puissance, tarif, taxes.
"""
import re
import sys
import fitz  # PyMuPDF

RE_IBAN = re.compile(
    r'\b(?:FR|BE|DE|LU|IT|ES|NL|CH|GB|IE)\s?[X\d]{2}(?:\s+[X\d]{4,5})+(?:\s+\d{5,15})?(?:\s+[X\d]{1,4})?\b'
    r'|\b(?:FR|BE|DE|LU|IT|ES|NL|CH|GB|IE)\d{10,30}\b',
    re.IGNORECASE,
)
RE_BIC = re.compile(r'\bBIC\s*:?\s*[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b', re.IGNORECASE)
# SIRET/SIREN : uniquement si contextualisé par un mot-clé, sinon on risque de masquer un PDL
RE_SIREN_CTX = re.compile(
    r'((?:N[°o]?\s*)?SIRE[NT]\s*:?\s*)([X\d]{3}[\sX\d]{6,18})',
    re.IGNORECASE,
)
RE_TVA_FR = re.compile(r'\bFR\s?\d{2}\s?\d{9}\b')
RE_EMAIL = re.compile(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b')
RE_PHONE = re.compile(r'(?<!\d)(?:\+33|0)\s*[1-9](?:[\s.-]?\d{2}){4}(?!\d)')
RE_CP_VILLE = re.compile(
    r'\b\d{5}\s*,?\s*[A-ZÉÈÊÀÂÎÏÔÙÛÇ][A-Za-zÉÈÊÀÂÎÏÔÙÛÇéèêàâîïôùûç\'\- ]{1,50}\b'
)
RE_RUE = re.compile(
    r'\b\d{1,4}\s?(?:BIS|TER)?\s*(?:RUE|AVENUE|AV\.?|BOULEVARD|BD\.?|CHEMIN|CHE|IMPASSE|IMP\.?|ROUTE|RTE|ALL[ÉE]E|PLACE|PL\.?|Z\.?I\.?|ZAC|ZONE\s+INDUSTRIELLE|ZONE|Z\s+INDUSTRIELLE|ZI)\s+[A-Za-zÉÈÊÀÂÎÏÔÙÛÇéèêàâîïôùûç\'\-. 0-9]{2,100}'
    r'|\b(?:Z\s+INDUSTRIELLE|ZONE\s+INDUSTRIELLE|Z\.?I\.?|ZAC|ZONE\s+D[EA]?\s*ACTIVIT[ÉE])\s+DE?\s+[A-ZÉÈ][A-Za-zÉÈÊÀÂÎÏÔÙÛÇéèêàâîïôùûç\'\-. 0-9]{2,60}',
    re.IGNORECASE,
)

# Blocs client : lignes suivantes = raison sociale + adresse
CLIENT_KEYWORDS = re.compile(
    r'(Nom du client|Raison sociale|Adresse du client|Adresse du site|Lieu de consommation|Envoi\s*/\s*Email)',
    re.IGNORECASE,
)
# Ligne « raison sociale » plausible : plutôt majuscules, plusieurs caractères
RE_UPPER_LINE = re.compile(
    r'^[A-Z0-9ÉÈÊÀÂÎÏÔÙÛÇ\'\-&\.,\s]{4,100}$'
)


def collect_client_names(lines: list[str]) -> set[str]:
    """Collecte les noms/raisons sociales candidats à partir des blocs clients détectés."""
    names: set[str] = set()
    triggered = 0
    for line in lines:
        stripped = line.strip()
        if triggered > 0 and stripped:
            # Retenir uniquement les lignes qui ressemblent à un nom d'entreprise (majuscules)
            if RE_UPPER_LINE.match(stripped) and any(c.isalpha() for c in stripped) and len(stripped) >= 4:
                # Éviter d'attraper des libellés techniques
                if not re.search(r'\b(TVA|SIREN|SIRET|FACTURE|PAGE|CEE|CPB|TICGN|CTA|EDF|MET|PICOTY|PLENITUDE|ENGIE|TOTALENERGIES|EKWATEUR|BASE|OPTION|TARIF)\b', stripped, re.IGNORECASE):
                    names.add(stripped)
                triggered -= 1
                continue
            # Ligne d'adresse (chiffres/rue/CP) : on ne retient pas, mais on continue
            if RE_CP_VILLE.search(stripped) or RE_RUE.search(stripped) or re.match(r'^\d{1,4}\s', stripped):
                triggered -= 1
                continue
            triggered = 0
        if CLIENT_KEYWORDS.search(line):
            triggered = 4
    return names


def anonymize_lines(lines: list[str]) -> list[str]:
    """1re passe : masquer les blocs client (mot-clé + N lignes suivantes)."""
    out = []
    skip_next = 0
    for line in lines:
        stripped = line.strip()
        if skip_next > 0 and stripped:
            looks_like_pii = (
                RE_UPPER_LINE.match(stripped)
                or RE_CP_VILLE.search(stripped)
                or RE_RUE.search(stripped)
                or re.match(r'^\d{1,4}\s', stripped)
            )
            if looks_like_pii:
                out.append('[CLIENT_ANONYMISÉ]')
                skip_next -= 1
                continue
            else:
                skip_next = 0
        if CLIENT_KEYWORDS.search(line):
            out.append(line)
            skip_next = 4
            continue
        out.append(line)
    return out


def mask_addresses_and_names_around(text: str) -> str:
    """2e passe : masquer les adresses puis les noms en majuscules qui les jouxtent."""
    # Adresses d'abord (regex ciblées)
    text = RE_RUE.sub('[ADRESSE]', text)
    text = RE_CP_VILLE.sub('[ADRESSE]', text)

    # Ensuite : masquer les lignes MAJUSCULES qui sont *adjacentes* à une [ADRESSE]
    lines = text.split('\n')
    n = len(lines)
    to_mask = set()
    for i, line in enumerate(lines):
        stripped = line.strip()
        if '[ADRESSE]' in stripped or '[CLIENT_ANONYMISÉ]' in stripped:
            # Regarder 2 lignes avant : si ligne en majuscules → probable raison sociale
            for k in (1, 2, 3):
                j = i - k
                if j < 0:
                    break
                s = lines[j].strip()
                if not s or '[ADRESSE]' in s or '[CLIENT_ANONYMISÉ]' in s:
                    continue
                if RE_UPPER_LINE.match(s) and len(s) >= 4 and any(c.isalpha() for c in s):
                    # Éviter d'avaler des libellés génériques
                    if re.search(r'\b(TVA|SIREN|SIRET|FACTURE|PAGE|CEE|CPB|TICGN|CTA|EDF|MET|PICOTY|PLENITUDE|ENGIE|TOTALENERGIES|EKWATEUR)\b', s, re.IGNORECASE):
                        continue
                    to_mask.add(j)
    for j in to_mask:
        lines[j] = '[NOM_CLIENT]'

    # Passe additionnelle : si une ligne courte en MAJUSCULES suit une [ADRESSE], la masquer
    # (cas fréquent : nom de ville isolé sur une ligne après le CP)
    for i in range(1, len(lines)):
        prev = lines[i - 1].strip()
        cur = lines[i].strip()
        if '[ADRESSE]' in prev and cur and len(cur) <= 40:
            if RE_UPPER_LINE.match(cur) and any(c.isalpha() for c in cur):
                if not re.search(r'\b(TVA|SIREN|SIRET|FACTURE|PAGE|CEE|CPB|TICGN|CTA|EDF|MET|PICOTY|PLENITUDE|ENGIE|TOTAL|EKWATEUR)\b', cur, re.IGNORECASE):
                    lines[i] = '[VILLE]'
    return '\n'.join(lines)


def anonymize(text: str) -> str:
    lines = text.split('\n')
    client_names = collect_client_names(lines)
    lines = anonymize_lines(lines)
    text = '\n'.join(lines)

    # Masquer les noms client détectés partout ailleurs dans le doc
    for name in sorted(client_names, key=len, reverse=True):
        # Nom exact (case-sensitive) + variantes
        pattern = re.escape(name)
        text = re.sub(pattern, '[NOM_CLIENT]', text)

    # Regex ciblées
    text = RE_IBAN.sub('[IBAN]', text)
    text = RE_BIC.sub('BIC : [BIC]', text)
    text = RE_TVA_FR.sub('[TVA]', text)
    text = RE_SIREN_CTX.sub(lambda m: m.group(1) + '[SIREN/SIRET]', text)
    text = RE_EMAIL.sub('[EMAIL]', text)
    text = RE_PHONE.sub('[TÉLÉPHONE]', text)

    # Masquer adresses + noms voisins
    text = mask_addresses_and_names_around(text)

    # Compacter les répétitions
    text = re.sub(r'(\[(?:CLIENT_ANONYMISÉ|NOM_CLIENT|ADRESSE)\][\s\n]*){3,}',
                  '[CLIENT_ANONYMISÉ]\n', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text


def extract(pdf_path: str) -> str:
    doc = fitz.open(pdf_path)
    parts = []
    for i, page in enumerate(doc):
        parts.append(f'\n--- PAGE {i + 1} ---\n')
        parts.append(page.get_text('text'))
    doc.close()
    return anonymize(''.join(parts))


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: pdf_anonymize.py <pdf_path>', file=sys.stderr)
        sys.exit(1)
    sys.stdout.reconfigure(encoding='utf-8')
    print(extract(sys.argv[1]))
