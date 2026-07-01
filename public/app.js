'use strict';
/* Capitole Énergie — Simulateur Budgétaire — logique frontend */

const state = {
  labels: {}, market: null, compteurs: [], byId: {}, selected: new Set(),
  inputs: {}, results: {}, timers: {}, prefill: {},
};

const eur = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const eur2 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
const num = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
const $ = (id) => document.getElementById(id);
const icon = (n) => `<span class="mi">${n}</span>`;
const energyIcon = (en) => en === 'elec' ? 'bolt' : 'local_fire_department';

/* ---------- Santé ---------- */
async function init() {
  try {
    const h = await fetch('/api/health').then(r => r.json());
    state.labels = h.labels || {};
    if (h.ok) {
      $('statusDot').className = 'dot ok';
      $('statusText').textContent = `${h.org ? h.org.Name : 'Org'} · ${h.orgAlias}`;
    } else {
      $('statusDot').className = 'dot ko';
      $('statusText').textContent = 'Org non connectée';
    }
  } catch (e) {
    $('statusDot').className = 'dot ko';
    $('statusText').textContent = 'Serveur injoignable';
  }
  try { state.market = await fetch('/api/marketprice').then(r => r.json()); } catch (_) { state.market = null; }
}

/* ---------- Suggestion prix marché (miroir de lib/marketprice.suggest) ---------- */
function marketSuggest(c) {
  const m = state.market;
  if (!m || !m.byKey) return { level: 'none' };
  const en = energieOf(c), seg = c.Segment__c, cat = c.categorie;
  if (!seg) return { level: 'none' };
  const exact = m.byKey[`${en}|${seg}|${cat || '—'}`];
  if (exact && exact.n >= 3) return { level: 'exact', seg, cat, ...exact };
  const s = m.bySeg[`${en}|${seg}`];
  if (s && s.n >= 1) return { level: 'segment', seg, cat, ...s };
  return { level: 'none' };
}

/* ---------- Modal Guide ---------- */
function openGuide() { $('guideOverlay').hidden = false; }
function closeGuide() { $('guideOverlay').hidden = true; }
$('guideBtn').addEventListener('click', openGuide);
$('guideClose').addEventListener('click', closeGuide);
$('guideOverlay').addEventListener('click', (e) => { if (e.target === $('guideOverlay')) closeGuide(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeGuide(); });
document.querySelectorAll('.mtab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.mtab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.mpanel').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  $('mpanel-' + t.dataset.mtab).classList.add('active');
}));

/* ---------- Compteur manuel ---------- */
$('manualBtn').addEventListener('click', openManual);
$('manualClose').addEventListener('click', closeManual);
$('manualCancel').addEventListener('click', closeManual);
$('manualOverlay').addEventListener('click', (e) => { if (e.target === $('manualOverlay')) closeManual(); });
$('manualAdd').addEventListener('click', addManualCompteur);

function openManual() {
  $('manualOverlay').hidden = false;
  ['mVolTotal','mVolHPH','mVolHCH','mVolHPE','mVolHCE','mVolHPTE','mVolHP','mVolHC','mVolBase',
   'mPuissance','mPuisHPH','mPuisHCH','mPuisHPE','mPuisHCE','mPuisHPTE','mNom','mNomGaz'].forEach(id => { if ($(id)) $(id).value = ''; });
  $('mEnergie').value = 'elec';
  updateManualForm();
}
function closeManual() { $('manualOverlay').hidden = true; }

$('mEnergie').addEventListener('change', updateManualForm);
$('mSegment').addEventListener('change', updateManualForm);

function updateManualForm() {
  const en = $('mEnergie').value;
  const seg = $('mSegment').value;
  const isElec = en === 'elec';
  $('mElecFields').style.display = isElec ? 'grid' : 'none';
  $('mGazFields').style.display = isElec ? 'none' : 'grid';

  const segSelect = $('mSegment');
  segSelect.innerHTML = '';
  if (isElec) {
    [['C5','C5 — BT ≤ 36 kVA'],['C4','C4 — BT > 36 kVA'],['C3','C3 — HTA'],['C2','C2 — HTA/HTB'],['C1','C1 — HTB']].forEach(([v,l]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = l; if (v === seg && isElec) o.selected = true; segSelect.appendChild(o);
    });
  } else {
    [['T1','T1 — < 300 MWh'],['T2','T2 — 300 à 5 000 MWh'],['T3','T3 — 5 000 à 50 000 MWh'],['T4','T4 — > 50 000 MWh']].forEach(([v,l]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = l; segSelect.appendChild(o);
    });
  }

  const segVal = segSelect.value;
  const isHT = ['C1','C2','C3'].includes(segVal);
  const isSup36 = isElec && (isHT || segVal === 'C4');
  $('mVolPosts').style.display = isElec ? 'block' : 'none';
  $('mPuisPosts').style.display = isSup36 ? 'block' : 'none';
}

