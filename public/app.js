'use strict';
/* Capitole Énergie — Simulateur Budgétaire — logique frontend */

const state = {
  labels: {}, market: null, marketMode: 'proposition', marketPeriod: null,
  compteurs: [], byId: {}, selected: new Set(),
  inputs: {}, results: {}, timers: {}, prefill: {}, meta: {},
  filterEnergie: '', filterSegment: '', filterCompte: '',
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

/* ---------- Suggestion prix marché & CEE (agrégation côté client) ---------- */
function _med(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function _pctl(a, p) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1)))); return s[i]; }
function _r2(x) { return x == null ? null : Math.round(x * 100) / 100; }

// Chevauchement entre la période de livraison de l'offre [dd, df] et la sélection.
// Si des années précises sont sélectionnées, l'offre doit chevaucher AU MOINS une de ces
// années (gère les sélections non contiguës, ex : 2026 + 2030).
function _periodOverlap(r, period) {
  if (!period || (!period.start && !period.end)) return true;
  if (period.years && period.years.length) {
    return period.years.some(y => {
      const yStart = `${y}-01-01`, yEnd = `${y}-12-31`;
      if (r.df && r.df < yStart) return false;
      if (r.dd && r.dd > yEnd) return false;
      return true;
    });
  }
  if (period.start && r.df && r.df < period.start) return false;
  if (period.end && r.dd && r.dd > period.end) return false;
  return true;
}

function _aggregate(records) {
  const prices = records.map(r => r.p);
  const cees = records.filter(r => r.c != null && r.c > 0).map(r => r.c);
  return {
    n: records.length,
    median: _r2(_med(prices)), p25: _r2(_pctl(prices, 25)), p75: _r2(_pctl(prices, 75)),
    cee: _r2(_med(cees)), ceeN: cees.length,
  };
}

function marketSuggest(c, mode, period) {
  const m = state.market;
  if (!m || !m.records) return { level: 'none' };
  const en = energieOf(c), seg = c.Segment__c, cat = c.categorie || '—';
  if (!seg) return { level: 'none' };
  mode = mode || state.marketMode;
  period = period !== undefined ? period : state.marketPeriod;
  const base = m.records.filter(r => r.en === en && (mode === 'retenue' ? r.ret : true) && _periodOverlap(r, period));
  const exact = base.filter(r => r.seg === seg && r.cat === cat);
  if (exact.length >= 3) return { level: 'exact', seg, cat, ...__agg(exact) };
  const segArr = base.filter(r => r.seg === seg);
  if (segArr.length >= 1) return { level: 'segment', seg, cat, ...__agg(segArr) };
  return { level: 'none' };
}
function __agg(records) { return _aggregate(records); }

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
  $('mTypeTarif').value = 'Unique';
  updateManualForm();
}
function closeManual() { $('manualOverlay').hidden = true; }

$('mEnergie').addEventListener('change', updateManualForm);
$('mSegment').addEventListener('change', updateManualForm);
$('mTypeTarif').addEventListener('change', updateManualForm);
document.querySelectorAll('.mvol').forEach(el => el.addEventListener('input', recalcVolTotal));

// Postes utilisés pour le calcul du volume total, par type de tarif
const MANUAL_VOL_POSTS = {
  'Unique': ['mVolBase'],
  '2postes': ['mVolHP', 'mVolHC'],
  '4postes': ['mVolHPH', 'mVolHCH', 'mVolHPE', 'mVolHCE', 'mVolHPTE'],
};

function recalcVolTotal() {
  const isElec = $('mEnergie').value === 'elec';
  if (!isElec) return; // gaz : volume total saisi directement
  const type = $('mTypeTarif').value;
  const posts = MANUAL_VOL_POSTS[type] || [];
  const total = posts.reduce((s, id) => s + (Number($(id).value) || 0), 0);
  $('mVolTotal').value = total ? Math.round(total * 100) / 100 : '';
}

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
  const type = $('mTypeTarif').value;

  // Type de tarif : élec uniquement
  $('mTypeTarifRow').style.display = isElec ? 'grid' : 'none';

  // Groupes de volume selon le type de tarif (élec) ; gaz = total saisi directement
  $('mVolGrpBase').style.display = (isElec && type === 'Unique') ? 'block' : 'none';
  $('mVolGrp2').style.display = (isElec && type === '2postes') ? 'block' : 'none';
  $('mVolGrp4').style.display = (isElec && type === '4postes') ? 'block' : 'none';
  $('mVolPointeRow').style.display = (isElec && type === '4postes' && isHT) ? 'grid' : 'none';

  // Volume total : auto-calculé (élec) ou saisi (gaz)
  const totalInput = $('mVolTotal');
  totalInput.readOnly = isElec;
  totalInput.style.background = isElec ? 'var(--bg)' : 'var(--surface)';
  totalInput.parentElement.querySelector('label').textContent = isElec
    ? 'Volume total annuel (MWh) — calculé automatiquement'
    : 'Volume total annuel (MWh)';

  $('mPuisPosts').style.display = isSup36 ? 'block' : 'none';
  recalcVolTotal();
}

