# 📊 Documentation DATA — Simulateur Budgétaire

> Ce document décrit **toutes les sources de données Salesforce** utilisées par le simulateur :
> objets, champs, requêtes SOQL, Custom Metadata Types, Custom Labels, et les **points
> d'attention DATA** critiques pour le bon fonctionnement du moteur.

---

## 1. Couche d'accès (`lib/sf.js`)

L'application **n'utilise pas l'API REST Salesforce directement**. Elle appelle la **CLI `sf`** .
en sous-processus (`sf data query --file ... -o prod --json`) et parse le JSON retourné.

| Élément | Valeur |
|---|---|
| Exécutable | `C:\Program Files\sf\bin\sf.cmd` (ou `SF_CLI_PATH`) |
| Org (alias) | `prod` (ou variable d'env `SF_ORG`) |
| Mode | SOQL écrite dans un fichier temporaire `.soql` puis `--file` (évite les problèmes de quoting) |
| API version | v67.0 |
| Tooling API | supportée via `-t` (utilisée uniquement pour introspection de schéma) |

⚠️ **Point d'attention** : sous Windows, `sf.cmd` doit être exécuté avec `shell:true` et le chemin
cité (espaces dans « Program Files »). Un warning de mise à jour de la CLI sur stdout peut
polluer le parsing JSON → **toujours lancer le serveur via `node server.js` directement**, pas
via un environnement qui capture stdout différemment.

**Test de connexion** :
```sql
SELECT Id, Name FROM Organization LIMIT 1
```

---

## 2. Objets Salesforce consommés

| Objet | Type | Usage |
|---|---|---|
| `Account` | Standard | Hiérarchie de comptes (siège / établissements) |
| `Compteur__c` | Custom | Caractéristiques techniques du point de livraison (PDL/PCE) |
| `LigneOffre__c` | Custom | Pré-remplissage contrat en cours + prix marché |
| `Offre__c` | Custom | Relation intermédiaire (Compteur ↔ LigneOffre) |
| `TURPE_CG__c` / `TURPE_CC__c` / `TURPE_CS__c` | Custom | Grilles tarifaires acheminement électricité |
| `ATRD_Fixe__mdt` | Custom Metadata | Abonnement fixe distribution gaz par segment |
| `Coeff_A__mdt` | Custom Metadata | Coefficient A transport gaz (GRT × GRD) |
| `Coeff_ZI__mdt` | Custom Metadata | Coefficient de zone climatique (profil × station météo) |
| `Client_Distribution__mdt` | Custom Metadata | Termes tarifaires transport (TCS/TCR/TCL) |

---

## 3. Requêtes SOQL par module

### 3.1 Compteurs d'un compte (`lib/compteurs.js`)

**Compteurs directement rattachés :**
```sql
SELECT <COMPTEUR_FIELDS> FROM Compteur__c
WHERE Compte__c = '<accountId>'
ORDER BY Name
```

**Détection de la hiérarchie** (comptes enfants) :
```sql
SELECT Id FROM Account WHERE ParentId = '<accountId>'
```

**Compteurs des établissements enfants** (si hiérarchie) :
```sql
SELECT <COMPTEUR_FIELDS> FROM Compteur__c
WHERE Compte__c IN (<childIds>)
ORDER BY Compte__r.Name, Name
```

**Repli** (aucun compteur direct ni enfant) via le compte siège :
```sql
SELECT <COMPTEUR_FIELDS> FROM Compteur__c
WHERE Compte_Siege__c = '<accountId>'
ORDER BY Name
```

> Les résultats sont **dédoublonnés par `Id`** (un compteur peut remonter par plusieurs chemins).

#### Champs compteur récupérés (`COMPTEUR_FIELDS`)
| Catégorie | Champs |
|---|---|
| Identité | `Id`, `Name`, `Energie__c`, `Segment__c`, `Segment_turpe__c`, `RecordType.DeveloperName` |
| Config technique | `TensionCompteur__c`, `ProfilCompteur__c`, `Type2Pointe__c`, `Code_Acheminement__c`, `Superieur36kVA__c`, `CARD__c`, `Autoproducteur__c`, `AutoproductionPart__c`, `ProprieteAOD__c` |
| Puissances (kVA) | `PuissanceSouscrite__c`, `PuissanceHCE__c`, `PuissanceHCH__c`, `PuissanceHPE__c`, `PuissanceHPH__c`, `PuissanceHC__c`, `PuissanceHP__c`, `PuissanceHPTE__c` |
| Volumes (MWh) | `VolumeTotalAnnuel__c`, `VolumeReference__c`, `VolumeEstime__c`, `VolumeBase__c`, `VolumeReel__c`, `VolumeHCE__c`, `VolumeHCH__c`, `VolumeHPE__c`, `VolumeHPH__c`, `VolumeHC__c`, `VolumeHP__c`, `VolumeHPTE__c` |
| Gaz | `ProfilCompteurGaz__c`, `EtatPDL__c` |
| Divers | `Fournisseur_Actuel_Nom__c` |
| Taxes locales (RefGeo) | `RefGeo__r.TaxeCom_TarifPro_Tranche1__c` / `Tranche2__c`, `RefGeo__r.TaxeDep_TarifPro_Tranche1__c` / `Tranche2__c` |
| Acheminement gaz (PITD) | `PITD__r.Nom_GRT__c`, `PITD__r.Nom_GRD__c`, `PITD__r.Code_GRD__c`, `PITD__r.Code_station_meteo__c`, `PITD__r.Niveau_Tarifaire_Regional_NTR__c` |
| APE/NAF (taxes) | `Compte__r.APE_NAF__r.CEE__c`, `.CSPE__c`, `.TICGN__c`, `.CPB__c`, `.Categorie__c` |

---

### 3.2 Pré-remplissage contrat en cours (`lib/prefill.js`)

**Lignes d'offre « actuelles » du compte :**
```sql
SELECT <PREFILL_FIELDS> FROM LigneOffre__c
WHERE Offre__r.Compteur__r.Compte__c = '<accountId>'
  AND TypeLigne__c IN ('Actuelle','Actuellement')
ORDER BY LastModifiedDate DESC
LIMIT 200
```
(+ variante `Compte__c IN (<childIds>)` pour la hiérarchie, + repli `Compte_Siege__c`.)

> 🔑 **Un seul enregistrement retenu par compteur** : le plus récent (`LastModifiedDate DESC`).
> Si un compteur a plusieurs lignes « Actuelle », les doublons sont ignorés silencieusement.

#### Champs pré-remplis (`PREFILL_FIELDS`)
| Usage | Champs |
|---|---|
| Type de tarif | `TypeTarifs__c` |
| Prix énergie | `PrixU__c`, `PrixHP__c`, `PrixHC__c`, `PrixHPH__c`, `PrixHCH__c`, `PrixHPE__c`, `PrixHCE__c`, `PrixHPTE__c` |
| Prix capacité | `PrixCAPA__c`, `PrixCapaHP__c`, `PrixCapaHC__c`, `PrixCapaHPH__c`, `PrixCapaHCH__c`, `PrixCapaHPE__c`, `PrixCapaHCE__c`, `PrixCapaHPTE__c` |
| Marge / options | `MargeGlobale__c`, `PrixAbo__c`, `EnergieVerte__c`, `CEE_user__c`, `CPB__c`, `TICGN__c`, `PrixPartVarDistri__c` |
| Inclusions | `TurpeInclus__c`, `CAPAInclus__c`, `CEEInclus__c`, `Acheminement_gaz__c` |
| Indicateurs | `Prix_Moyen_Pondere_Non_Marge__c`, `DureeMois__c` |
| Relations | `Offre__r.Compteur__c`, `Offre__r.Name` |

---

### 3.3 Prix marché (`lib/marketprice.js`)

**Une seule requête** récupère toutes les propositions récentes avec leur statut :
```sql
SELECT Offre__r.Compteur__r.RecordType.DeveloperName,
       Offre__r.Compteur__r.Segment__c,
       Offre__r.Categorie_APE_NAF__c,
       Fournisseur__r.Name,
       Statut__c,
       Prix_Moyen_Pondere_Non_Marge__c
FROM LigneOffre__c
WHERE TypeLigne__c = 'Proposition'
  AND CreatedDate = LAST_N_DAYS:30
  AND Prix_Moyen_Pondere_Non_Marge__c != null
  AND Prix_Moyen_Pondere_Non_Marge__c > 0
  AND Prix_Moyen_Pondere_Non_Marge__c < 150
```

Les résultats sont ensuite **séparés en 2 jeux côté serveur** :
- **Propositions** : toutes les lignes
- **Retenues (signées)** : uniquement `Statut__c = 'Retenue'`

Chaque jeu est agrégé par `énergie | segment | catégorie APE/NAF` (avec repli au niveau
`énergie | segment` si < 3 offres). On calcule **médiane + P25/P75** (pas de moyenne).

> 🔑 **`TypeLigne__c = 'Proposition'`** = offre proposée. **`Statut__c = 'Retenue'`** = offre
> réellement signée (échantillon plus faible). Le champ `Prix_Moyen_Pondere_Non_Marge__c` est
> **déjà pondéré par les volumes de postes** au niveau de chaque ligne ; on prend la médiane
> entre les lignes.

**Filtres de robustesse :**
- Plancher de plausibilité : élec ≥ 20 €/MWh, gaz ≥ 10 €/MWh
- Plafond : < 150 €/MWh
- Fournisseurs exclus : `lucia`, `volterres`, `elmy fourniture`, `fournisseur inconnu`,
  `electricite de france`, `soregies`, `selia`, `enercoop`, `gazelenergie solutions`

---

### 3.4 Données de référence (`lib/reference.js`) — chargées au démarrage

```sql
-- Acheminement électricité (TURPE)
SELECT Tension__c, CARD__c, AutoProducteur__c, BTSup36kVA__c, Tarif__c FROM TURPE_CG__c
SELECT Tension__c, Propri_t_AOD__c, BT36kVA__c, Tarif__c FROM TURPE_CC__c
SELECT coefficient__c, BTSup36kVA__c, Tension__c, Profil__c, Type_de_pointe__c,
       AutoProduction__c, Part_autoproduction__c, Tarif_HCB__c, Tarif_HCH__c, Tarif_HPB__c,
       Tarif_HPH__c, Tarif_PTE__c, Tarif_Base__c, Tarif_HC__c, Tarif_HP__c
FROM TURPE_CS__c

-- Acheminement gaz (ATRT / ATRD)
SELECT DeveloperName, T1__c, T2__c, T3__c, T4__c FROM ATRD_Fixe__mdt
SELECT GRT__c, Code_GRD__c, Valeur_Coeff_A__c FROM Coeff_A__mdt
SELECT Code_Station_Meteo__c, P011__c, P012__c, P013__c, P014__c, P015__c,
       P016__c, P017__c, P018__c, P019__c FROM Coeff_ZI__mdt
SELECT DeveloperName, TCS__c, TCR__c, TCL__c FROM Client_Distribution__mdt
```

> ⚠️ **FLS TURPE_CS** : les champs `Tarif_Base__c`, `Tarif_HC__c`, `Tarif_HP__c` peuvent être
> masqués par la sécurité au niveau champ (FLS) de l'utilisateur. Si la requête complète échoue,
> repli automatique sur un jeu de champs « cœur » (`turpeCSPartial = true`). Impact limité au
> TURPE variable des C5 Base/HP/HC.

---

## 4. Custom Labels (`labels.json`)

Snapshot local des Custom Labels Salesforce (taux figés, à rafraîchir si changement réglementaire).

| Label | Valeur | Usage |
|---|---|---|
| `TaxTauxCta` | 15 % | CTA = 15 % × (TURPE CC+CG+CS fixe) |
| `TaxTauxTvaNormale` | 20 % | TVA |
| `TaxTauxCspe` | 26,58 €/MWh | TICFE 36–249 kVA et > 249 |
| `TaxTauxCspeBelow36kva` | 30,85 €/MWh | TICFE ≤ 36 kVA |
| `TaxTauxTicgn` | 16,39 €/MWh | TICGN (gaz) |
| `TurpeCiTaux` | 0 | Composante TURPE CI |
| `TCK` | 398,08 | Coefficient stockage gaz |
| `PrixPartVarDistri_T1..T4` | 47,57 / 12,79 / 7,57 / 1,25 | Part variable distribution gaz par segment |
| `CtaGazBySegment` | T1=13,56 / T2=46,01 / T3=321,70 | CTA gaz (constante par segment) |

---

## 5. 🔑 Points DATA critiques

1. **Acheminement, taxes, TURPE, ATRD/ATRT ne dépendent PAS de la ligne d'offre.**
   Ils sont **réglementés** et calculés à partir du **compteur** + grilles de référence.
   → Le calcul fonctionne même sans aucune LigneOffre. Seule la **fourniture** (prix énergie,
   marge, abonnement, capacité) provient de la saisie / du pré-remplissage.

2. **Ces postes réglementés sont identiques des deux côtés** (actuel / estimé) car basés sur le
   compteur → ils **s'annulent dans l'écart**. Seule la fourniture différencie les deux budgets.

3. **CTA gaz** : ce n'est **pas** 20,8 % × ATRD. C'est une **constante par segment**
   (20,71 % × abonnement annuel ATRD GRDF) figée dans `labels.json`. T4 variable → saisie manuelle.

4. **Chaîne de relation compteur → prix** : `LigneOffre__c` → `Offre__r` → `Compteur__r`.
   Le prix marché passe par `Offre__r.Compteur__r.Segment__c` et `Offre__r.Categorie_APE_NAF__c`.

5. **`TypeLigne__c`** valeurs réelles : `Proposition`, `Actuelle`, `Actuellement`, `Concurrente`,
   `Prix moyen`. Le pré-remplissage utilise `IN ('Actuelle','Actuellement')`.

6. **`Statut__c`** (sur les Propositions) : `Sélectionné`, `Non-Sélectionné`, `Retenue`, `Nouveau`.
   Le « signé » = `Retenue` (il n'existe **pas** de `TypeLigne__c = 'Retenue'`).

7. **Volumes** : élec → `VolumeTotalAnnuel__c` ; gaz → `VolumeEstime__c` sinon `VolumeReference__c`.

8. **Hiérarchie de comptes** : un compte parent est détecté via `Account.ParentId`. Les compteurs
   des établissements enfants sont ajoutés automatiquement.

9. **Fidélité validée** : moteur JS validé au centime près vs Salesforce (élec C2/C4, gaz T1/T2/T3).

---

## 6. Schéma de flux DATA

```
   ID Compte (saisi)
        │
        ├──► Account.ParentId ──────────► compteurs des établissements enfants
        │
        ├──► Compteur__c (Compte__c) ───► caractéristiques techniques + PITD + RefGeo + APE/NAF
        │
        └──► LigneOffre__c (TypeLigne IN Actuelle/Actuellement)
                    │                     └─► pré-remplissage contrat en cours
                    └─► Offre__r.Compteur__r

   Au démarrage (cache mémoire) :
        TURPE_CG/CC/CS__c  +  ATRD_Fixe/Coeff_A/Coeff_ZI/Client_Distribution__mdt  +  labels.json
                    │
                    └─► grilles réglementées (acheminement + taxes)

   Prix marché (LAST_N_DAYS:30) :
        LigneOffre__c (TypeLigne='Proposition')  ─►  médiane par segment × catégorie
                    └─► split Propositions / Retenues (Statut__c='Retenue')
```

---

*Généré le 2026-07-07 — Simulateur Budgétaire v1.0. Rafraîchir si le schéma Salesforce évolue.*
