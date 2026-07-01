# Simulateur Budgétaire — Capitole Énergie

Outil local de simulation de budget énergie (électricité & gaz) répliquant **fidèlement** le moteur de calcul Salesforce (chaîne `LigneOffreComputationService` → `ComputeLignesOffreDTO` → calculateurs TURPE / taxes / TVA / ATRT gaz).

## Principe

1. Coller l'**ID d'un compte** Salesforce → l'outil charge les **compteurs** rattachés.
2. Sélectionner un ou plusieurs compteurs.
3. Pour chaque compteur, saisir les paramètres tarifaires en deux colonnes :
   - **Actuel** : le contrat en cours du client.
   - **Estimé** : l'offre proposée.
4. L'outil calcule le **budget HTVA** de chaque scénario, la **différence (€/an et %)** et le **prix moyen €/MWh**, avec une synthèse globale multi-compteurs.

Le détail du calcul (fourniture, capacité, TURPE/acheminement, taxes, TVA…) est dépliable par compteur.

## Interface

Conforme à la **charte graphique Capitole Énergie 2026** : thème clair, dégradé Capitole, polices Bricolage Grotesque + Poppins, logo officiel, icônes Material Symbols. Parcours en 3 étapes (compte → compteurs → simulation), résultat mettant l'écart en avant, synthèse globale, et un bouton **« Guide & glossaire »** (en-tête) qui ouvre une fenêtre expliquant le calcul du budget et définissant chaque terme (TURPE, CTA, TICFE/TICGN, acheminement, etc.).

Les assets de marque sont dans `public/assets/` (logo extrait de la charte). Pour les remplacer par les fichiers officiels, déposer `logo-full.png` et `favicon.png` au même endroit.

## Prérequis

- **Node.js** (testé avec v24) — déjà installé.
- **Salesforce CLI** (`sf`) authentifiée sur l'org `prod` (alias par défaut).

## Lancement

Double-cliquer sur `start.bat`, ou en ligne de commande :

```sh
node server.js
```

Puis ouvrir **http://localhost:4173**.

### Variables d'environnement (optionnel)

| Variable      | Défaut                          | Rôle                                  |
|---------------|---------------------------------|---------------------------------------|
| `PORT`        | `4173`                          | Port du serveur web                   |
| `SF_ORG`      | `prod`                          | Alias / username de l'org Salesforce  |
| `SF_CLI_PATH` | `C:\Program Files\sf\bin\sf.cmd`| Chemin de l'exécutable `sf`           |

## Architecture

```
pricer-simulateur/
├─ server.js            Serveur HTTP (Node natif, zéro dépendance)
├─ labels.json          Snapshot des Custom Labels (taux taxes, TCK, prix distribution gaz)
├─ lib/
│  ├─ sf.js             Accès Salesforce via la CLI `sf`
│  ├─ reference.js      Chargement + cache des grilles TURPE / ATRD / métadonnées gaz (live)
│  ├─ compteurs.js      Requête compte → compteurs (+ RefGeo, APE/NAF, PITD, RecordType)
│  └─ engine.js         Moteur de calcul (port fidèle de l'Apex)
└─ public/              Frontend (index.html, app.js, styles.css)
```

### Données de référence

- Les **Custom Labels** (taux CTA, TVA, TICFE, TICGN, TCK, prix part variable distribution gaz) sont figés dans `labels.json`. Si l'org change ces taux, mettre à jour ce fichier.
- Les **grilles TURPE** (CG/CC/CS), **ATRD par segment** et **métadonnées acheminement gaz** (Coeff A, Coeff Zi, Client Distribution) sont interrogées **en direct** au démarrage du serveur (et mises en cache), donc toujours synchronisées avec l'org.

## Fidélité au moteur Salesforce

Le budget HTVA d'une ligne = `Calcul_TarifHorsTVA__c` :

- **Électricité** : `Abonnement + Énergie + Taxes(CTA + TICFE) + TURPE`
  - Énergie = Fourniture (marge incluse, par poste horaire) + Capacité + CEE + Énergie verte
  - TURPE = CC + CG + CS fixe + CS variable + CI (sélection de grille par tension/profil/type pointe/autoproduction/BTSup36kVA)
  - TICFE selon puissance souscrite (≤36 kVA vs > 36 kVA)
- **Gaz** : `Énergie + Taxes(CTA + TICGN) + Abonnement + Acheminement`
  - Énergie = Fourniture + CEE + CPB + Énergie verte + Part variable distribution
  - Acheminement (ATRT/ATRD) calculé via PITD + métadonnées (CJA = coefA × coefZi × CAR ; part stockage ; part transport = CJA × [TCS + TCR×NTR + TCL] ; + ATRD fixe par segment). Si le PITD/les métadonnées manquent, le champ est **saisissable**.
  - **CTA gaz** : constant par segment (T1/T2/T3) = 20,71 % × abonnement annuel ATRD GRDF, pré-rempli et ajustable. Pour le **T4**, il dépend de la souscription transport → à saisir manuellement (le champ est pré-rempli vide).
- **TVA** : taux normal 20 % (la TVA réduite a été retirée le 01/08/2025, conformément à l'org).

> Les taxes CEE / CPB / TICGN / CSPE sont appliquées selon les drapeaux **APE/NAF** du compte (affichés sous chaque résultat).

### Tests

```sh
npm test            # tests unitaires du moteur (déterministes, sans org)
npm run test:api    # tests d'intégration de l'API (serveur doit tourner)
npm run test:fidelity   # validation de masse vs données Salesforce réelles
npm run test:all    # tout : démarre un serveur de test, exécute les 3 suites
```

### Validation

Le moteur a été validé **au centime près** contre les valeurs `Calcul_*` réellement stockées dans Salesforce, sur **500 lignes d'offre réelles** (tous segments / types de tarif) :
- **HTVA exact : 98,2 %** (485/500). Le reliquat est intégralement dû à la limitation FLS C5 ci-dessous — la formule, elle, est exacte (composants à ~100 %).
- **Gaz** (T1/T2/T3) : **100 %** (fourniture, part var. distribution, TICGN, CTA, HTVA — Δ 0,00 €). Acheminement ATRT auto identique au moteur courant.
- **Élec** C2/C4 (Unique & Horosaisonnalisé) : **100 %**.
- Suite automatisée : **31 tests unitaires + 22 tests d'intégration**, tous au vert.

### Limites connues

- **FLS C5** : 3 champs de la grille `TURPE_CS__c` (`Tarif_Base__c`, `Tarif_HC__c`, `Tarif_HP__c`) ne sont pas lisibles par l'utilisateur courant (`dlauger`) → repli automatique sans ces champs. Impact : le TURPE variable des compteurs **C5 en profil Base ou HP/HC** est sous-estimé, donc leur **budget absolu** est légèrement bas (l'UI l'affiche en avertissement). ➜ **L'écart actuel/estimé reste exact** car le TURPE est identique des deux côtés et s'annule. **Correctif** : accorder l'accès en lecture (FLS) à ces 3 champs pour `dlauger` (ou la permission set de l'intégration) ; `reference.js` tente d'abord la requête complète et basculera automatiquement sur les vraies valeurs, sans modification de code.
- CTA gaz **T4** : non barémé (variable selon la capacité souscrite) → saisie manuelle.
- L'acheminement gaz auto requiert un **PITD** renseigné sur le compteur (Coeff A, Coeff Zi, Client Distribution, NTR). Sinon, saisie manuelle.