let manualCounter = 0;
function addManualCompteur() {
  const en = $('mEnergie').value;
  const seg = $('mSegment').value;
  const isElec = en === 'elec';
  const isHT = ['C1','C2','C3'].includes(seg);
  const isSup36 = isElec && (isHT || seg === 'C4');
  const nom = isElec ? ($('mNom').value.trim() || `Manuel-${++manualCounter}`) : ($('mNomGaz').value.trim() || `Manuel-${++manualCounter}`);
  const type = $('mTypeTarif').value;
  const typeTarifs = isElec
    ? (type === '2postes' ? 'Horosaisonnalisé Heures Pleines/Heures Creuses' : (type === '4postes' ? 'Horosaisonnalisé' : 'Unique'))
    : 'Unique';
  if (isElec) recalcVolTotal();
  const volTotal = Number($('mVolTotal').value) || 0;

  if (!volTotal) { alert(isElec ? 'Veuillez saisir au moins un volume par poste.' : 'Veuillez saisir le volume total annuel.'); return; }

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
    _defaultTypeTarifs: typeTarifs,
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
$('selectAll').addEventListener('click', () => { visibleCompteurs().forEach(c => state.selected.add(c.Id)); renderCompteurList(); renderSimZone(); });
$('selectNone').addEventListener('click', () => { state.selected.clear(); renderCompteurList(); renderSimZone(); });
$('filterEnergie').addEventListener('change', (e) => { state.filterEnergie = e.target.value; renderCompteurList(); renderSimZone(); });
$('filterSegment').addEventListener('change', (e) => { state.filterSegment = e.target.value; renderCompteurList(); renderSimZone(); });
$('filterCompte').addEventListener('change', (e) => { state.filterCompte = e.target.value; renderCompteurList(); renderSimZone(); });
document.querySelectorAll('.year-chip').forEach(b => b.addEventListener('click', () => {
  b.classList.toggle('on');
  updateMarketPeriod();
}));
$('marketPeriodClear').addEventListener('click', () => {
  document.querySelectorAll('.year-chip').forEach(b => b.classList.remove('on'));
  updateMarketPeriod();
});
$('applyMarketAll').addEventListener('click', () => {
  state.compteurs.forEach(cc => {
    const ss = marketSuggest(cc);
    if (ss.level === 'none') return;
    applyMarket(cc, ss);
    const cd = $('card-' + cc.Id);
    if (cd) { renderColumns(cd, cc); computeOne(cc.Id); }
  });
});

function updateMarketPeriod() {
  const years = [...document.querySelectorAll('.year-chip.on')].map(b => Number(b.dataset.year)).sort();
  if (years.length) {
    // Période = de l'année min à l'année max sélectionnées ; une offre est retenue si sa
    // période de livraison (DateDebut/DateFin) chevauche au moins une année sélectionnée.
    state.marketPeriod = { start: `${years[0]}-01-01`, end: `${years[years.length - 1]}-12-31`, years };
  } else {
    state.marketPeriod = null;
  }
  if (state.marketPeriod && state.market && state.market.records) {
    const matching = state.market.records.filter(r => _periodOverlap(r, state.marketPeriod));
    const nProp = matching.length;
    const nRet = matching.filter(r => r.ret).length;
    $('marketPeriodHint').textContent = `Livraison ${years.join(', ')} — ${nProp} proposition(s) dont ${nRet} retenue(s) correspondent (toutes énergies/segments).`;
  } else {
    $('marketPeriodHint').textContent = '';
  }
  // Mise à jour de la durée (période du budget) sur tous les compteurs sélectionnés
  const durVal = years.length || '';
  state.compteurs.forEach(c => {
    const inp = state.inputs[c.Id];
    if (!inp) return;
    inp.estime.duree = durVal;
    const card = $('card-' + c.Id);
    if (card) {
      const dureeInput = card.querySelector('[data-col="estime"] [data-k="duree"]');
      if (dureeInput) dureeInput.value = durVal;
      computeOne(c.Id);
    }
  });
  rerenderAllMarkets();
}

// Pré-remplit les contacts (commercial + client) depuis Salesforce — éditables
function fmtContact(x) {
  if (!x) return '';
  return [x.name, x.email, x.phone].filter(Boolean).join(' · ');
}
function prefillContacts() {
  $('contactCommercial').value = fmtContact(state.meta && state.meta.commercial);
  $('contactClient').value = fmtContact(state.meta && state.meta.client);
}

// Compteurs visibles selon les filtres énergie / segment
function visibleCompteurs() {
  return state.compteurs.filter(c => {
    if (state.filterEnergie && energieOf(c) !== state.filterEnergie) return false;
    if (state.filterSegment && (c.Segment__c || '') !== state.filterSegment) return false;
    if (state.filterCompte && (c.compteNom || '') !== state.filterCompte) return false;
    return true;
  });
}

async function loadCompteurs() {
  const id = $('accountId').value.trim();
  $('loadError').innerHTML = '';
  if (!id) { $('loadError').innerHTML = `<div class="error-box">${icon('error')} Veuillez coller un identifiant de compte.</div>`; return; }
  if (!id.startsWith('001')) { $('loadError').innerHTML = `<div class="error-box">${icon('error')} L'ID saisi ne correspond pas à l'identifiant d'un compte Salesforce.</div>`; return; }
  $('loadBtn').disabled = true;
  $('loadBtn').innerHTML = '<span class="spinner"></span> Chargement…';

  const bar = $('loadingBar');
  const barFill = $('loadingBarFill');
  const barText = $('loadingBarText');
  bar.style.display = 'block';
  barFill.style.width = '0%';
  barText.textContent = 'Connexion à Salesforce…';

  const steps = [
    { pct: 20, text: 'Récupération des compteurs…' },
    { pct: 50, text: 'Chargement des lignes d\'offre…' },
    { pct: 75, text: 'Chargement des contacts…' },
    { pct: 95, text: 'Finalisation…' },
  ];
  let step = 0;
  const advance = () => { if (step < steps.length) { barFill.style.width = steps[step].pct + '%'; barText.textContent = steps[step].text; step++; } };

  try {
    advance();
    const data = await fetch(`/api/account/${encodeURIComponent(id)}/compteurs`).then(r => r.json());
    if (data.error) throw new Error(data.error);
    advance();
    const pf = await fetch(`/api/account/${encodeURIComponent(id)}/prefill`).then(r => r.json()).catch(() => ({ byCompteur: {} }));
    advance();
    const meta = await fetch(`/api/account/${encodeURIComponent(id)}/meta`).then(r => r.json()).catch(() => ({}));
    advance();

    state.compteurs = data.compteurs;
    state.byId = {}; data.compteurs.forEach(c => state.byId[c.Id] = c);
    state.selected.clear(); state.results = {};
    state.prefill = pf.byCompteur || {};
    state.meta = meta || {};
    state.filterEnergie = ''; state.filterSegment = ''; state.filterCompte = '';
    $('filterEnergie').value = ''; $('filterSegment').value = ''; $('filterCompte').value = '';
    populateSegmentFilter();
    populateCompteFilter();
    $('compteursPanel').style.display = 'block';
    $('compteurCount').textContent = `· ${data.count} compteur(s)`;
    $('compteurToolbar').style.display = data.count ? 'flex' : 'none';
    $('marketPeriodBar').style.display = data.count ? 'flex' : 'none';
    prefillContacts();
    $('contactsBar').style.display = data.count ? 'block' : 'none';
    renderCompteurList();
    if (!data.count) $('compteurList').innerHTML = `<div class="empty">${icon('search_off')}Aucun compteur rattaché à ce compte.</div>`;
    renderSimZone();
    barFill.style.width = '100%';
    barText.textContent = 'Synchronisation terminée';
  } catch (e) {
    $('loadError').innerHTML = `<div class="error-box">${icon('error')} ${e.message}</div>`;
    barText.textContent = 'Erreur de synchronisation';
    barFill.style.width = '100%';
    barFill.style.background = 'var(--rise)';
  } finally {
    $('loadBtn').disabled = false;
    $('loadBtn').innerHTML = `${icon('search')} Charger les compteurs`;
    setTimeout(() => { bar.style.display = 'none'; barFill.style.background = ''; }, 2000);
  }
}

function energieOf(c) {
  const rt = (c.recordTypeDeveloperName || '').toLowerCase();
  if (rt === 'elec') return 'elec';
  if (rt === 'gaz') return 'gaz';
  return (c.Energie__c || '').toLowerCase().includes('gaz') ? 'gaz' : 'elec';
}
function volOf(c, en) { return en === 'elec' ? c.VolumeTotalAnnuel__c : (c.VolumeEstime__c ?? c.VolumeReference__c); }

function populateSegmentFilter() {
  const sel = $('filterSegment');
  const segs = [...new Set(state.compteurs.map(c => c.Segment__c).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">Segment : tous</option>' + segs.map(s => `<option value="${s}">Segment ${s}</option>`).join('');
}

function populateCompteFilter() {
  const sel = $('filterCompte');
  const noms = [...new Set(state.compteurs.map(c => c.compteNom).filter(Boolean))].sort();
  // N'afficher le filtre que s'il y a au moins 2 comptes distincts (parent + enfant)
  if (noms.length < 2) { sel.style.display = 'none'; sel.innerHTML = '<option value="">Compte : tous</option>'; return; }
  sel.style.display = '';
  sel.innerHTML = '<option value="">Compte : tous</option>' + noms.map(n => `<option value="${n.replace(/"/g, '&quot;')}">${n}</option>`).join('');
}

function renderCompteurList() {
  const el = $('compteurList'); el.innerHTML = '';
  const list = visibleCompteurs();
  if (!list.length && state.compteurs.length) {
    el.innerHTML = `<div class="empty">${icon('filter_alt_off')}Aucun compteur ne correspond aux filtres.</div>`;
    return;
  }
  list.forEach(c => {
    const en = energieOf(c); const vol = volOf(c, en);
    const item = document.createElement('label');
    item.className = 'compteur-item' + (state.selected.has(c.Id) ? ' sel' : '');
    item.innerHTML = `
      <input type="checkbox" ${state.selected.has(c.Id) ? 'checked' : ''} />
      <span class="energy-ic ${en}">${icon(energyIcon(en))}</span>
      <div class="compteur-meta">
        <div class="name">${c.Name || '(sans nom)'}${c.compteNom ? ' <span class="compte-tag">' + c.compteNom + '</span>' : ''}</div>
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
  const base = { typeTarifs: c._defaultTypeTarifs || 'Unique', margeGlobal: '', prixAbo: '', energieVerte: '', duree: '' };
  let actuel, estime, overrides = {}, prefillInfo = null;
  if (en === 'gaz') {
    const g = () => ({ ...base, prixU: '', prixPartVarDistri: prixDistri, ticgn: state.labels.TaxTauxTicgn ?? '', ceeUser: '', cpbUser: '' });
    actuel = g(); estime = g();
  } else {
    const e = () => ({ ...base, prixU: '', prixCAPA: '', ceeUser: '', prixHP: '', prixHC: '', prixHPH: '', prixHCH: '', prixHPE: '', prixHCE: '', prixHPTE: '', prixCapaHP: '', prixCapaHC: '', prixCapaHPH: '', prixCapaHCH: '', prixCapaHPE: '', prixCapaHCE: '', prixCapaHPTE: '' });
    actuel = e(); estime = e();
  }

  // Offre proposée : abonnement et énergie verte pré-remplis à 0 (moins de saisie)
  estime.prixAbo = 0;
  estime.energieVerte = 0;

  const pf = state.prefill[c.Id];
  if (pf && pf.inputs) {
    const inp = pf.inputs;
    actuel.typeTarifs = inp.typeTarifs || 'Unique';
    estime.typeTarifs = inp.typeTarifs || 'Unique';
    // Pré-remplissage depuis Salesforce : une valeur absente/vide devient 0 (moins de saisie côté offre en cours)
    const numOrEmpty = (v) => (v != null && v !== 0) ? Math.round(v * 100) / 100 : 0;
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
      actuel.ticgn = inp.ticgn != null ? Math.round(inp.ticgn * 100) / 100 : (state.labels.TaxTauxTicgn ?? '');
      actuel.prixPartVarDistri = inp.prixPartVarDistri != null ? Math.round(inp.prixPartVarDistri * 100) / 100 : prixDistri;
    }
    if (pf.dureeMois != null && pf.dureeMois !== 0) actuel.duree = Math.round((pf.dureeMois / 12) * 10) / 10; // mois -> années
    if (pf.acheminementGaz != null && pf.acheminementGaz !== 0) overrides.acheminementGaz = Math.round(pf.acheminementGaz * 100) / 100;
    prefillInfo = {
      ligneOffreName: pf.ligneOffreName, offreName: pf.offreName, ligneOffreId: pf.ligneOffreId,
      prixMoyenNonMarge: pf.prixMoyenNonMarge != null ? Math.round(pf.prixMoyenNonMarge * 100) / 100 : null,
      dateDebutContrat: pf.dateDebutContrat || null, dateFinContrat: pf.dateFinContrat || null,
      dateFinContratCE: pf.dateFinContratCE || null,
    };
  }

  // Auto-application des prix marché à la colonne estimé (prix + marge 20% + CEE)
  const sm = marketSuggest(c);
  if (sm.level !== 'none') {
    const type = estime.typeTarifs || 'Unique';
    const m = sm.median;
    if (en === 'gaz') {
      estime.prixU = m;
    } else if (type === 'Horosaisonnalisé') {
      estime.prixHPH = m; estime.prixHCH = m; estime.prixHPE = m; estime.prixHCE = m; estime.prixHPTE = m;
    } else if (type.startsWith('Horosaisonnalisé Heures')) {
      estime.prixHP = m; estime.prixHC = m;
    } else {
      estime.prixU = m;
    }
    estime.margeGlobal = Math.round(m * 0.20 * 100) / 100;
    estime._margeAuto = true;
    if (sm.cee != null && sm.ceeN > 0) estime.ceeUser = sm.cee;
  }

  // Durée = nombre d'années de livraison sélectionnées
  if (state.marketPeriod && state.marketPeriod.years && state.marketPeriod.years.length) {
    estime.duree = state.marketPeriod.years.length;
  }

  // Éligibilité CEE : si l'APE/NAF du compte du compteur n'est pas éligible, forcer CEE à 0
  // (s'applique aux comptes parents ET enfants — la valeur vient du compte du compteur lui-même)
  if (c.apenaf && c.apenaf.CEE__c === false) {
    estime.ceeUser = 0;
    actuel.ceeUser = 0;
  }

  // Zéro-fill : champs estimé encore vides → 0
  for (const k of Object.keys(estime)) {
    if (k === 'typeTarifs' || k === '_margeAuto') continue;
    if (estime[k] === '' || estime[k] === undefined || estime[k] === null) estime[k] = 0;
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
    f.push({ k: 'duree', l: which === 'estime' ? 'Période du budget (années)' : 'Durée du contrat (années)', h: 'Nombre d\'années (ex : 1, 2, 3). Définit la période du budget estimé — sert au calcul de la date de fin de contrat.' });
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
  f.push({ k: 'duree', l: 'Durée du contrat (années)', h: 'Nombre d\'années (ex : 1, 2, 3). Définit la période du budget estimé — sert au calcul de la date de fin de contrat.' });
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
      ${inp.prefillInfo ? (() => {
        const pi = inp.prefillInfo;
        const loLabel = esc(pi.ligneOffreName || '(sans nom)');
        const loLink = pi.ligneOffreId
          ? `<a class="lo-link" href="https://capitoleenergie.lightning.force.com/lightning/r/LigneOffre__c/${encodeURIComponent(pi.ligneOffreId)}/view" target="_blank" rel="noopener noreferrer" title="Ouvrir la ligne d'offre dans Salesforce"><b>${loLabel}</b> ${icon('open_in_new')}</a>`
          : `<b>${loLabel}</b>`;
        const dd = pi.dateDebutContrat ? fmtDate(pi.dateDebutContrat) : null;
        const df = pi.dateFinContrat ? fmtDate(pi.dateFinContrat) : null;
        const periode = (dd || df) ? ` · livraison ${dd || '?'} → ${df || '?'}` : '';
        return `<div class="prefill-banner">${icon('auto_awesome')} <span>Contrat en cours pré-rempli depuis la ligne d'offre ${loLink} (offre ${esc(pi.offreName || '—')})${periode}</span></div>`;
      })() : `<div class="prefill-banner warn">${icon('edit_note')} <span>Aucune ligne d'offre actuelle trouvée pour ce compteur — saisie manuelle requise</span></div>`}
      ${!inp.prefillInfo ? `<div class="sim-actions">
        <button type="button" class="btn btn-ghost btn-sm" data-import-invoice>${icon('upload_file')} Importer une facture</button>
        <span class="sim-actions-hint">Extraction automatique du contrat en cours à partir d'un PDF de facture (données anonymisées avant envoi à OpenAI)</span>
        <input type="file" accept="application/pdf" data-invoice-file style="display:none" />
      </div>` : ''}
      <div data-invoice-banner></div>
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

  // Import facture
  const importBtn = card.querySelector('[data-import-invoice]');
  const fileInput = card.querySelector('[data-invoice-file]');
  if (importBtn && fileInput) {
    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      if (f) handleInvoiceUpload(card, c, f);
      fileInput.value = '';
    });
  }

  renderMarket(card, c);
  renderColumns(card, c);
  return card;
}