let manualCounter = 0;
function addManualCompteur() {
  const en = $('mEnergie').value;
  const seg = $('mSegment').value;
  const isElec = en === 'elec';
  const isHT = ['C1','C2','C3'].includes(seg);
  const isSup36 = isElec && (isHT || seg === 'C4');
  const nom = isElec ? ($('mNom').value.trim() || `Manuel-${++manualCounter}`) : ($('mNomGaz').value.trim() || `Manuel-${++manualCounter}`);
  const volTotal = Number($('mVolTotal').value) || 0;

  if (!volTotal) { alert('Veuillez saisir le volume total annuel.'); return; }

  const c = {
    Id: '_manual_' + Date.now() + '_' + manualCounter,
    Name: nom,
    recordTypeDeveloperName: isElec ? 'Elec' : 'Gaz',
    Energie__c: isElec ? 'Électricité' : 'Gaz',
    Segment__c: seg,
    TensionCompteur__c: isElec ? (isHT ? 'Haute Tension' : 'Basse Tension') : null,
    ProfilCompteur__c: isElec ? (isHT ? (seg === 'C1' ? 'LU' : 'MU4') : (isSup36 ? 'BTSUPCU4' : 'BTINFCU4')) : null,
    Type2Pointe__c: null,
    Code_Acheminement__c: null,
    Superieur36kVA__c: isSup36,
    CARD__c: false,
    Autoproducteur__c: false,
    AutoproductionPart__c: null,
    ProprieteAOD__c: false,
    PuissanceSouscrite__c: isElec ? (Number($('mPuissance').value) || 0) : null,
    PuissanceHPH__c: isSup36 ? (Number($('mPuisHPH').value) || Number($('mPuissance').value) || 0) : null,
    PuissanceHCH__c: isSup36 ? (Number($('mPuisHCH').value) || Number($('mPuissance').value) || 0) : null,
    PuissanceHPE__c: isSup36 ? (Number($('mPuisHPE').value) || Number($('mPuissance').value) || 0) : null,
    PuissanceHCE__c: isSup36 ? (Number($('mPuisHCE').value) || Number($('mPuissance').value) || 0) : null,
    PuissanceHPTE__c: isHT ? (Number($('mPuisHPTE').value) || 0) : null,
    PuissanceHC__c: null, PuissanceHP__c: null,
    VolumeTotalAnnuel__c: isElec ? volTotal : null,
    VolumeReference__c: isElec ? null : volTotal,
    VolumeEstime__c: isElec ? null : volTotal,
    VolumeReel__c: isElec ? null : volTotal,
    VolumeBase__c: Number($('mVolBase').value) || 0,
    VolumeHPH__c: Number($('mVolHPH').value) || 0,
    VolumeHCH__c: Number($('mVolHCH').value) || 0,
    VolumeHPE__c: Number($('mVolHPE').value) || 0,
    VolumeHCE__c: Number($('mVolHCE').value) || 0,
    VolumeHPTE__c: Number($('mVolHPTE').value) || 0,
    VolumeHP__c: Number($('mVolHP').value) || 0,
    VolumeHC__c: Number($('mVolHC').value) || 0,
    ProfilCompteurGaz__c: isElec ? null : $('mProfilGaz').value,
    EtatPDL__c: null,
    Fournisseur_Actuel_Nom__c: null,
    compteNom: null,
    categorie: null,
    pitd: null,
    apenaf: { CEE__c: true, CSPE__c: isElec, TICGN__c: !isElec, CPB__c: !isElec },
    _manual: true,
  };

  state.compteurs.push(c);
  state.byId[c.Id] = c;
  state.selected.add(c.Id);

  $('compteursPanel').style.display = 'block';
  $('compteurCount').textContent = `· ${state.compteurs.length} compteur(s)`;
  $('compteurToolbar').style.display = 'flex';
  renderCompteurList();
  renderSimZone();
  closeManual();
}

/* ---------- Chargement compteurs ---------- */
$('loadBtn').addEventListener('click', loadCompteurs);
$('accountId').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadCompteurs(); });
$('selectAll').addEventListener('click', () => { state.compteurs.forEach(c => state.selected.add(c.Id)); renderCompteurList(); renderSimZone(); });
$('selectNone').addEventListener('click', () => { state.selected.clear(); renderCompteurList(); renderSimZone(); });

async function loadCompteurs() {
  const id = $('accountId').value.trim();
  $('loadError').innerHTML = '';
  if (!id) { $('loadError').innerHTML = `<div class="error-box">${icon('error')} Veuillez coller un identifiant de compte.</div>`; return; }
  $('loadBtn').disabled = true;
  $('loadBtn').innerHTML = '<span class="spinner"></span> Chargement…';
  try {
    const [data, pf] = await Promise.all([
      fetch(`/api/account/${encodeURIComponent(id)}/compteurs`).then(r => r.json()),
      fetch(`/api/account/${encodeURIComponent(id)}/prefill`).then(r => r.json()).catch(() => ({ byCompteur: {} })),
    ]);
    if (data.error) throw new Error(data.error);
    state.compteurs = data.compteurs;
    state.byId = {}; data.compteurs.forEach(c => state.byId[c.Id] = c);
    state.selected.clear(); state.results = {};
    state.prefill = pf.byCompteur || {};
    $('compteursPanel').style.display = 'block';
    $('compteurCount').textContent = `· ${data.count} compteur(s)`;
    $('compteurToolbar').style.display = data.count ? 'flex' : 'none';
    renderCompteurList();
    if (!data.count) $('compteurList').innerHTML = `<div class="empty">${icon('search_off')}Aucun compteur rattaché à ce compte.</div>`;
    renderSimZone();
  } catch (e) {
    $('loadError').innerHTML = `<div class="error-box">${icon('error')} ${e.message}</div>`;
  } finally {
    $('loadBtn').disabled = false;
    $('loadBtn').innerHTML = `${icon('search')} Charger les compteurs`;
  }
}

function energieOf(c) {
  const rt = (c.recordTypeDeveloperName || '').toLowerCase();
  if (rt === 'elec') return 'elec';
  if (rt === 'gaz') return 'gaz';
  return (c.Energie__c || '').toLowerCase().includes('gaz') ? 'gaz' : 'elec';
}
function volOf(c, en) { return en === 'elec' ? c.VolumeTotalAnnuel__c : (c.VolumeEstime__c ?? c.VolumeReference__c); }

function renderCompteurList() {
  const el = $('compteurList'); el.innerHTML = '';
  state.compteurs.forEach(c => {
    const en = energieOf(c); const vol = volOf(c, en);
    const item = document.createElement('label');
    item.className = 'compteur-item' + (state.selected.has(c.Id) ? ' sel' : '');
    item.innerHTML = `
      <input type="checkbox" ${state.selected.has(c.Id) ? 'checked' : ''} />
      <span class="energy-ic ${en}">${icon(energyIcon(en))}</span>
      <div class="compteur-meta">
        <div class="name">${c.Name || '(sans nom)'}</div>
        <div class="sub">${c._manual ? '<span class="manual-badge">Manuel</span> · ' : ''}${en === 'elec' ? 'Électricité' : 'Gaz'} · ${c.Segment__c || '—'}${c.TensionCompteur__c ? ' · ' + c.TensionCompteur__c : (c.ProfilCompteurGaz__c ? ' · ' + c.ProfilCompteurGaz__c : '')}${c.Fournisseur_Actuel_Nom__c ? ' · ' + c.Fournisseur_Actuel_Nom__c : ''}</div>
      </div>
      <span class="vol">${vol != null ? num.format(vol) + ' MWh/an' : '—'}</span>`;
    const cb = item.querySelector('input');
    cb.addEventListener('change', () => {
      if (cb.checked) state.selected.add(c.Id); else state.selected.delete(c.Id);
      item.classList.toggle('sel', cb.checked);
      renderSimZone();
    });
    el.appendChild(item);
  });
}

/* ---------- Définition des champs ---------- */
function defaultInputs(c) {
  const en = energieOf(c);
  const seg = (c.Segment__c || '').toUpperCase();
  const prixDistri = state.labels['PrixPartVarDistri_' + seg] ?? '';
  const base = { typeTarifs: 'Unique', margeGlobal: '', prixAbo: '', energieVerte: '', duree: '' };
  let actuel, estime, overrides = {}, prefillInfo = null;
  if (en === 'gaz') {
    const g = () => ({ ...base, prixU: '', prixPartVarDistri: prixDistri, ticgn: state.labels.TaxTauxTicgn ?? '', ceeUser: '', cpbUser: '' });
    actuel = g(); estime = g();
  } else {
    const e = () => ({ ...base, prixU: '', prixCAPA: '', ceeUser: '', prixHP: '', prixHC: '', prixHPH: '', prixHCH: '', prixHPE: '', prixHCE: '', prixHPTE: '', prixCapaHP: '', prixCapaHC: '', prixCapaHPH: '', prixCapaHCH: '', prixCapaHPE: '', prixCapaHCE: '', prixCapaHPTE: '' });
    actuel = e(); estime = e();
  }

  const pf = state.prefill[c.Id];
  if (pf && pf.inputs) {
    const inp = pf.inputs;
    actuel.typeTarifs = inp.typeTarifs || 'Unique';
    estime.typeTarifs = inp.typeTarifs || 'Unique';
    const numOrEmpty = (v) => (v != null && v !== 0) ? v : '';
    actuel.prixU = numOrEmpty(inp.prixU);
    actuel.prixHP = numOrEmpty(inp.prixHP); actuel.prixHC = numOrEmpty(inp.prixHC);
    actuel.prixHPH = numOrEmpty(inp.prixHPH); actuel.prixHCH = numOrEmpty(inp.prixHCH);
    actuel.prixHPE = numOrEmpty(inp.prixHPE); actuel.prixHCE = numOrEmpty(inp.prixHCE);
    actuel.prixHPTE = numOrEmpty(inp.prixHPTE);
    actuel.prixCAPA = numOrEmpty(inp.prixCAPA);
    actuel.prixCapaHP = numOrEmpty(inp.prixCapaHP); actuel.prixCapaHC = numOrEmpty(inp.prixCapaHC);
    actuel.prixCapaHPH = numOrEmpty(inp.prixCapaHPH); actuel.prixCapaHCH = numOrEmpty(inp.prixCapaHCH);
    actuel.prixCapaHPE = numOrEmpty(inp.prixCapaHPE); actuel.prixCapaHCE = numOrEmpty(inp.prixCapaHCE);
    actuel.prixCapaHPTE = numOrEmpty(inp.prixCapaHPTE);
    actuel.prixAbo = numOrEmpty(inp.prixAbo);
    actuel.energieVerte = numOrEmpty(inp.energieVerte);
    actuel.ceeUser = numOrEmpty(inp.ceeUser);
    if (en === 'gaz') {
      actuel.cpbUser = numOrEmpty(inp.cpbUser);
      actuel.ticgn = inp.ticgn != null ? inp.ticgn : (state.labels.TaxTauxTicgn ?? '');
      actuel.prixPartVarDistri = inp.prixPartVarDistri != null ? inp.prixPartVarDistri : prixDistri;
    }
    if (pf.acheminementGaz != null && pf.acheminementGaz !== 0) overrides.acheminementGaz = pf.acheminementGaz;
    prefillInfo = { ligneOffreName: pf.ligneOffreName, offreName: pf.offreName, ligneOffreId: pf.ligneOffreId };
  }

  return { actuel, estime, overrides, prefillInfo };
}