function rerenderAllMarkets() {
  state.compteurs.forEach(c => { const card = $('card-' + c.Id); if (card) renderMarket(card, c); });
}

function marketDetailRecords(c, mode, period) {
  const m = state.market;
  if (!m || !m.records) return [];
  const en = energieOf(c), seg = c.Segment__c, cat = c.categorie || '—';
  if (!seg) return [];
  const base = m.records.filter(r => r.en === en && (mode === 'retenue' ? r.ret : true) && _periodOverlap(r, period !== undefined ? period : state.marketPeriod));
  const exact = base.filter(r => r.seg === seg && r.cat === cat);
  const pool = exact.length >= 3 ? exact : base.filter(r => r.seg === seg);
  return pool.sort((a, b) => b.p - a.p).slice(0, 10);
}

function renderMarket(card, c) {
  const host = card.querySelector('[data-market]'); if (!host) return;
  const days = (state.market && state.market.meta && state.market.meta.days) || 30;
  const mode = 'proposition';
  const s = marketSuggest(c, 'proposition');

  const srcLabel = 'proposition(s)';
  const srcWord = 'propositions envoyées';

  if (s.level === 'none') {
    host.className = 'market none';
    host.innerHTML = `
      <div class="txt">
        <div style="display:flex;align-items:center;gap:6px;margin-top:6px">${icon('info')}<span>Aucune référence « proposition » récente pour ce profil (${energieOf(c) === 'elec' ? 'élec' : 'gaz'} ${c.Segment__c || '?'} / ${c.categorie || 'catégorie inconnue'}).</span></div>
      </div>`;
    return;
  }
  const lvlTxt = s.level === 'exact' ? `${c.Segment__c} · ${s.cat || '—'}` : `segment ${c.Segment__c} (toutes catégories)`;
  const perTxt = state.marketPeriod && state.marketPeriod.years && state.marketPeriod.years.length
    ? ` · livraison ${state.marketPeriod.years.join(', ')}` : '';
  host.className = 'market';
  const tip = `Prix d'énergie médian des ${s.n} ${srcWord} pour ce profil sur ${days} jours. `
    + `Chaque offre est pondérée par ses volumes de postes (HPH, HCH, HPE, HCE…) ; on prend ensuite la valeur médiane sur l'ensemble des offres. `
    + `Prix hors marge : ajoutez votre marge par-dessus.`;
  const ceeTxt = (s.cee != null && s.ceeN > 0) ? ` · CEE médian ${eur2.format(s.cee)}/MWh (${s.ceeN})` : '';
  // Éligibilité CEE du compte (APE/NAF) : information contextuelle pour l'utilisateur
  const ceeElig = c.apenaf && c.apenaf.CEE__c === false
    ? '<span class="cee-badge no" title="Le code APE/NAF du compte n\'ouvre pas droit aux Certificats d\'Économies d\'Énergie">Compte NON soumis aux CEE</span>'
    : (c.apenaf && c.apenaf.CEE__c === true
      ? '<span class="cee-badge yes" title="Le code APE/NAF du compte ouvre droit aux Certificats d\'Économies d\'Énergie">Compte soumis aux CEE</span>'
      : '');

  const detailRows = marketDetailRecords(c, mode).sort((a, b) => (b.cd || '').localeCompare(a.cd || ''));
  const fmtDd = (iso) => iso ? String(iso).slice(0,10).split('-').reverse().join('/') : '—';
  const popoverTable = detailRows.length ? `<div class="market-popover" data-market-popover>
    <div class="market-popover-title">Propositions — top ${detailRows.length}</div>
    <table class="market-popover-table">
      <thead><tr><th>Date</th><th>N° LO</th><th>Opportunité</th><th>Fournisseur</th><th>Offre</th><th>Début</th><th>Fin</th><th class="num">Volume compteur (MWh)</th><th class="num">Prix moyen pondéré margé (€/MWh)</th></tr></thead>
      <tbody>${detailRows.map(r => `<tr><td>${fmtDd(r.cd)}</td><td>${esc(r.lo || '—')}</td><td>${esc(r.opp || '—')}</td><td>${esc(r.frs || '—')}</td><td>${esc(r.offre || '—')}</td><td>${fmtDd(r.dd)}</td><td>${fmtDd(r.df)}</td><td class="num">${r.volC != null ? num.format(r.volC) : '—'}</td><td class="num">${r.pm != null ? num.format(r.pm) : '—'}</td></tr>`).join('')}</tbody>
    </table>
  </div>` : '';

  host.innerHTML = `
    ${icon('lightbulb')}
    <div class="txt">
      Prix marché pondéré médian <b>${eur2.format(s.median)}/MWh</b> <span class="help mi" title="${tip.replace(/"/g, '&quot;')}">help</span> <button type="button" class="market-detail-btn" data-toggle-popover title="Voir le détail des offres">${icon('table_chart')}</button> <span class="lvl ${s.level === 'segment' ? 'seg' : ''}">${s.level === 'segment' ? 'segment' : 'profil'}</span> ${ceeElig}
      ${popoverTable}
      <div class="sub">${lvlTxt} · fourchette ${num.format(s.p25)}–${num.format(s.p75)} €/MWh · ${s.n} ${srcLabel} sur ${days} j${perTxt}${ceeTxt}</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px">
      <button class="btn btn-ghost btn-sm" data-reset-market>${icon('restart_alt')} Reset les valeurs</button>
    </div>`;
  const popBtn = host.querySelector('[data-toggle-popover]');
  const popEl = host.querySelector('[data-market-popover]');
  if (popBtn && popEl) {
    popBtn.addEventListener('click', (e) => { e.stopPropagation(); popEl.classList.toggle('open'); });
    document.addEventListener('click', (e) => { if (!popEl.contains(e.target) && e.target !== popBtn) popEl.classList.remove('open'); }, { once: false });
  }
  host.querySelector('[data-reset-market]').addEventListener('click', () => { resetEstime(c); renderColumns(card, c); computeOne(c.Id); });
}

// Applique le prix marché (+ marge 20% + CEE médian) à la colonne estimé d'un compteur.
function applyMarket(c, s) {
  const inp = state.inputs[c.Id];
  const en = energieOf(c);
  const type = inp.estime.typeTarifs || 'Unique';
  const m = s.median;
  // Même médiane sur chaque poste → le prix moyen pondéré retombe sur la médiane. Type conservé.
  if (en === 'gaz') {
    inp.estime.prixU = m;
  } else if (type === 'Horosaisonnalisé') {
    inp.estime.prixHPH = m; inp.estime.prixHCH = m; inp.estime.prixHPE = m; inp.estime.prixHCE = m; inp.estime.prixHPTE = m;
  } else if (type.startsWith('Horosaisonnalisé Heures')) {
    inp.estime.prixHP = m; inp.estime.prixHC = m;
  } else {
    inp.estime.prixU = m;
  }
  // Marge : 20 % du prix de l'énergie (formule automatique)
  inp.estime.margeGlobal = Math.round(m * 0.20 * 100) / 100;
  inp.estime._margeAuto = true;
  // CEE médian agrégé — sauf si le compte n'est pas éligible aux CEE (APE/NAF)
  if (s.cee != null && s.ceeN > 0 && !(c.apenaf && c.apenaf.CEE__c === false)) inp.estime.ceeUser = s.cee;
  if (c.apenaf && c.apenaf.CEE__c === false) inp.estime.ceeUser = 0;
}

function resetEstime(c) {
  const inp = state.inputs[c.Id];
  if (!inp) return;
  for (const k of Object.keys(inp.estime)) {
    if (k === 'typeTarifs' || k === '_margeAuto') continue;
    inp.estime[k] = '';
  }
}