function fieldDefs(en, typeTarifs, which) {
  const f = [];
  // Pas de marge sur le contrat en cours : on ne connaît pas la marge du fournisseur/courtier
  // précédent. On saisit le prix tout compris de l'énergie actuelle.
  if (which !== 'actuel') f.push({ k: 'margeGlobal', l: 'Marge globale (€/MWh)', h: 'Marge ajoutée au prix de l\'énergie (Capitole + fournisseur). Uniquement sur l\'offre proposée.' });
  if (en === 'gaz') {
    f.push({ k: 'prixU', l: 'Prix fourniture (€/MWh)', h: 'Prix de l\'énergie gaz négocié.' });
    f.push({ k: 'prixPartVarDistri', l: 'Part var. distribution (€/MWh)', h: 'Composante distribution proportionnelle au volume (barème par segment).' });
    f.push({ k: 'ticgn', l: 'TICGN (€/MWh)', h: 'Taxe Intérieure de Consommation sur le Gaz Naturel.' });
    f.push({ k: 'ceeUser', l: 'CEE (€/MWh)', h: 'Certificats d\'Économies d\'Énergie (si éligible APE/NAF).' });
    f.push({ k: 'cpbUser', l: 'CPB (€/MWh)', h: 'Contribution au service public gaz (si éligible).' });
    f.push({ k: 'prixAbo', l: 'Abonnement (€/mois)', h: 'Part fixe mensuelle, annualisée × 12.' });
    f.push({ k: 'energieVerte', l: 'Énergie verte (€/MWh)', h: 'Surcoût optionnel origine renouvelable.' });
    f.push({ k: 'duree', l: 'Durée du contrat (mois)', h: 'Durée du contrat en mois (ex : 12, 24, 36). Informatif — n\'affecte pas le calcul annuel.' });
    return f;
  }
  if (typeTarifs === 'Unique') {
    f.push({ k: 'prixU', l: 'Prix énergie (€/MWh)', h: 'Prix unique de l\'énergie.' });
    f.push({ k: 'prixCAPA', l: 'Capacité (€/MWh)', h: 'Coût du mécanisme de capacité.' });
  } else if (typeTarifs === 'Horosaisonnalisé') {
    f.push({ k: 'prixHPH', l: 'Prix HPH (€/MWh)', h: 'Heures pleines hiver.' }, { k: 'prixHCH', l: 'Prix HCH (€/MWh)', h: 'Heures creuses hiver.' });
    f.push({ k: 'prixHPE', l: 'Prix HPE (€/MWh)', h: 'Heures pleines été.' }, { k: 'prixHCE', l: 'Prix HCE (€/MWh)', h: 'Heures creuses été.' });
    f.push({ k: 'prixHPTE', l: 'Prix Pointe (€/MWh)', h: 'Heures de pointe.' });
    f.push({ k: 'prixCapaHPH', l: 'Capa HPH' }, { k: 'prixCapaHCH', l: 'Capa HCH' });
    f.push({ k: 'prixCapaHPE', l: 'Capa HPE' }, { k: 'prixCapaHCE', l: 'Capa HCE' });
    f.push({ k: 'prixCapaHPTE', l: 'Capa Pointe' });
  } else {
    f.push({ k: 'prixHP', l: 'Prix HP (€/MWh)', h: 'Heures pleines.' }, { k: 'prixHC', l: 'Prix HC (€/MWh)', h: 'Heures creuses.' });
    f.push({ k: 'prixCapaHP', l: 'Capa HP' }, { k: 'prixCapaHC', l: 'Capa HC' });
  }
  f.push({ k: 'ceeUser', l: 'CEE (€/MWh)', h: 'Certificats d\'Économies d\'Énergie (si éligible APE/NAF).' });
  f.push({ k: 'prixAbo', l: 'Abonnement (€/mois)', h: 'Part fixe mensuelle, annualisée × 12.' });
  f.push({ k: 'energieVerte', l: 'Énergie verte (€/MWh)', h: 'Surcoût optionnel origine renouvelable.' });
  f.push({ k: 'duree', l: 'Durée du contrat (mois)', h: 'Durée du contrat en mois (ex : 12, 24, 36). Informatif — n\'affecte pas le calcul annuel.' });
  return f;
}

/* ---------- Zone simulation ---------- */
function renderSimZone() {
  const zone = $('simZone'); zone.innerHTML = '';
  const sel = state.compteurs.filter(c => state.selected.has(c.Id));
  if (!sel.length) { $('summaryBar').style.display = 'none'; return; }
  sel.forEach(c => {
    if (!state.inputs[c.Id]) state.inputs[c.Id] = defaultInputs(c);
    zone.appendChild(buildSimCard(c));
  });
  $('summaryBar').style.display = 'block';
  sel.forEach(c => computeOne(c.Id));
}

function buildSimCard(c) {
  const en = energieOf(c); const inp = state.inputs[c.Id];
  const card = document.createElement('section'); card.className = 'sim-card'; card.id = 'card-' + c.Id;
  const vol = volOf(c, en);
  const typeSelector = en === 'elec' ? `
    <div class="type-select field">
      <label>Type de tarif (s'applique aux deux colonnes)</label>
      <select class="input" data-type-selector>
        <option value="Unique" ${inp.actuel.typeTarifs === 'Unique' ? 'selected' : ''}>Unique (Base)</option>
        <option value="Horosaisonnalisé" ${inp.actuel.typeTarifs === 'Horosaisonnalisé' ? 'selected' : ''}>Horosaisonnalisé (HPH/HCH/HPE/HCE/Pointe)</option>
        <option value="Horosaisonnalisé Heures Pleines/Heures Creuses" ${inp.actuel.typeTarifs.startsWith('Horosaisonnalisé Heures') ? 'selected' : ''}>Horosaisonnalisé HP/HC</option>
      </select>
    </div>` : '';

  card.innerHTML = `
    <div class="sim-head">
      <span class="energy-ic ${en}">${icon(energyIcon(en))}</span>
      <div style="flex:1">
        <div class="name">${c.Name || '(sans nom)'}</div>
        <div class="sub">${c._manual ? '<span class="manual-badge">Manuel</span> · ' : ''}${en === 'elec' ? 'Électricité' : 'Gaz'} · ${c.Segment__c || '—'} · ${vol != null ? num.format(vol) + ' MWh/an' : 'volume inconnu'}${c.Fournisseur_Actuel_Nom__c ? ' · fournisseur actuel : ' + c.Fournisseur_Actuel_Nom__c : ''}</div>
      </div>
    </div>
    <div class="sim-body">
      ${inp.prefillInfo ? `<div class="prefill-banner">${icon('auto_awesome')} <span>Contrat en cours pré-rempli depuis la ligne d'offre <b>${inp.prefillInfo.ligneOffreName}</b> (offre ${inp.prefillInfo.offreName})</span></div>` : ''}
      ${typeSelector}
      <div data-market></div>
      <div class="cols">
        <div class="col actuel"><h3><span class="tag a">ACTUEL</span> Contrat en cours</h3><div data-col="actuel"></div></div>
        <div class="col estime"><h3><span class="tag e">ESTIMÉ</span> Offre proposée</h3><div data-col="estime"></div></div>
      </div>
      ${en === 'gaz' ? `<div class="section-label">Acheminement &amp; CTA gaz — identiques actuel/estimé (réglementés), pré-remplis et ajustables</div>
      <div class="field-row" style="max-width:480px">
        <div class="field"><label>Acheminement gaz (€/an) <span class="help mi" title="Calculé automatiquement via le PITD si disponible, sinon à saisir.">help</span> <span data-achem-src style="color:var(--text-mut)"></span></label><input type="number" step="any" class="input" data-achem placeholder="auto (PITD)" /></div>
        <div class="field"><label>CTA gaz (€/an) <span class="help mi" title="Contribution Tarifaire d'Acheminement. Constant par segment T1/T2/T3 ; à saisir pour T4.">help</span> <span data-cta-src style="color:var(--text-mut)"></span></label><input type="number" step="any" class="input" data-cta placeholder="barème segment" /></div>
      </div>` : ''}
      <div class="result" data-result></div>
    </div>`;

  const ts = card.querySelector('[data-type-selector]');
  if (ts) ts.addEventListener('change', () => {
    inp.actuel.typeTarifs = ts.value; inp.estime.typeTarifs = ts.value;
    renderColumns(card, c); computeOne(c.Id);
  });
  const achemEl = card.querySelector('[data-achem]');
  if (achemEl) {
    if (inp.overrides.acheminementGaz != null) achemEl.value = inp.overrides.acheminementGaz;
    achemEl.addEventListener('input', () => { inp.overrides.acheminementGaz = achemEl.value === '' ? undefined : Number(achemEl.value); scheduleCompute(c.Id); });
  }
  const ctaEl = card.querySelector('[data-cta]');
  if (ctaEl) ctaEl.addEventListener('input', () => { inp.overrides.ctaGaz = ctaEl.value === '' ? undefined : Number(ctaEl.value); scheduleCompute(c.Id); });

  renderMarket(card, c);
  renderColumns(card, c);
  return card;
}

function renderMarket(card, c) {
  const host = card.querySelector('[data-market]'); if (!host) return;
  const s = marketSuggest(c);
  if (s.level === 'none') {
    host.className = 'market none';
    host.innerHTML = `${icon('info')}<span class="txt">Aucune référence marché récente pour ce profil (${energieOf(c) === 'elec' ? 'élec' : 'gaz'} ${c.Segment__c || '?'} / ${c.categorie || 'catégorie inconnue'}).</span>`;
    return;
  }
  const lvlTxt = s.level === 'exact' ? `${c.Segment__c} · ${s.cat || '—'}` : `segment ${c.Segment__c} (toutes catégories)`;
  const days = (state.market.meta && state.market.meta.days) || 30;
  host.className = 'market';
  host.innerHTML = `
    ${icon('lightbulb')}
    <div class="txt">
      Prix marché de fourniture <b>${eur2.format(s.median)}/MWh</b> <span class="lvl ${s.level === 'segment' ? 'seg' : ''}">${s.level === 'segment' ? 'segment' : 'profil'}</span>
      <div class="sub">${lvlTxt} · fourchette ${num.format(s.p25)}–${num.format(s.p75)} €/MWh · ${s.n} offre(s) sur ${days} j · hors marge (ajoutez la vôtre)</div>
    </div>
    <button class="btn btn-secondary btn-sm" data-apply-market>${icon('auto_fix_high')} Appliquer à l'estimé</button>`;
  host.querySelector('[data-apply-market]').addEventListener('click', () => {
    const inp = state.inputs[c.Id];
    inp.actuel.typeTarifs = 'Unique';
    inp.estime.typeTarifs = 'Unique';
    inp.estime.prixU = s.median;
    const ts = card.querySelector('[data-type-selector]');
    if (ts) ts.value = 'Unique';
    renderColumns(card, c);
    computeOne(c.Id);
  });
}