const ENERGY_KEYS = new Set(['prixU', 'prixHP', 'prixHC', 'prixHPH', 'prixHCH', 'prixHPE', 'prixHCE', 'prixHPTE']);
function energyAvg(col) {
  const vals = [...ENERGY_KEYS].map(k => Number(col[k])).filter(v => v && !isNaN(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

function renderColumns(card, c) {
  const en = energieOf(c); const inp = state.inputs[c.Id];
  const pending = invoicePending[c.Id];
  ['actuel', 'estime'].forEach(which => {
    const host = card.querySelector(`[data-col="${which}"]`); host.innerHTML = '';
    fieldDefs(en, inp[which].typeTarifs, which).forEach(d => {
      const wrap = document.createElement('div'); wrap.className = 'field';
      const val = inp[which][d.k] ?? '';
      const help = d.h ? ` <span class="help mi" title="${d.h.replace(/"/g, '&quot;')}">help</span>` : '';
      const fromInvoice = which === 'actuel' && pending && pending.keysActuel.includes(d.k);
      const inputClass = fromInvoice ? 'input from-invoice' : 'input';
      const invoiceTitle = fromInvoice ? ` title="Valeur extraite de la facture ${pending.data.fournisseur || ''} — à vérifier"` : '';
      wrap.innerHTML = `<label>${d.l}${help}${fromInvoice ? ` <span class="invoice-tag">${icon('search_check')}extrait</span>` : ''}</label><input type="number" step="any" class="${inputClass}" data-k="${d.k}" value="${val}"${invoiceTitle} />`;
      const input = wrap.querySelector('input');
      input.addEventListener('input', () => {
        inp[which][d.k] = input.value === '' ? '' : Number(input.value);
        // Marge auto = 20 % du prix de l'énergie (offre proposée) — se recalcule quand un prix change
        if (which === 'estime' && ENERGY_KEYS.has(d.k)) {
          const marge = Math.round(energyAvg(inp.estime) * 0.20 * 100) / 100;
          inp.estime.margeGlobal = marge;
          const mInput = host.querySelector('[data-k="margeGlobal"]');
          if (mInput) mInput.value = marge || '';
        }
        scheduleCompute(c.Id);
      });
      host.appendChild(wrap);
    });
    const pmBox = document.createElement('div');
    pmBox.className = 'pmnm-box';
    pmBox.setAttribute('data-pmnm', which);
    const pmLabel = which === 'estime' ? 'Prix moyen pondéré (margé)' : 'Prix moyen pondéré (hors marge)';
    pmBox.innerHTML = `<span class="pmnm-k">${pmLabel}</span><span class="pmnm-v">—</span>`;
    host.appendChild(pmBox);
  });
}

/* ---------- Import facture (extraction OpenAI) ---------- */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    r.onerror = () => reject(new Error('Lecture du fichier échouée'));
    r.readAsDataURL(file);
  });
}

// Trace des champs remplis par la facture (pour le surlignage + revue)
const invoicePending = {}; // id compteur -> { snapshot, data, keysActuel:[] }

async function handleInvoiceUpload(card, c, file) {
  const bannerHost = card.querySelector('[data-invoice-banner]');
  bannerHost.innerHTML = `<div class="invoice-banner busy">${icon('hourglass_empty')} <span>Extraction de <b>${esc(file.name)}</b>… (~5-10s)</span></div>`;
  try {
    const b64 = await fileToBase64(file);
    const resp = await fetch('/api/extract-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdfBase64: b64 }),
    });
    const payload = await resp.json();
    if (!resp.ok || payload.error) throw new Error(payload.error || 'Erreur serveur');
    applyInvoiceExtraction(card, c, payload.data, file.name);
  } catch (e) {
    bannerHost.innerHTML = `<div class="invoice-banner err">${icon('error')} <span>Échec de l'extraction : ${esc(e.message)}</span></div>`;
  }
}

// Applique l'extraction à la colonne « actuel » avec surlignage jaune
function applyInvoiceExtraction(card, c, data, filename) {
  const inp = state.inputs[c.Id];
  const en = energieOf(c);

  // Snapshot pour permettre d'annuler
  const snapshot = JSON.parse(JSON.stringify(inp.actuel));
  const filled = [];

  // Type de tarif
  let newType = inp.actuel.typeTarifs;
  if (en === 'elec') {
    if (data.type_tarif === 'Unique') newType = 'Unique';
    else if (data.type_tarif === 'HP_HC') newType = 'Horosaisonnalisé Heures Pleines/Heures Creuses';
    else if (data.type_tarif === 'Horo_4postes' || data.type_tarif === 'Horo_5postes') newType = 'Horosaisonnalisé';
  }
  if (newType !== inp.actuel.typeTarifs) {
    inp.actuel.typeTarifs = newType;
    inp.estime.typeTarifs = newType;
    const ts = card.querySelector('[data-type-selector]');
    if (ts) ts.value = newType;
  }

  // Prix fourniture par poste
  const map = { Base: 'prixU', HP: 'prixHP', HC: 'prixHC', HPH: 'prixHPH', HCH: 'prixHCH', HPE: 'prixHPE', HCE: 'prixHCE', HPTE: 'prixHPTE' };
  const prices = data.prix_fourniture_eur_mwh || {};
  for (const [poste, key] of Object.entries(map)) {
    if (prices[poste] != null) { inp.actuel[key] = Math.round(prices[poste] * 100) / 100; filled.push(key); }
  }
  // Autres
  if (data.abonnement_eur_mois != null) { inp.actuel.prixAbo = Math.round(data.abonnement_eur_mois * 100) / 100; filled.push('prixAbo'); }
  if (data.cee_eur_mwh != null) { inp.actuel.ceeUser = Math.round(data.cee_eur_mwh * 100) / 100; filled.push('ceeUser'); }
  if (data.capacite_eur_mwh != null) { inp.actuel.prixCAPA = Math.round(data.capacite_eur_mwh * 100) / 100; filled.push('prixCAPA'); }
  if (en === 'gaz' && data.ticgn_eur_mwh != null) { inp.actuel.ticgn = Math.round(data.ticgn_eur_mwh * 100) / 100; filled.push('ticgn'); }

  // Volumes par poste : le calcul du prix moyen pondéré utilise les volumes du COMPTEUR
  // (VolumeHP__c, VolumeHPH__c, etc.), pas les prix saisis. Si Salesforce n'a que le volume
  // total (profil simple) et que la facture révèle un tarif HP/HC ou 4 postes, ces volumes
  // détaillés sont à 0 → le calcul serait faux. On les complète depuis la facture, UNIQUEMENT
  // si le compteur n'a pas déjà cette donnée (on ne remplace jamais une valeur SF existante).
  const volumesInjected = [];
  if (en === 'elec') {
    const volMap = { HP: 'VolumeHP__c', HC: 'VolumeHC__c', HPH: 'VolumeHPH__c', HCH: 'VolumeHCH__c', HPE: 'VolumeHPE__c', HCE: 'VolumeHCE__c', HPTE: 'VolumeHPTE__c' };
    const volumesInvoice = data.volume_par_poste_mwh || {};
    for (const [poste, sfField] of Object.entries(volMap)) {
      const val = volumesInvoice[poste];
      if (val != null && val > 0 && !c[sfField]) { c[sfField] = val; volumesInjected.push(poste); }
    }
    if (!c.VolumeTotalAnnuel__c && data.volume_annuel_mwh) { c.VolumeTotalAnnuel__c = data.volume_annuel_mwh; volumesInjected.push('Total'); }
  } else if (en === 'gaz' && !c.VolumeReference__c && !c.VolumeEstime__c && data.volume_annuel_mwh) {
    c.VolumeReference__c = data.volume_annuel_mwh; volumesInjected.push('Total');
  }

  invoicePending[c.Id] = { snapshot, data, keysActuel: filled, filename, volumesInjected };

  // Bandeau bleu de revue
  const conf = data.confidence || 'medium';
  const warnings = (data.validation_warnings || []).slice(0, 3);
  const warnHtml = warnings.length ? `<div class="invoice-banner-warn">${icon('warning')} À vérifier : ${warnings.map(w => `<code>${esc(w)}</code>`).join(' · ')}</div>` : '';
  const notes = data.notes ? `<div class="invoice-banner-notes">${icon('sticky_note_2')} ${esc(data.notes)}</div>` : '';
  const volNote = volumesInjected.length
    ? `<div class="invoice-banner-notes">${icon('bolt')} Volume(s) par poste complété(s) depuis la facture (absents du compteur Salesforce) : <b>${volumesInjected.join(', ')}</b> — nécessaire pour un prix moyen pondéré correct.</div>` : '';
  const banner = card.querySelector('[data-invoice-banner]');
  banner.innerHTML = `
    <div class="invoice-banner review">
      <div class="invoice-banner-head">
        ${icon('search_check')}
        <div>
          <div class="invoice-banner-title">Extrait de <b>${esc(data.fournisseur || 'la facture')}</b>${data.date_facture ? ` · ${esc(data.date_facture)}` : ''}</div>
          <div class="invoice-banner-sub">Fichier ${esc(filename)} · confiance <b>${conf}</b> · ${filled.length} champ(s) pré-rempli(s) (surlignés en jaune ci-dessous)</div>
        </div>
        <div class="invoice-banner-btns">
          <button type="button" class="btn btn-primary btn-sm" data-invoice-validate>${icon('check')} Valider</button>
          <button type="button" class="btn btn-ghost btn-sm" data-invoice-cancel>${icon('close')} Annuler</button>
        </div>
      </div>
      ${warnHtml}${volNote}${notes}
    </div>`;
  banner.querySelector('[data-invoice-validate]').addEventListener('click', () => {
    delete invoicePending[c.Id];
    banner.innerHTML = `<div class="invoice-banner ok">${icon('check_circle')} <span>Contrat en cours pré-rempli à partir de la facture <b>${esc(data.fournisseur || filename)}</b> — valeurs conservées.</span></div>`;
    renderColumns(card, c);
    computeOne(c.Id);
  });
  banner.querySelector('[data-invoice-cancel]').addEventListener('click', () => {
    // Restaurer le snapshot des prix + retirer les volumes injectés sur le compteur
    Object.assign(inp.actuel, snapshot);
    const volFieldMap = { HP: 'VolumeHP__c', HC: 'VolumeHC__c', HPH: 'VolumeHPH__c', HCH: 'VolumeHCH__c', HPE: 'VolumeHPE__c', HCE: 'VolumeHCE__c', HPTE: 'VolumeHPTE__c', Total: en === 'gaz' ? 'VolumeReference__c' : 'VolumeTotalAnnuel__c' };
    volumesInjected.forEach(poste => { const f = volFieldMap[poste]; if (f) c[f] = null; });
    delete invoicePending[c.Id];
    banner.innerHTML = '';
    renderColumns(card, c);
    computeOne(c.Id);
  });

  renderColumns(card, c);
  computeOne(c.Id);
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

  // Prix moyen pondéré (hors marge) — rempli sous la case durée de chaque colonne
  const inp = state.inputs[id];
  const pmSF = inp && inp.prefillInfo && inp.prefillInfo.prixMoyenNonMarge != null ? inp.prefillInfo.prixMoyenNonMarge : null;
  const pmActuel = pmSF != null ? pmSF : r.prixMoyenNonMargeActuel;
  const pmEstimeMarge = r.volume > 0 ? Math.round((r.estime.calculTarif / r.volume) * 100) / 100 : null;
  const setPm = (which, val, src) => {
    const box = card.querySelector(`[data-pmnm="${which}"] .pmnm-v`);
    if (box) box.innerHTML = (val && val > 0) ? `${eur2.format(val)}/MWh${src ? ` <span class="pmnm-src">${src}</span>` : ''}` : '—';
  };
  setPm('actuel', pmActuel, pmSF != null ? 'ligne d\'offre' : 'calculé');
  setPm('estime', pmEstimeMarge, 'calculé · margé');

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
    ['Abonnement (× 12)', 'calculAboAnnuel'],
    ['Acheminement TURPE (élec)', 'calculTurpe'], ['Acheminement gaz', 'acheminementGaz'],
    ['= Sous-total Acheminement', '_subtotalAchem', 'subtotal'],
    ['CTA', 'calculCTA'], ['TICFE', 'calculCSPE'], ['TICGN', 'calculTICGN'],
    ['= Sous-total Taxes hors TVA', 'calculTaxesHorsTVA', 'subtotal'],
    ['BUDGET HTVA', 'calculTarifHorsTVA'],
  ];
  const cell = (x) => x == null ? '—' : eur2.format(x);
  const strongKeys = ['calculEnergie', 'calculTarifHorsTVA'];
  const achemA = (r.actuel.calculTurpe || 0) + (r.actuel.acheminementGaz || 0);
  const achemE = (r.estime.calculTurpe || 0) + (r.estime.acheminementGaz || 0);
  const body = rows.map(([label, k, type]) => {
    if (k === '_subtotalAchem') {
      if (achemA === 0 && achemE === 0) return '';
      return `<tr class="subtotal"><td>${label}</td><td class="num">${cell(achemA)}</td><td class="num">${cell(achemE)}</td></tr>`;
    }
    const a = r.actuel[k], e = r.estime[k];
    if ((a === 0 || a == null) && (e === 0 || e == null) && !strongKeys.includes(k) && type !== 'subtotal') return '';
    const isSubtotal = type === 'subtotal';
    return `<tr class="${isSubtotal ? 'subtotal' : (strongKeys.includes(k) ? 'strong' : '')}"><td>${label}</td><td class="num">${cell(a)}</td><td class="num">${cell(e)}</td></tr>`;
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

async function exportPDF() {
  const ids = [...state.selected].filter(id => state.results[id]);
  if (!ids.length) return alert('Aucun résultat à exporter. Lancez une simulation d\'abord.');

  const today = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  const firstC = state.byId[ids[0]];
  const clientName = firstC ? (firstC.compteNom || '—') : '—';
  const commercial = ($('contactCommercial') && $('contactCommercial').value.trim()) || '';
  const clientContact = ($('contactClient') && $('contactClient').value.trim()) || '';

  let totalA = 0, totalE = 0;
  ids.forEach(id => { totalA += state.results[id].budgetActuel; totalE += state.results[id].budgetEstime; });
  const totalDiff = totalE - totalA;
  const totalPct = totalA === 0 ? 0 : (totalDiff / totalA) * 100;

  // Au-delà de ce seuil : uniquement la synthèse (pas de détail par compteur) pour éviter
  // un PDF de centaines de pages lors d'une comparaison de nombreux PDL.
  const DETAIL_LIMIT = 12;
  const showDetail = ids.length <= DETAIL_LIMIT;

  const compteurBlocks = !showDetail ? '' : ids.map(id => {
    const c = state.byId[id]; const r = state.results[id]; const inp = state.inputs[id];
    const en = energieOf(c); const vol = volOf(c, en);
    const dir = r.difference > 0 ? 'rise' : (r.difference < 0 ? 'save' : 'flat');
    const sign = r.difference > 0 ? '+' : '';

    const rows = [
      ['Fourniture (énergie)', 'calculTarif'], ['Capacité', 'calculCapacite'],
      ['CEE', 'calculCEE'], ['CPB', 'calculCPB'], ['Part var. distribution', 'calculPartVarDistri'],
      ['Énergie verte', 'calculEnergieVerte'], ['Énergie totale', 'calculEnergie'],
      ['Abonnement (× 12)', 'calculAboAnnuel'],
      ['Acheminement TURPE', 'calculTurpe'], ['Acheminement gaz', 'acheminementGaz'],
      ['= Sous-total Acheminement', '_subtotalAchem', 'subtotal'],
      ['CTA', 'calculCTA'], ['TICFE', 'calculCSPE'], ['TICGN', 'calculTICGN'],
      ['= Sous-total Taxes hors TVA', 'calculTaxesHorsTVA', 'subtotal'],
      ['BUDGET HTVA', 'calculTarifHorsTVA'],
    ];
    const strongKeys = new Set(['calculEnergie', 'calculTaxesHorsTVA', 'calculTarifHorsTVA']);
    const achemA = (r.actuel.calculTurpe || 0) + (r.actuel.acheminementGaz || 0);
    const achemE = (r.estime.calculTurpe || 0) + (r.estime.acheminementGaz || 0);
    const tableRows = rows.map(([label, k, type]) => {
      if (k === '_subtotalAchem') {
        if (achemA === 0 && achemE === 0) return '';
        return `<tr class="subtotal-row"><td>${label}</td><td class="num">${fmtEur2(achemA)} €/an</td><td class="num">${fmtEur2(achemE)} €/an</td></tr>`;
      }
      const a = r.actuel[k], e = r.estime[k];
      if ((a === 0 || a == null) && (e === 0 || e == null) && !strongKeys.has(k) && type !== 'subtotal') return '';
      const isBudget = k === 'calculTarifHorsTVA';
      const isSubtotal = type === 'subtotal';
      const cls = isBudget ? ' class="strong budget-row"' : (isSubtotal ? ' class="subtotal-row"' : (strongKeys.has(k) ? ' class="strong"' : ''));
      const isMwh = k === 'calculTarif' || k === 'calculTICGN' || k === 'calculCSPE' || k === 'calculCapacite' || k === 'calculCEE' || k === 'calculEnergieVerte';
      const unit = isMwh ? ' €/MWh' : ' €/an';
      const fmt = (x) => isBudget ? `${fmtNum(x || 0)}${unit}` : `${fmtEur2(x)}${unit}`;
      return `<tr${cls}><td>${label}</td><td class="num">${fmt(a)}</td><td class="num">${fmt(e)}</td></tr>`;
    }).filter(Boolean).join('');

    return `
      <div class="compteur-block ${en}">
        <div class="compteur-header">
          <div class="energy-badge ${en}">${en === 'elec' ? 'ÉLEC' : 'GAZ'}</div>
          <div class="compteur-info">
            <div class="compteur-name">${c.Name || '—'}</div>
            <div class="compteur-detail">${r.energie} · ${c.Segment__c || '—'}${c.TensionCompteur__c ? ' · ' + c.TensionCompteur__c : ''}${c.ProfilCompteur__c ? ' · ' + c.ProfilCompteur__c : (c.ProfilCompteurGaz__c ? ' · ' + c.ProfilCompteurGaz__c : '')} · ${vol != null ? fmtNum(vol) + ' MWh/an' : 'volume N/C'}${c.Fournisseur_Actuel_Nom__c ? ' · Fournisseur actuel : ' + c.Fournisseur_Actuel_Nom__c : ''}</div>
            ${(() => {
              const pmA = (inp.prefillInfo && inp.prefillInfo.prixMoyenNonMarge != null) ? inp.prefillInfo.prixMoyenNonMarge : r.prixMoyenNonMargeActuel;
              const pmE = r.volume > 0 ? Math.round((r.estime.calculTarif / r.volume) * 100) / 100 : null;
              if ((pmA && pmA > 0) || (pmE && pmE > 0)) {
                const ecartPct = (pmA && pmA > 0 && pmE && pmE > 0) ? ((pmE - pmA) / pmA * 100) : null;
                const ecartTxt = ecartPct != null ? ` (${ecartPct > 0 ? '+' : ''}${num.format(ecartPct)} %)` : '';
                return `<div class="compteur-detail" style="margin-top:2px">Prix moyen pondéré — actuel <b>${fmtEur2(pmA)}/MWh</b> · estimé <b>${fmtEur2(pmE)}/MWh</b>${ecartTxt}</div>`;
              }
              return '';
            })()}
            ${(() => {
              const finC = inp.prefillInfo && inp.prefillInfo.dateFinContrat ? fmtDate(inp.prefillInfo.dateFinContrat) : null;
              const parts = [];
              if (finC) parts.push(`Fin contrat en cours : <b>${finC}</b>`);
              if (inp.estime.duree) parts.push(`Période estimé : <b>${inp.estime.duree} an(s)</b>`);
              return parts.length ? `<div class="compteur-detail" style="margin-top:2px">${parts.join(' · ')}</div>` : '';
            })()}
          </div>
        </div>
        <div class="ecart-box ${dir}">
          <div class="ecart-label">${r.difference < 0 ? 'Économie estimée' : (r.difference > 0 ? 'Surcoût estimé' : 'Budget identique')}</div>
          <div class="ecart-value">${sign}${fmtEur(r.difference)} /an</div>
          <div class="ecart-pct">soit ${sign}${fmtNum(r.differencePct)} %</div>
        </div>
        <table class="detail-table">
          <thead><tr><th>Poste</th><th class="num">Actuel</th><th class="num">Estimé</th></tr></thead>
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

    .synthese { background: #C1E8B5; color: #232323; border-radius: 8px; padding: 16px 20px; margin-bottom: 20px; display: grid; grid-template-columns: 1fr 1fr 1fr 1.3fr; gap: 10px; align-items: center; }
    .synthese .s-box { background: #fff; border: 1px solid #9AD68A; border-radius: 6px; padding: 10px 14px; text-align: center; }
    .synthese .s-label { font-size: 9px; text-transform: uppercase; letter-spacing: .4px; color: #6E6E80; font-weight: 600; }
    .synthese .s-value { font-size: 18px; font-weight: 800; }
    .synthese .s-value.sm { font-size: 14px; }
    .synthese .ecart-col { text-align: center; }
    .synthese .ecart-col .s-box { background: #fff; border: 2px solid #12875A; }
    .synthese .ecart-col .s-value { font-size: 22px; font-weight: 800; }
    .synthese .s-pct { font-size: 11px; color: #6E6E80; font-weight: 600; }

    .compteur-block { page-break-inside: avoid; margin-bottom: 16px; border: 1px solid #E3E3E3; border-radius: 8px; overflow: hidden; }
    .compteur-header { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: #FAFAFC; border-bottom: 1px solid #E3E3E3; }
    .energy-badge { font-size: 9px; font-weight: 700; letter-spacing: .5px; padding: 4px 10px; border-radius: 5px; }
    .energy-badge.elec { background: #E7ECFF; color: #0C32FF; }
    .energy-badge.gaz { background: #FFCBFD; color: #E543DC; }
    .compteur-name { font-size: 12px; font-weight: 700; font-family: 'Consolas', 'Courier New', monospace; }
    .compteur-detail { font-size: 9.5px; color: #6E6E80; margin-top: 1px; }

    .ecart-box { padding: 12px 14px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 2px; }
    .ecart-box.save { background: #C1E8B5; }
    .ecart-box.rise { background: #FDECF1; }
    .ecart-box.flat { background: #F3F3F3; }
    .ecart-label { font-size: 11px; font-weight: 700; color: #232323; text-transform: uppercase; letter-spacing: .3px; }
    .ecart-value { font-size: 22px; font-weight: 800; }
    .ecart-box.save .ecart-value { color: #12875A; }
    .ecart-box.rise .ecart-value { color: #D11F4A; }
    .ecart-pct { font-size: 12px; font-weight: 700; color: #232323; }

    .detail-table { width: 100%; border-collapse: collapse; font-size: 10px; }
    .detail-table th, .detail-table td { padding: 5px 10px; border: 1px solid #D3D3DD; text-align: left; }
    .detail-table th { font-size: 9px; text-transform: uppercase; letter-spacing: .3px; color: #232323; font-weight: 800; background: #EDEDFF; }
    .detail-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
    .detail-table tr.strong td { font-weight: 700; background: #F6F5FF; }
    .detail-table td.save { color: #12875A; }
    .detail-table td.rise { color: #D11F4A; }
    /* Sous-totaux acheminement / taxes : fond bleu-violet */
    .detail-table tr.subtotal-row td { font-weight: 700; background: #EDEDFF; color: #5020EA; border-top: 1px solid #d9d4fb; border-bottom: 1px solid #d9d4fb; }
    /* Ligne budget final : mise en avant forte */
    .detail-table tr.budget-row td { font-size: 12px; font-weight: 800; background: #FFF4CC; border-top: 2px solid #5020EA; border-bottom: 2px solid #5020EA; }
    .detail-table tr.budget-row td.save { color: #12875A; font-size: 13px; }
    .detail-table tr.budget-row td.rise { color: #D11F4A; font-size: 13px; }

    .footer { margin-top: 24px; padding-top: 10px; border-top: 2px solid transparent; border-image: linear-gradient(90deg, #0C32FF 0%, #E543DC 55%, #FFC14F 100%) 1; display: flex; justify-content: space-between; align-items: center; }
    .footer .left { font-size: 9px; color: #9A9AAC; }
    .footer .right { font-size: 9px; color: #9A9AAC; }
    .footer .brand { font-weight: 700; color: #5020EA; }

    .mention { font-size: 8.5px; color: #9A9AAC; margin-top: 8px; font-style: italic; }

    .recap-section { margin-bottom: 20px; }
    .recap-title { font-size: 13px; font-weight: 700; color: #5020EA; margin-bottom: 8px; }
    .recap-table { width: 100%; border-collapse: collapse; font-size: 9.5px; }
    .recap-table th, .recap-table td { padding: 6px 8px; border: 1px solid #E3E3E3; text-align: left; }
    .recap-table th { font-size: 8px; text-transform: uppercase; letter-spacing: .3px; color: #6E6E80; font-weight: 600; background: #FAFAFC; }
    .recap-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
    .recap-table td.mono { font-family: 'Consolas', 'Courier New', monospace; font-size: 9px; }
    .recap-table td.save { color: #12875A; font-weight: 600; }
    .recap-table td.rise { color: #D11F4A; font-weight: 600; }
    .recap-table .total-row td { background: #F6F5FF; border-top: 2px solid #5020EA; }
    .recap-table .total-row td.save { color: #12875A; }
    .recap-table .total-row td.rise { color: #D11F4A; }

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
    ${commercial ? `<div><div class="label">Contact commercial</div><div class="value">${esc(commercial)}</div></div>` : ''}
    ${clientContact ? `<div><div class="label">Contact client</div><div class="value">${esc(clientContact)}</div></div>` : ''}
    ${state.marketPeriod && state.marketPeriod.years && state.marketPeriod.years.length ? `<div><div class="label">Année(s) de livraison simulée(s)</div><div class="value">${state.marketPeriod.years.join(', ')}</div></div>` : ''}
  </div>

  ${ids.length > 1 ? `
  <div class="synthese">
    <div class="s-box"><div class="s-label">Budget actuel total</div><div class="s-value sm">${fmtEur(totalA)}/an</div></div>
    <div class="s-box"><div class="s-label">Budget estimé total</div><div class="s-value sm">${fmtEur(totalE)}/an</div></div>
    <div class="s-box"><div class="s-label">Compteurs</div><div class="s-value sm">${ids.length}</div></div>
    <div class="ecart-col">
      <div class="s-box">
        <div class="s-label">Écart annuel</div>
        <div class="s-value">${totalSign}${fmtEur(totalDiff)}/an</div>
        <div class="s-pct">soit ${totalSign}${fmtNum(totalPct)} %</div>
      </div>
    </div>
  </div>

  <div class="recap-section">
    <h2 class="recap-title">Récapitulatif par compteur</h2>
    <table class="recap-table">
      <thead>
        <tr>
          <th>N° Compteur</th>
          <th>Compte</th>
          <th>Énergie</th>
          <th>Segment</th>
          <th class="num">Volume (MWh)</th>
          <th>Période estimé</th>
          <th class="num">Budget actuel (€/an)</th>
          <th class="num">Budget estimé (€/an)</th>
          <th class="num">Écart (€/an)</th>
          <th class="num">Écart (%)</th>
        </tr>
      </thead>
      <tbody>
        ${ids.map(id => {
          const c = state.byId[id]; const r = state.results[id]; const inp = state.inputs[id];
          const en = energieOf(c); const vol = volOf(c, en);
          const sign = r.difference > 0 ? '+' : '';
          const cls = r.difference < 0 ? 'save' : (r.difference > 0 ? 'rise' : '');
          const periode = inp.estime.duree ? inp.estime.duree + ' an(s)' : '—';
          return `<tr>
            <td class="mono">${esc(c.Name || '—')}</td>
            <td>${esc(c.compteNom || '—')}</td>
            <td>${en === 'elec' ? 'Élec' : 'Gaz'}</td>
            <td>${esc(c.Segment__c || '—')}</td>
            <td class="num">${vol != null ? fmtNum(vol) : '—'}</td>
            <td>${periode}</td>
            <td class="num">${fmtNum(r.budgetActuel)}</td>
            <td class="num">${fmtNum(r.budgetEstime)}</td>
            <td class="num ${cls}">${sign}${fmtNum(r.difference)}</td>
            <td class="num ${cls}">${sign}${fmtNum(r.differencePct)} %</td>
          </tr>`;
        }).join('')}
        <tr class="total-row">
          <td colspan="4"><strong>TOTAL</strong></td>
          <td class="num"><strong>${fmtNum(ids.reduce((s, id) => { const c = state.byId[id]; return s + (volOf(c, energieOf(c)) || 0); }, 0))}</strong></td>
          <td></td>
          <td class="num"><strong>${fmtNum(totalA)}</strong></td>
          <td class="num"><strong>${fmtNum(totalE)}</strong></td>
          <td class="num ${diffDir}"><strong>${totalSign}${fmtNum(totalDiff)}</strong></td>
          <td class="num ${diffDir}"><strong>${totalSign}${fmtNum(totalPct)} %</strong></td>
        </tr>
      </tbody>
    </table>
  </div>` : ''}

  ${!showDetail ? `<div class="mention" style="font-size:10px;color:#5020EA;font-style:normal">Comparaison de ${ids.length} compteurs — synthèse consolidée présentée ci-dessus (le détail par compteur n'est pas affiché au-delà de ${DETAIL_LIMIT} compteurs).</div>` : ''}

  ${compteurBlocks}

  <div class="mention">Les montants sont exprimés en euros hors TVA, sur une base annuelle (€/an). L'acheminement et les taxes sont réglementés et identiques quel que soit le fournisseur — seule la fourniture et l'abonnement font l'objet de la négociation.</div>
  <div class="mention" style="margin-top:8px;font-size:9px;color:#6E6E80">Avertissement : les montants présentés dans ce document sont des estimations indicatives basées sur les données disponibles au moment de la simulation. Ils ne constituent en aucun cas un engagement contractuel. Les prix réels pourront varier en fonction des conditions de marché, des évolutions réglementaires et des négociations avec les fournisseurs.</div>

  <div class="footer">
    <div class="left"><span class="brand">Capitole Énergie</span> — Courtier en énergie</div>
    <div class="right">Document généré le ${today} — Simulateur Budgétaire v1.0</div>
  </div>
</body>
</html>`;

  const btn = $('exportBtn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Génération…';
  try {
    const clientSlug = (clientName || 'export').replace(/[^a-zA-Z0-9À-ÿ]/g, '_').substring(0, 40);
    const filename = `Simulation_${clientSlug}_${new Date().toISOString().slice(0,10)}.pdf`;
    const resp = await fetch('/api/export-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, filename }),
    });
    if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error || 'Erreur serveur'); }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('Erreur lors de la génération du PDF : ' + e.message);
  } finally {
    btn.disabled = false; btn.innerHTML = `${icon('picture_as_pdf')} Exporter PDF`;
  }
}

function fmtEur(v) { return eur.format(v || 0); }
function fmtEur2(v) { return v == null ? '—' : eur2.format(v); }
function fmtNum(v) { return num.format(v || 0); }
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function fmtDate(iso) {
  if (!iso) return null;
  const p = String(iso).slice(0, 10).split('-');
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : iso;
}
// Date de fin du contrat CE : champ SF si présent, sinon calculée = début + N années
function ceEndDate(inp) {
  if (inp.prefillInfo && inp.prefillInfo.dateFinContratCE) return fmtDate(inp.prefillInfo.dateFinContratCE);
  const years = Number(inp.estime && inp.estime.duree);
  if (!years) return null;
  // Base : fin du contrat en cours (renouvellement) sinon date de début du contrat en cours
  const baseIso = (inp.prefillInfo && (inp.prefillInfo.dateFinContrat || inp.prefillInfo.dateDebutContrat)) || null;
  const parts = baseIso ? String(baseIso).slice(0, 10).split('-').map(Number) : null;
  const base = parts && parts.length === 3 ? new Date(parts[0], parts[1] - 1, parts[2]) : new Date();
  base.setFullYear(base.getFullYear() + Math.round(years));
  const dd = String(base.getDate()).padStart(2, '0'), mm = String(base.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${base.getFullYear()}`;
}

init();