function renderColumns(card, c) {
  const en = energieOf(c); const inp = state.inputs[c.Id];
  ['actuel', 'estime'].forEach(which => {
    const host = card.querySelector(`[data-col="${which}"]`); host.innerHTML = '';
    fieldDefs(en, inp[which].typeTarifs, which).forEach(d => {
      const wrap = document.createElement('div'); wrap.className = 'field';
      const val = inp[which][d.k] ?? '';
      const help = d.h ? ` <span class="help mi" title="${d.h.replace(/"/g, '&quot;')}">help</span>` : '';
      wrap.innerHTML = `<label>${d.l}${help}</label><input type="number" step="any" class="input" data-k="${d.k}" value="${val}" />`;
      const input = wrap.querySelector('input');
      input.addEventListener('input', () => { inp[which][d.k] = input.value === '' ? '' : Number(input.value); scheduleCompute(c.Id); });
      host.appendChild(wrap);
    });
  });
}

/* ---------- Calcul ---------- */
function scheduleCompute(id) { clearTimeout(state.timers[id]); state.timers[id] = setTimeout(() => computeOne(id), 300); }
function toNumbers(o) {
  const r = {};
  for (const k of Object.keys(o)) r[k] = (o[k] === '' || o[k] == null) ? null : (typeof o[k] === 'string' && isNaN(Number(o[k])) ? o[k] : Number(o[k]));
  r.typeTarifs = o.typeTarifs; return r;
}
async function computeOne(id) {
  const c = state.byId[id]; const inp = state.inputs[id];
  try {
    const res = await fetch('/api/compute', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ compteur: c, actuel: toNumbers(inp.actuel), estime: toNumbers(inp.estime), overrides: inp.overrides }),
    }).then(r => r.json());
    if (res.error) throw new Error(res.error);
    state.results[id] = res; renderResult(id, res); renderSummary();
  } catch (e) {
    const card = $('card-' + id);
    if (card) card.querySelector('[data-result]').innerHTML = `<div class="error-box">${icon('error')} ${e.message}</div>`;
  }
}

function renderResult(id, r) {
  const card = $('card-' + id); if (!card) return;
  const host = card.querySelector('[data-result]');
  const dir = r.difference > 0 ? 'rise' : (r.difference < 0 ? 'save' : 'flat');
  const arrow = r.difference > 0 ? 'trending_up' : (r.difference < 0 ? 'trending_down' : 'trending_flat');
  const sign = r.difference > 0 ? '+' : '';
  const word = r.difference < 0 ? 'Économie estimée' : (r.difference > 0 ? 'Surcoût estimé' : 'Budget identique');

  // Pré-remplissage gaz
  if (r.energie === 'Gaz') {
    const achemEl = card.querySelector('[data-achem]'), ctaEl = card.querySelector('[data-cta]');
    const achemSrc = card.querySelector('[data-achem-src]'), ctaSrc = card.querySelector('[data-cta-src]');
    if (achemEl && achemEl.value === '' && r.acheminementGazUsed != null) achemEl.placeholder = num.format(r.acheminementGazUsed);
    if (ctaEl && ctaEl.value === '' && r.ctaGazUsed != null) ctaEl.placeholder = num.format(r.ctaGazUsed);
    if (achemSrc) achemSrc.textContent = r.acheminementGazAuto != null ? '· auto' : '· à saisir';
    if (ctaSrc) ctaSrc.textContent = r.ctaGazAuto != null ? `· barème ${r.segment}` : `· ${r.segment} à saisir`;
  }

  const flags = r.flags;
  const flagPills = [['CEE', flags.computeCEE], ['CPB', flags.computeCPB], ['TICGN', flags.computeTICGN], ['CSPE', flags.computeCSPE]]
    .map(([n, on]) => `<span class="flag-pill ${on ? 'on' : ''}">${n} ${on ? '✓' : '✗'}</span>`).join(' ');

  const turpeNote = r.energie === 'Électricité' && !r.turpeLoaded
    ? `<div class="note warn">${icon('warning')}<span>Grille TURPE introuvable pour ce compteur — acheminement élec non chiffré.</span></div>`
    : (r.turpeIncomplete ? `<div class="note warn">${icon('warning')}<span>TURPE partiel (compteur C5 Base/HP-HC, barèmes non lisibles — droits FLS). Le budget absolu peut être sous-estimé, mais l'écart actuel/estimé reste exact.</span></div>` : '');
  const achemNote = r.energie === 'Gaz'
    ? `<div class="note">${icon('hub')}<span>Acheminement : ${eur2.format(r.acheminementGazUsed)}/an · CTA gaz : ${eur2.format(r.ctaGazUsed)}/an (réglementés, identiques des 2 côtés)</span></div>` : '';
  const volNote = (!r.volume || r.volume === 0)
    ? `<div class="note warn">${icon('warning')}<span>Volume de consommation non renseigné sur ce compteur — le budget ne peut pas être chiffré. Vérifiez les données de consommation dans Salesforce.</span></div>` : '';

  host.innerHTML = `
    <div class="result-hero ${dir}">
      <div><div class="lbl">${word} (€/an)</div><div class="big ${dir}">${sign}${eur.format(r.difference)}</div></div>
      <div class="arrow">${icon(arrow)}</div>
      <div><div class="lbl">soit</div><div class="pct ${dir === 'save' ? '' : ''}" style="color:var(--${dir === 'flat' ? 'text-dim' : dir})">${sign}${num.format(r.differencePct)} %</div></div>
    </div>
    <div class="metrics">
      <div class="metric"><div class="k">Budget actuel HTVA</div><div class="v">${eur.format(r.budgetActuel)}</div><div class="vsub">${eur2.format(r.prixMoyenActuel)}/MWh</div></div>
      <div class="metric"><div class="k">Budget estimé HTVA</div><div class="v">${eur.format(r.budgetEstime)}</div><div class="vsub">${eur2.format(r.prixMoyenEstime)}/MWh</div></div>
      <div class="metric"><div class="k">Volume</div><div class="v">${num.format(r.volume)}</div><div class="vsub">MWh / an</div></div>
    </div>
    ${volNote}
    <div class="note">${icon('account_balance')}<span>Taxes applicables (selon APE/NAF) : ${flagPills}</span></div>
    ${turpeNote}${achemNote}
    <details class="breakdown">
      <summary>${icon('expand_more')} Détail du calcul (€/an)</summary>
      ${breakdownTable(r)}
    </details>`;
}

function breakdownTable(r) {
  const rows = [
    ['Fourniture (énergie)', 'calculTarif'], ['Capacité', 'calculCapacite'],
    ['CEE', 'calculCEE'], ['CPB', 'calculCPB'], ['Part var. distribution', 'calculPartVarDistri'],
    ['Énergie verte', 'calculEnergieVerte'], ['= Énergie totale', 'calculEnergie'],
    ['Abonnement (× 12)', 'calculAboAnnuel'], ['Acheminement TURPE (élec)', 'calculTurpe'],
    ['Acheminement gaz', 'acheminementGaz'], ['CTA', 'calculCTA'],
    ['TICFE', 'calculCSPE'], ['TICGN', 'calculTICGN'], ['= Taxes hors TVA', 'calculTaxesHorsTVA'],
    ['BUDGET HTVA', 'calculTarifHorsTVA'], ['TVA (20 %)', 'calculTVA'], ['BUDGET TTC', 'calculTTC'],
  ];
  const cell = (x) => x == null ? '—' : eur2.format(x);
  const strongKeys = ['calculEnergie', 'calculTaxesHorsTVA', 'calculTarifHorsTVA', 'calculTTC'];
  const body = rows.map(([label, k]) => {
    const a = r.actuel[k], e = r.estime[k];
    if ((a === 0 || a == null) && (e === 0 || e == null) && !strongKeys.includes(k)) return '';
    return `<tr class="${strongKeys.includes(k) ? 'strong' : ''}"><td>${label}</td><td class="num">${cell(a)}</td><td class="num">${cell(e)}</td></tr>`;
  }).join('');
  return `<table class="bd-table"><thead><tr><th>Poste</th><th class="num">Actuel</th><th class="num">Estimé</th></tr></thead><tbody>${body}</tbody></table>`;
}

/* ---------- Synthèse ---------- */
function renderSummary() {
  const ids = [...state.selected].filter(id => state.results[id]);
  let a = 0, e = 0;
  ids.forEach(id => { a += state.results[id].budgetActuel; e += state.results[id].budgetEstime; });
  const diff = e - a; const pct = a === 0 ? 0 : (diff / a) * 100;
  const dir = diff > 0 ? 'rise' : (diff < 0 ? 'save' : '');
  const sign = diff > 0 ? '+' : '';
  $('sumActuel').textContent = eur.format(a);
  $('sumEstime').textContent = eur.format(e);
  $('sumDiff').textContent = sign + eur.format(diff); $('sumDiff').className = 'v ' + dir;
  $('sumDiffPct').textContent = ids.length ? `${sign}${num.format(pct)} % · ${ids.length} compteur(s)` : '';
}

/* ---------- Export PDF ---------- */
let logoDataURL = '';
(function preloadLogo() {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    logoDataURL = c.toDataURL('image/png');
  };
  img.src = 'assets/logo-full.png';
})();

$('exportBtn').addEventListener('click', exportPDF);

function exportPDF() {
  const ids = [...state.selected].filter(id => state.results[id]);
  if (!ids.length) return alert('Aucun résultat à exporter. Lancez une simulation d\'abord.');

  const today = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  const firstC = state.byId[ids[0]];
  const clientName = firstC ? (firstC.compteNom || '—') : '—';

  let totalA = 0, totalE = 0;
  ids.forEach(id => { totalA += state.results[id].budgetActuel; totalE += state.results[id].budgetEstime; });
  const totalDiff = totalE - totalA;
  const totalPct = totalA === 0 ? 0 : (totalDiff / totalA) * 100;

  const compteurBlocks = ids.map(id => {
    const c = state.byId[id]; const r = state.results[id]; const inp = state.inputs[id];
    const en = energieOf(c); const vol = volOf(c, en);
    const dir = r.difference > 0 ? 'rise' : (r.difference < 0 ? 'save' : 'flat');
    const sign = r.difference > 0 ? '+' : '';

    const rows = [
      ['Fourniture (énergie)', 'calculTarif'], ['Capacité', 'calculCapacite'],
      ['CEE', 'calculCEE'], ['CPB', 'calculCPB'], ['Part var. distribution', 'calculPartVarDistri'],
      ['Énergie verte', 'calculEnergieVerte'], ['Énergie totale', 'calculEnergie'],
      ['Abonnement (× 12)', 'calculAboAnnuel'], ['Acheminement TURPE', 'calculTurpe'],
      ['Acheminement gaz', 'acheminementGaz'], ['CTA', 'calculCTA'],
      ['TICFE', 'calculCSPE'], ['TICGN', 'calculTICGN'], ['Taxes hors TVA', 'calculTaxesHorsTVA'],
      ['BUDGET HTVA', 'calculTarifHorsTVA'], ['TVA (20 %)', 'calculTVA'], ['BUDGET TTC', 'calculTTC'],
    ];
    const strongKeys = new Set(['calculEnergie', 'calculTaxesHorsTVA', 'calculTarifHorsTVA', 'calculTTC']);
    const tableRows = rows.map(([label, k]) => {
      const a = r.actuel[k], e = r.estime[k];
      if ((a === 0 || a == null) && (e === 0 || e == null) && !strongKeys.has(k)) return '';
      const cls = strongKeys.has(k) ? ' class="strong"' : '';
      const diffVal = (e || 0) - (a || 0);
      const diffCell = strongKeys.has(k) ? `<td class="num ${diffVal < 0 ? 'save' : (diffVal > 0 ? 'rise' : '')}">${diffVal > 0 ? '+' : ''}${fmtEur2(diffVal)}</td>` : '<td></td>';
      return `<tr${cls}><td>${label}</td><td class="num">${fmtEur2(a)}</td><td class="num">${fmtEur2(e)}</td>${diffCell}</tr>`;
    }).filter(Boolean).join('');

    return `
      <div class="compteur-block ${en}">
        <div class="compteur-header">
          <div class="energy-badge ${en}">${en === 'elec' ? 'ÉLEC' : 'GAZ'}</div>
          <div class="compteur-info">
            <div class="compteur-name">${c.Name || '—'}</div>
            <div class="compteur-detail">${r.energie} · ${c.Segment__c || '—'}${c.TensionCompteur__c ? ' · ' + c.TensionCompteur__c : ''}${c.ProfilCompteur__c ? ' · ' + c.ProfilCompteur__c : (c.ProfilCompteurGaz__c ? ' · ' + c.ProfilCompteurGaz__c : '')} · ${vol != null ? fmtNum(vol) + ' MWh/an' : 'volume N/C'}${c.Fournisseur_Actuel_Nom__c ? ' · Fournisseur actuel : ' + c.Fournisseur_Actuel_Nom__c : ''}${inp.actuel.duree ? ' · Durée actuel : ' + inp.actuel.duree + ' mois' : ''}${inp.estime.duree ? ' · Durée estimé : ' + inp.estime.duree + ' mois' : ''}</div>
            ${inp.prefillInfo ? `<div class="compteur-detail" style="font-style:italic;margin-top:2px">Contrat en cours pré-rempli depuis ${inp.prefillInfo.ligneOffreName} (${inp.prefillInfo.offreName})</div>` : ''}
          </div>
        </div>
        <div class="ecart-box ${dir}">
          <div class="ecart-label">${r.difference < 0 ? 'Économie estimée' : (r.difference > 0 ? 'Surcoût estimé' : 'Budget identique')}</div>
          <div class="ecart-value">${sign}${fmtEur(r.difference)} /an</div>
          <div class="ecart-pct">soit ${sign}${fmtNum(r.differencePct)} %</div>
        </div>
        <table class="detail-table">
          <thead><tr><th>Poste</th><th class="num">Actuel</th><th class="num">Estimé</th><th class="num">Écart</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>`;
  }).join('');

  const diffDir = totalDiff > 0 ? 'rise' : (totalDiff < 0 ? 'save' : 'flat');
  const totalSign = totalDiff > 0 ? '+' : '';

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <title>Simulation Budgétaire — ${clientName} — ${today}</title>
  <style>
    @page { size: A4; margin: 18mm 15mm 20mm 15mm; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; font-size: 11px; color: #232323; line-height: 1.45; }
    .page-header { display: flex; align-items: center; gap: 16px; padding-bottom: 12px; border-bottom: 3px solid transparent; border-image: linear-gradient(90deg, #0C32FF 0%, #E543DC 55%, #FFC14F 100%) 1; margin-bottom: 20px; }
    .page-header img { height: 42px; }
    .page-header .title-block { flex: 1; }
    .page-header h1 { font-size: 18px; font-weight: 700; color: #5020EA; letter-spacing: -.3px; }
    .page-header .subtitle { font-size: 10px; color: #6E6E80; margin-top: 2px; }
    .page-header .date { font-size: 10px; color: #6E6E80; text-align: right; white-space: nowrap; }

    .client-card { background: #F3F3F3; border: 1px solid #E3E3E3; border-radius: 8px; padding: 14px 16px; margin-bottom: 18px; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px 20px; }
    .client-card .label { font-size: 9px; text-transform: uppercase; letter-spacing: .4px; color: #6E6E80; }
    .client-card .value { font-size: 12px; font-weight: 600; }

    .synthese { background: linear-gradient(135deg, #5020EA 0%, #0C32FF 100%); color: #fff; border-radius: 8px; padding: 16px 20px; margin-bottom: 20px; display: grid; grid-template-columns: 1fr 1fr 1fr 1.3fr; gap: 12px; align-items: center; }
    .synthese .s-label { font-size: 9px; text-transform: uppercase; letter-spacing: .4px; opacity: .8; }
    .synthese .s-value { font-size: 18px; font-weight: 700; }
    .synthese .s-value.sm { font-size: 14px; }
    .synthese .ecart-col { text-align: right; }
    .synthese .ecart-col .s-value { font-size: 22px; }
    .synthese .s-pct { font-size: 11px; opacity: .85; }

    .compteur-block { page-break-inside: avoid; margin-bottom: 16px; border: 1px solid #E3E3E3; border-radius: 8px; overflow: hidden; }
    .compteur-header { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: #FAFAFC; border-bottom: 1px solid #E3E3E3; }
    .energy-badge { font-size: 9px; font-weight: 700; letter-spacing: .5px; padding: 4px 10px; border-radius: 5px; }
    .energy-badge.elec { background: #E7ECFF; color: #0C32FF; }
    .energy-badge.gaz { background: #FFF1DA; color: #C77A12; }
    .compteur-name { font-size: 12px; font-weight: 700; font-family: 'Consolas', 'Courier New', monospace; }
    .compteur-detail { font-size: 9.5px; color: #6E6E80; margin-top: 1px; }

    .ecart-box { padding: 10px 14px; display: flex; align-items: center; gap: 14px; }
    .ecart-box.save { background: #E6F8EF; }
    .ecart-box.rise { background: #FDECF1; }
    .ecart-box.flat { background: #F3F3F3; }
    .ecart-label { font-size: 10px; color: #6E6E80; }
    .ecart-value { font-size: 16px; font-weight: 700; }
    .ecart-box.save .ecart-value { color: #12875A; }
    .ecart-box.rise .ecart-value { color: #D11F4A; }
    .ecart-pct { font-size: 11px; color: #6E6E80; }

    .detail-table { width: 100%; border-collapse: collapse; font-size: 10px; }
    .detail-table th, .detail-table td { padding: 5px 10px; border-bottom: 1px solid #EDEDF2; text-align: left; }
    .detail-table th { font-size: 8.5px; text-transform: uppercase; letter-spacing: .3px; color: #9A9AAC; font-weight: 600; background: #FAFAFC; }
    .detail-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
    .detail-table tr.strong td { font-weight: 700; background: #F6F5FF; }
    .detail-table td.save { color: #12875A; }
    .detail-table td.rise { color: #D11F4A; }

    .footer { margin-top: 24px; padding-top: 10px; border-top: 2px solid transparent; border-image: linear-gradient(90deg, #0C32FF 0%, #E543DC 55%, #FFC14F 100%) 1; display: flex; justify-content: space-between; align-items: center; }
    .footer .left { font-size: 9px; color: #9A9AAC; }
    .footer .right { font-size: 9px; color: #9A9AAC; }
    .footer .brand { font-weight: 700; color: #5020EA; }

    .mention { font-size: 8.5px; color: #9A9AAC; margin-top: 8px; font-style: italic; }

    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  </style>
</head>
<body>
  <div class="page-header">
    ${logoDataURL ? `<img src="${logoDataURL}" alt="Capitole Énergie" />` : '<div style="font-weight:700;color:#5020EA;font-size:16px">Capitole Énergie</div>'}
    <div class="title-block">
      <h1>Simulation Budgétaire Énergie</h1>
      <div class="subtitle">Comparatif budget actuel vs offre proposée</div>
    </div>
    <div class="date">Émis le ${today}</div>
  </div>

  <div class="client-card">
    <div><div class="label">Client</div><div class="value">${esc(clientName)}</div></div>
    <div><div class="label">Compteurs simulés</div><div class="value">${ids.length}</div></div>
    <div><div class="label">Date de simulation</div><div class="value">${today}</div></div>
    ${ids.map(id => {
      const c = state.byId[id]; const en = energieOf(c); const vol = volOf(c, en);
      return `<div><div class="label">N° compteur (${en === 'elec' ? 'élec' : 'gaz'})</div><div class="value">${esc(c.Name || '—')}</div></div>
      <div><div class="label">Segment</div><div class="value">${esc(c.Segment__c || '—')}</div></div>
      <div><div class="label">Fournisseur actuel</div><div class="value">${esc(c.Fournisseur_Actuel_Nom__c || '—')}</div></div>`;
    }).join('')}
  </div>

  ${ids.length > 1 ? `
  <div class="synthese">
    <div><div class="s-label">Budget actuel total</div><div class="s-value sm">${fmtEur(totalA)}</div></div>
    <div><div class="s-label">Budget estimé total</div><div class="s-value sm">${fmtEur(totalE)}</div></div>
    <div></div>
    <div class="ecart-col">
      <div class="s-label">Écart annuel</div>
      <div class="s-value">${totalSign}${fmtEur(totalDiff)}</div>
      <div class="s-pct">soit ${totalSign}${fmtNum(totalPct)} %</div>
    </div>
  </div>` : ''}

  ${compteurBlocks}

  <div class="mention">Les montants sont exprimés en euros hors TVA. L'acheminement et les taxes sont réglementés et identiques quel que soit le fournisseur — seule la fourniture et l'abonnement font l'objet de la négociation. Les prix marché sont indicatifs (médiane des offres récentes).</div>

  <div class="footer">
    <div class="left"><span class="brand">Capitole Énergie</span> — Courtier en énergie</div>
    <div class="right">Document généré le ${today} — Simulateur Budgétaire v1.0</div>
  </div>
</body>
</html>`;

  const w = window.open('', '_blank');
  if (!w) { alert('Popup bloquée. Autorisez les popups pour ce site.'); return; }
  w.document.write(html);
  w.document.close();
  setTimeout(() => w.print(), 400);
}

function fmtEur(v) { return eur.format(v || 0); }
function fmtEur2(v) { return v == null ? '—' : eur2.format(v); }
function fmtNum(v) { return num.format(v || 0); }
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

init();
