// UI: map, KPIs, tabs. Analysis runs in a worker; maths lives in analysis.js.
import { loadStations, loadLive, loadDay, loadChangedSince, loadCauseNames, currentDelay, API } from './data.js';
import { analyseDays, costOf, sectionCost, DEFAULT_ASSUMPTIONS } from './analysis.js';
import { BUILTIN_TEMPLATES, interventionFor, rankOpportunities, summarise, buildPrompt, buildQuestionPrompt, createTemplateStore, getSampler } from './report.js';
import { toCSV, download, chartPNG, mdToHtml, reportHTML, printReport } from './export.js';

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf0 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const eur = x => '€' + (Math.abs(x) >= 1e6 ? nf1.format(x / 1e6) + 'M' : Math.abs(x) >= 1e4 ? nf0.format(x / 1e3) + 'k' : nf0.format(x));
const num = (x, d = 2) => x == null || !Number.isFinite(x) ? '–' : x.toFixed(d);
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const BUCKET_LABEL = { infrastructure: 'Infrastructure faults', works: 'Track works', capacity: 'Capacity / traffic mgmt', operator: 'Operator & rolling stock', other: 'Other' };
const DELAY_STEPS = [[30, '--d0'], [60, '--d1'], [120, '--d2'], [240, '--d3'], [Infinity, '--d4']]; // seconds created per run
const LIVE_STEPS = [[60, '--d0'], [180, '--d1'], [300, '--d2'], [600, '--d3'], [Infinity, '--d4']];
const colorFor = (v, steps) => cssVar(steps.find(([t]) => v < t)[1]);

const IN_ARTIFACT = location.hostname.endsWith('claude.ai') || location.hostname.endsWith('claudeusercontent.com') || location.protocol === 'blob:';
const state = {
  stations: new Map(), causeNames: new Map(), analysis: null, assumptions: structuredClone(DEFAULT_ASSUMPTIONS),
  selected: null, live: new Map(), liveVersion: 0, charts: {}, templates: [], store: null, sampler: undefined, lastReport: '',
};
const name = c => state.stations.get(c)?.name || c;
const secName = s => `${name(s.from)} → ${name(s.to)}`;

function setStatus(msg, err = false) { const el = $('#status'); el.textContent = msg; el.classList.toggle('err', err); }

// ---------- theme ----------
$('#theme').onclick = () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('rdi.theme', root.dataset.theme); } catch { }
  setTiles(); redrawAll(); startHero();
};
try { const t = localStorage.getItem('rdi.theme'); if (t) document.documentElement.dataset.theme = t; } catch { }
const isDark = () => getComputedStyle(document.documentElement).colorScheme === 'dark';

// ---------- map ----------
const map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([63.2, 25.5], 6);
const renderer = L.canvas({ padding: 0.3 });
let tiles;
function setTiles() {
  if (tiles) map.removeLayer(tiles);
  tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    { attribution: '© OpenStreetMap contributors', maxZoom: 18, className: 'basemap' }).addTo(map);
  let errs = 0; tiles.on('tileerror', () => { if (++errs === 4) map.removeLayer(tiles); }); // host blocks tiles: the network itself is the map
}
setTiles();
const sectionLayer = L.layerGroup().addTo(map);
const liveLayer = L.layerGroup().addTo(map);

function drawLegend() {
  const sw = DELAY_STEPS.map(([, v], i) => `<span class="sw" style="background:${cssVar(v)}"></span>${['<30s', '<1m', '<2m', '<4m', '4m+'][i]}`).join(' ');
  const dots = LIVE_STEPS.map(([, v], i) => `<span class="dot" style="background:${cssVar(v)}"></span>${['<1', '<3', '<5', '<10', '10+'][i]}`).join(' ');
  $('#legend').innerHTML = `<div class="row"><b>Delay created per train</b> ${sw}</div><div class="row">Line width = € impact · <b>Live delay (min)</b> ${dots}</div>`;
}

function drawSections() {
  sectionLayer.clearLayers();
  const a = state.analysis; if (!a) return;
  const days = a.kpis.days || 1;
  const list = [...a.sections.values()].filter(s => state.stations.has(s.from) && state.stations.has(s.to));
  const maxEur = Math.max(1, ...list.map(s => sectionCost(s, state.assumptions) / days));
  list.sort((x, y) => x.shrunkMean - y.shrunkMean); // worst drawn on top
  for (const s of list) {
    const A = state.stations.get(s.from), B = state.stations.get(s.to);
    const e = sectionCost(s, state.assumptions) / days;
    const line = L.polyline([[A.lat, A.lon], [B.lat, B.lon]], {
      renderer, color: colorFor(s.shrunkMean, DELAY_STEPS), weight: 2 + 7 * Math.sqrt(e / maxEur), opacity: 0.9, lineCap: 'round',
    });
    line.on('click', () => selectSection(s.key));
    line.bindTooltip(`${esc(secName(s))} · ${eur(e)}/day`, { sticky: true });
    sectionLayer.addLayer(line);
  }
}

// ---------- live trains ----------
let liveTimer, delayTimer;
async function refreshLiveDelays() {
  try {
    if (!state.liveVersion) {
      const today = hkiDate(Date.now());
      const trains = await loadDay(today);
      for (const t of trains) { state.live.set(t.trainNumber, t); state.liveVersion = Math.max(state.liveVersion, t.version); }
    } else {
      const changed = await loadChangedSince(state.liveVersion);
      for (const t of changed) { state.live.set(t.trainNumber, t); state.liveVersion = Math.max(state.liveVersion, t.version); }
    }
  } catch (e) { console.warn('live delays', e); }
}
async function refreshLive() {
  if (!$('#live').checked) { liveLayer.clearLayers(); return; }
  try {
    const gj = state.snapshot ? state.snapshot.live : await loadLive();
    liveLayer.clearLayers();
    for (const f of gj.features) {
      const p = f.properties, t = state.live.get(p.trainNumber);
      const d = state.snapshot ? state.snapshot.liveDelays[p.trainNumber]?.d ?? null : t ? currentDelay(t) : null;
      const [lon, lat] = f.geometry.coordinates;
      const m = L.circleMarker([lat, lon], { renderer, radius: 5, weight: 1.5, color: cssVar('--surface'), fillOpacity: 1, fillColor: d == null ? cssVar('--muted') : colorFor(d, LIVE_STEPS) });
      const label = t ? `${t.trainType} ${t.trainNumber}` : `Train ${p.trainNumber}`;
      m.bindTooltip(`${esc(label)} · ${p.speed} km/h · ${d == null ? 'delay n/a' : (d / 60).toFixed(1) + ' min'}`);
      liveLayer.addLayer(m);
    }
    state.liveGeo = gj;
    setStatus(state.snapshot ? `${gj.features.length} trains · positions at ${new Date(state.snapshot.generatedAt).toLocaleString('en-GB', { timeZone: 'Europe/Helsinki', dateStyle: 'medium', timeStyle: 'short' })}` : `${gj.features.length} trains live · ${new Date().toLocaleTimeString('en-GB')}`);
  } catch (e) { setStatus('Live positions unavailable: ' + e.message, true); }
}
function startLive() {
  clearInterval(liveTimer); clearInterval(delayTimer);
  if (!$('#live').checked) { liveLayer.clearLayers(); return; }
  if (state.snapshot) { refreshLive(); return; }
  refreshLiveDelays().then(refreshLive);
  liveTimer = setInterval(refreshLive, 15000);
  delayTimer = setInterval(refreshLiveDelays, 60000);
}
$('#live').onchange = startLive;

// ---------- analysis (worker with main-thread fallback) ----------
let worker, reqId = 0;
const hkiDate = t => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(t); // Finnish operating day, YYYY-MM-DD
function datesFor(n) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push(hkiDate(Date.now() - i * 864e5));
  return out;
}
function analyse(dates) {
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    try {
      worker ??= new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        if (data.id !== id) return;
        if (data.progress) setStatus(data.progress);
        else if (data.error) reject(new Error(data.error));
        else resolve(data.result);
      };
      worker.onerror = e => { e.preventDefault?.(); worker = null; fallback(); };
      worker.postMessage({ id, dates, assumptions: state.assumptions });
    } catch { fallback(); }
    async function fallback() {
      try {
        const trains = [];
        for (const d of dates) { setStatus(`Downloading ${d}`); trains.push(...await loadDay(d)); }
        setStatus('Analysing…'); await new Promise(r => setTimeout(r, 30));
        resolve(analyseDays(trains, { assumptions: state.assumptions }));
      } catch (e) { reject(e); }
    }
  });
}

async function runAnalysis() {
  renderKPIs(true);
  try {
    state.analysis = state.snapshot ? state.snapshot.analysis : await analyse(datesFor(+$('#days').value));
    state.selected = null; $('#fp').classList.add('hidden');
    redrawAll();
    setStatus(`Analysed ${nf0.format(state.analysis.kpis.trains)} trains`);
    if ($('#live').checked) refreshLive();
  } catch (e) {
    setStatus(e.message, true);
    $('#tab-opps').innerHTML = `<div class="note">Could not load data: ${esc(e.message)}</div>`;
  }
}
$('#days').onchange = runAnalysis;

function redrawAll() {
  drawLegend();
  if (!state.analysis) return;
  renderHome();
  renderKPIs(); drawSections(); renderOpps(); renderSections(); renderStations(); renderCauses(); renderWhatIf(); renderHistory(); renderAssumptions();
  if (state.selected) selectSection(state.selected, false);
}

// ---------- KPIs ----------
function renderKPIs(loading = false) {
  const a = state.analysis, k = a?.kpis;
  const c = a && !loading ? costOf(a, state.assumptions) : null;
  const days = k?.days || 1;
  const items = [
    ['Trains analysed', k && nf0.format(k.trains), k && `${k.days} day${k.days > 1 ? 's' : ''}`],
    ['On time (≤3 min)', k && nf1.format(k.onTimePct) + '%', 'at final station'],
    ['Mean final delay', k && nf1.format(k.meanFinalDelayMin) + ' min', k && `p90 ${nf1.format(k.p90FinalDelayMin)} min`],
    ['Delay created', k && nf0.format(k.createdMin / days) + ' min/day', k && `${nf0.format(k.createdRunMin / k.createdMin * 100 || 0)}% running · rest dwell`],
    ['Cost of delay (est.)', c && eur(c.eur / days) + '/day', c && `95% CI ${eur(c.lo / days)}–${eur(c.hi / days)}`],
    ['Annualised (est.)', c && eur(c.eur / days * 365) + '/yr', 'extrapolated ×365'],
  ];
  $('#kpis').innerHTML = items.map(([l, v, s]) =>
    `<div class="kpi"><div class="l">${l}</div><div class="v ${loading || !v ? 'skeleton' : ''}">${esc(v || '00000')}</div><div class="s">${esc(loading ? '' : s || '')}</div></div>`).join('');
}

// ---------- fingerprint card ----------
function selectSection(key, fly = true) {
  const s = state.analysis?.sections.get(key); if (!s) return;
  state.selected = key;
  const iv = interventionFor(s), days = state.analysis.kpis.days || 1, e = sectionCost(s, state.assumptions) / days;
  const mix = Object.entries(s.causeMix).sort((a, b) => b[1] - a[1]).map(([b, n]) => `<span class="chip">${esc(BUCKET_LABEL[b] || b)} ${n}</span>`).join('') || '<span class="muted">no cause codes recorded</span>';
  const betaTxt = s.beta == null ? 'insufficient data (n<5)' : `${num(s.beta)} <span class="muted">[${num(s.betaCI?.lo)}, ${num(s.betaCI?.hi)}]</span> ${s.beta > 1.05 ? '<b style="color:var(--bad)">amplifies</b>' : s.beta < 0.95 ? '<span style="color:var(--good)">absorbs</span>' : 'neutral'}`;
  const fp = $('#fp');
  fp.innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:8px"><h3 style="margin:0">${esc(secName(s))}</h3><button class="icon" id="fpClose" aria-label="Close">✕</button></div>
    <div class="muted" style="font-size:12px;margin-bottom:8px">Section health fingerprint · ${s.n} train runs</div>
    <table>
      <tr><td>α delay created at zero inbound delay</td><td class="n">${s.alpha == null ? '–' : num(s.alpha, 0) + ' s'}</td></tr>
      <tr><td>β propagation [95% CI]</td><td class="n">${betaTxt}</td></tr>
      <tr><td>Knock-on leverage</td><td class="n">${num(s.leverage)} min/min</td></tr>
      <tr><td>Shrunk mean created per run</td><td class="n">${num(s.shrunkMean, 0)} s</td></tr>
      <tr><td>Cost of delay created (est.)</td><td class="n"><b>${eur(e)}/day</b></td></tr>
    </table>
    <div class="chartbox" style="height:180px"><canvas id="fpChart"></canvas></div>
    <div class="chips">${mix}</div>
    <div class="note"><b>${esc(iv.fix)}</b> → <span class="chip svc">${esc(iv.service)}</span><br>${esc(iv.why)}</div>`;
  fp.classList.remove('hidden');
  $('#fpClose').onclick = () => { fp.classList.add('hidden'); state.selected = null; };
  scatter(s);
  if (fly) {
    const A = state.stations.get(s.from), B = state.stations.get(s.to);
    if (A && B) map.flyToBounds([[A.lat, A.lon], [B.lat, B.lon]], { maxZoom: 11, padding: [80, 80], duration: 0.6 });
  }
  if ($('#tab-whatif').classList.contains('on')) renderWhatIf();
}

function chartDefaults() {
  Chart.defaults.color = cssVar('--muted'); Chart.defaults.borderColor = cssVar('--border'); Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
}
function makeChart(id, cfg) {
  chartDefaults();
  state.charts[id]?.destroy();
  const el = document.getElementById(id); if (!el) return null;
  return (state.charts[id] = new Chart(el, { ...cfg, options: { responsive: true, maintainAspectRatio: false, animation: { duration: 250 }, ...cfg.options } }));
}

function scatter(s) {
  const xs = s._xs || [], ys = s._ys || [];
  const step = Math.max(1, Math.floor(xs.length / 600));
  const pts = []; for (let i = 0; i < xs.length; i += step) pts.push({ x: xs[i] / 60, y: ys[i] / 60 });
  const lo = Math.min(0, ...pts.map(p => p.x)), hi = Math.max(1, ...pts.map(p => p.x));
  const ds = [{ type: 'scatter', label: 'Train runs', data: pts, pointRadius: 2, backgroundColor: cssVar('--navy') + '99' },
    { type: 'line', label: 'No change (y=x)', data: [{ x: lo, y: lo }, { x: hi, y: hi }], borderColor: cssVar('--muted'), borderDash: [4, 4], pointRadius: 0, borderWidth: 1 }];
  if (s.beta != null) ds.push({ type: 'line', label: `Theil–Sen fit β=${num(s.beta)}`, data: [{ x: lo, y: (s.alpha + s.beta * lo * 60) / 60 }, { x: hi, y: (s.alpha + s.beta * hi * 60) / 60 }], borderColor: cssVar('--bad'), pointRadius: 0, borderWidth: 2 });
  makeChart('fpChart', { data: { datasets: ds }, options: { plugins: { legend: { labels: { boxWidth: 10, font: { size: 10 } } } },
    scales: { x: { type: 'linear', title: { display: true, text: 'Delay in (min)' } }, y: { title: { display: true, text: 'Delay out (min)' } } } } });
}

// ---------- Opportunities ----------
function renderOpps() {
  const a = state.analysis, opps = rankOpportunities(a, state.assumptions, 15);
  const total = opps.reduce((t, o) => t + o.eurPerDay, 0);
  $('#tab-opps').innerHTML = `
    <h3>Where Sweco can create value</h3>
    <p class="lead">Line sections ranked by the estimated cost of the delay they <i>create</i>. Each one comes with its statistical evidence and the intervention its fingerprint points to.</p>
    <div class="toolbar"><span class="muted">Top 15 total: <b>${eur(total)}/day</b> · ${eur(total * 365)}/yr (est.)</span><span style="flex:1"></span><button id="oppCsv">⬇ CSV</button></div>
    ${opps.map(({ s, eurPerDay }, i) => {
      const iv = interventionFor(s), w = Math.round(eurPerDay / (opps[0]?.eurPerDay || 1) * 100);
      return `<div class="opp" data-key="${esc(s.key)}"><div class="rank">${i + 1}</div><div>
        <div class="t">${esc(secName(s))}</div>
        <div class="chips"><span class="chip">n=${s.n}</span><span class="chip">α=${s.alpha == null ? '–' : num(s.alpha, 0) + 's'}</span>
        <span class="chip ${s.beta > 1.05 ? 'amp' : ''}">β=${num(s.beta)}${s.betaCI ? ` [${num(s.betaCI.lo, 1)}–${num(s.betaCI.hi, 1)}]` : ''}</span><span class="chip">lev=${num(s.leverage, 1)}</span>
        <span class="chip svc">${esc(iv.service)}</span></div>
        <div class="fix">${esc(iv.fix)} – ${esc(iv.why)}</div><div class="bar"><i style="width:${w}%"></i></div></div>
        <div class="eur">${eur(eurPerDay)}<small>per day</small></div></div>`;
    }).join('') || '<div class="note">No delay created in this period.</div>'}`;
  document.querySelectorAll('#tab-opps .opp').forEach(el => el.onclick = () => selectSection(el.dataset.key));
  $('#oppCsv').onclick = () => download('opportunities.csv', toCSV(opps.map(({ s, eurPerDay }) => ({ section: secName(s), from: s.from, to: s.to, runs: s.n, alpha_s: s.alpha, beta: s.beta, beta_lo: s.betaCI?.lo, beta_hi: s.betaCI?.hi, leverage: s.leverage, eur_per_day: Math.round(eurPerDay), intervention: interventionFor(s).fix, sweco_service: interventionFor(s).service }))), 'text/csv');
}

// ---------- Sections table ----------
let secSort = { key: 'eur', dir: -1 };
function sectionRows() {
  const days = state.analysis.kpis.days || 1;
  return [...state.analysis.sections.values()].map(s => ({
    key: s.key, section: secName(s), n: s.n, created: s.created / 60 / days, mean: s.shrunkMean, alpha: s.alpha, beta: s.beta,
    lo: s.betaCI?.lo, hi: s.betaCI?.hi, lev: s.leverage, eur: sectionCost(s, state.assumptions) / days,
  }));
}
function renderSections() {
  const rows = sectionRows().sort((a, b) => ((a[secSort.key] ?? -1e9) > (b[secSort.key] ?? -1e9) ? 1 : -1) * secSort.dir);
  const cols = [['section', 'Section'], ['n', 'Runs', 1], ['created', 'Created min/day', 1], ['mean', 'EB mean s', 1], ['alpha', 'α s', 1], ['beta', 'β', 1], ['lev', 'Leverage', 1], ['eur', '€/day', 1]];
  const fmt = (c, r) => c === 'section' ? esc(r.section) : c === 'eur' ? eur(r.eur) : c === 'n' ? r.n : c === 'beta' ? num(r.beta) : c === 'lev' ? num(r.lev) : num(r[c], 0);
  $('#tab-sections').innerHTML = `<h3>All sections (${rows.length})</h3>
    <p class="lead">Directional sections between consecutive timetable points. EB mean = empirical-Bayes shrunk delay created per run, which keeps sections with few runs from topping the list by chance.</p>
    <div class="toolbar"><input type="text" id="secFilter" placeholder="Filter by station…"><span style="flex:1"></span><button id="secCsv">⬇ CSV</button></div>
    <div class="tablewrap" style="max-height:calc(100% - 90px)"><table><thead><tr>${cols.map(([k, l, n]) => `<th data-k="${k}" class="${n ? 'n' : ''}">${l}${secSort.key === k ? (secSort.dir < 0 ? ' ↓' : ' ↑') : ''}</th>`).join('')}</tr></thead>
    <tbody>${rows.slice(0, 400).map(r => `<tr class="click" data-key="${esc(r.key)}">${cols.map(([k, , n]) => `<td class="${n ? 'n' : ''}">${fmt(k, r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  document.querySelectorAll('#tab-sections th').forEach(th => th.onclick = () => { secSort = { key: th.dataset.k, dir: secSort.key === th.dataset.k ? -secSort.dir : -1 }; renderSections(); });
  document.querySelectorAll('#tab-sections tr.click').forEach(tr => tr.onclick = () => selectSection(tr.dataset.key));
  $('#secFilter').oninput = e => { const q = e.target.value.toLowerCase(); document.querySelectorAll('#tab-sections tbody tr').forEach(tr => tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none'); };
  $('#secCsv').onclick = () => download('sections.csv', toCSV(sectionRows().map(r => ({ section: r.section, key: r.key, runs: r.n, created_min_per_day: r.created.toFixed(1), eb_mean_s: r.mean.toFixed(1), alpha_s: r.alpha, beta: r.beta, beta_lo: r.lo, beta_hi: r.hi, leverage: r.lev, eur_per_day: Math.round(r.eur) }))), 'text/csv');
}

// ---------- Stations ----------
function renderStations() {
  const rows = [...state.analysis.stations.values()].filter(s => state.stations.get(s.code)?.passenger).sort((a, b) => b.dwellCreated - a.dwellCreated).slice(0, 60);
  const days = state.analysis.kpis.days || 1;
  $('#tab-stations').innerHTML = `<h3>Stations</h3><p class="lead">Passenger stations ranked by dwell delay created, where a stop overruns. Click one to see its live board (scheduled vs actual).</p>
    <div class="toolbar"><span style="flex:1"></span><button id="stCsv">⬇ CSV</button></div>
    <div id="stBoard"></div>
    <div class="tablewrap"><table><thead><tr><th>Station</th><th class="n">Arrivals</th><th class="n">Mean arr. delay</th><th class="n">Dwell created min/day</th></tr></thead>
    <tbody>${rows.map(s => `<tr class="click" data-c="${esc(s.code)}"><td>${esc(name(s.code))} <span class="muted mono">${esc(s.code)}</span></td><td class="n">${s.n}</td><td class="n">${num(s.meanArrDelay / 60, 1)} min</td><td class="n">${num(s.dwellCreated / 60 / days, 1)}</td></tr>`).join('')}</tbody></table></div>`;
  document.querySelectorAll('#tab-stations tr.click').forEach(tr => tr.onclick = () => stationBoard(tr.dataset.c));
  $('#stCsv').onclick = () => download('stations.csv', toCSV([...state.analysis.stations.values()].map(s => ({ code: s.code, name: name(s.code), arrivals: s.n, mean_arr_delay_s: Math.round(s.meanArrDelay), dwell_created_s: Math.round(s.dwellCreated) }))), 'text/csv');
}
async function stationBoard(code) {
  const box = $('#stBoard');
  if (state.snapshot) { box.innerHTML = `<div class="note">The live station board for ${esc(name(code))} needs the live version of this tool. This page shows a snapshot.</div>`; return; } box.innerHTML = `<div class="note">Loading live board for ${esc(name(code))}…</div>`;
  const st = state.stations.get(code); if (st) map.flyTo([st.lat, st.lon], 11, { duration: 0.6 });
  try {
    const res = await fetch(`${API}/live-trains/station/${encodeURIComponent(code)}?arrived_trains=6&arriving_trains=6&departed_trains=0&departing_trains=0&include_nonstopping=false`, { headers: { 'Digitraffic-User': 'rail-delay-intelligence-demo' } });
    const trains = await res.json();
    const rows = trains.map(t => {
      const r = t.timeTableRows.find(x => x.stationShortCode === code && x.type === 'ARRIVAL'); if (!r) return null;
      const act = r.actualTime || r.liveEstimateTime, d = act ? (Date.parse(act) - Date.parse(r.scheduledTime)) / 60000 : null;
      return { t, r, d, act };
    }).filter(Boolean).sort((a, b) => Date.parse(a.r.scheduledTime) - Date.parse(b.r.scheduledTime));
    const hm = s => s ? new Date(s).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Helsinki' }) : '–';
    box.innerHTML = `<div class="card" style="margin-bottom:12px"><b>${esc(name(code))}</b> · arrivals (Helsinki time)
      <table><thead><tr><th>Train</th><th>Scheduled</th><th>Actual / est.</th><th class="n">Delay</th></tr></thead><tbody>
      ${rows.map(({ t, r, d, act }) => `<tr><td>${esc(t.trainType)} ${esc(t.commuterLineID || t.trainNumber)}</td><td>${hm(r.scheduledTime)}</td><td>${hm(act)}${r.actualTime ? '' : ' <span class="muted">est</span>'}</td><td class="n" style="color:${d == null ? '' : colorFor(d * 60, LIVE_STEPS)}">${d == null ? '–' : d.toFixed(1) + ' min'}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No trains right now</td></tr>'}
      </tbody></table></div>`;
  } catch (e) { box.innerHTML = `<div class="note">Live board unavailable: ${esc(e.message)}</div>`; }
}

// ---------- Causes ----------
function renderCauses() {
  const c = state.analysis.causes, total = Object.values(c.byBucket).reduce((a, b) => a + b, 0) || 1;
  const buckets = Object.keys(BUCKET_LABEL).filter(b => c.byBucket[b]);
  const addressable = ((c.byBucket.infrastructure || 0) + (c.byBucket.works || 0) + (c.byBucket.capacity || 0)) / total * 100;
  const codes = Object.entries(c.byCode).sort((a, b) => b[1] - a[1]).slice(0, 12);
  $('#tab-causes').innerHTML = `<h3>Who can fix it?</h3>
    <p class="lead">Official delay cause codes recorded by traffic control, grouped by the party that can act on them.</p>
    <div class="statline"><div class="big">${nf0.format(addressable)}%</div><div class="muted">of coded delay events trace to infrastructure, track works or capacity, the problems infrastructure-owner consulting addresses.</div></div>
    <div class="toolbar" style="margin-top:12px"><span style="flex:1"></span><button id="causePng">⬇ PNG</button><button id="causeCsv">⬇ CSV</button></div>
    <div class="chartbox"><canvas id="causeChart"></canvas></div>
    <table><thead><tr><th>Code</th><th>Description (FI)</th><th class="n">Events</th></tr></thead><tbody>
    ${codes.map(([k, n]) => `<tr><td class="mono">${esc(k)}</td><td>${esc(state.causeNames.get(k) || '')}</td><td class="n">${n}</td></tr>`).join('')}</tbody></table>`;
  const pal = ['--d4', '--d3', '--navy', '--d1', '--muted'];
  makeChart('causeChart', { type: 'bar', data: { labels: buckets.map(b => BUCKET_LABEL[b]), datasets: [{ data: buckets.map(b => c.byBucket[b]), backgroundColor: buckets.map((b, i) => cssVar(pal[Object.keys(BUCKET_LABEL).indexOf(b)] || pal[i])), borderRadius: 6 }] },
    options: { indexAxis: 'y', plugins: { legend: { display: false } } } });
  $('#causePng').onclick = () => chartPNG(state.charts.causeChart, 'delay-causes.png');
  $('#causeCsv').onclick = () => download('causes.csv', toCSV(Object.entries(c.byCode).map(([code, n]) => ({ code, description_fi: state.causeNames.get(code) || '', events: n }))), 'text/csv');
}

// ---------- What-if ----------
function renderWhatIf() {
  const opps = rankOpportunities(state.analysis, state.assumptions, 30);
  const key = state.selected && state.analysis.sections.has(state.selected) ? state.selected : opps[0]?.s.key;
  const el = $('#tab-whatif');
  if (!key) { el.innerHTML = '<div class="note">No sections with delay in this period.</div>'; return; }
  const prev = { pct: +($('#wiPct')?.value || 50), capex: +($('#wiCapex')?.value || 15) };
  const options = new Map(opps.map(o => [o.s.key, o.s])); options.set(key, state.analysis.sections.get(key));
  el.innerHTML = `<h3>What-if: fix a section</h3>
    <p class="lead">Estimate what an intervention is worth. The direct saving is the delay the section creates, removed. The network effect adds the knock-on delay it no longer causes downstream (leverage), which is an upper-bound estimate.</p>
    <div class="formgrid">
      <label for="wiSec">Section</label><select id="wiSec" style="grid-column:span 1;max-width:260px">${[...options.values()].map(s => `<option value="${esc(s.key)}" ${s.key === key ? 'selected' : ''}>${esc(secName(s))}</option>`).join('')}</select>
      <label for="wiPct">Delay created removed</label><div><input type="range" id="wiPct" min="0" max="100" step="5" value="${prev.pct}"> <span id="wiPctV">${prev.pct}%</span></div>
      <label for="wiCapex">Intervention cost (€M)</label><input type="number" id="wiCapex" min="0" step="1" value="${prev.capex}">
    </div>
    <div id="wiOut" style="margin-top:16px"></div>`;
  const calc = () => {
    const s = state.analysis.sections.get($('#wiSec').value), pct = +$('#wiPct').value / 100, capex = +$('#wiCapex').value * 1e6;
    const days = state.analysis.kpis.days || 1, direct = sectionCost(s, state.assumptions) / days * pct, network = direct * (1 + (s.leverage || 0));
    const yrD = direct * 365, yrN = network * 365;
    $('#wiPctV').textContent = Math.round(pct * 100) + '%';
    $('#wiOut').innerHTML = `<div class="wi-grid">
      <div class="wi"><div class="l">Direct saving</div><div class="v">${eur(yrD)}/yr</div><div class="s">${eur(direct)}/day</div></div>
      <div class="wi"><div class="l">Incl. network knock-on</div><div class="v">${eur(yrN)}/yr</div><div class="s">× (1 + leverage ${num(s.leverage)})</div></div>
      <div class="wi"><div class="l">Simple payback</div><div class="v">${yrN > 0 ? nf1.format(capex / yrN) + ' yrs' : '–'}</div><div class="s">direct only: ${yrD > 0 ? nf1.format(capex / yrD) : '–'} yrs</div></div>
      <div class="wi"><div class="l">30-yr benefit (undiscounted)</div><div class="v">${eur(yrN * 30)}</div><div class="s">BCR ≈ ${capex ? nf1.format(yrN * 30 / capex) : '–'} (rough)</div></div></div>
      <div class="note">Suggested intervention: <b>${esc(interventionFor(s).fix)}</b>. Passenger-time benefit only; excludes operating savings and reliability premiums. A full socio-economic appraisal per Väylävirasto guidelines is the natural next study.</div>`;
  };
  ['wiSec', 'wiPct', 'wiCapex'].forEach(id => $('#' + id).oninput = calc);
  calc();
}

// ---------- History (long-run fingerprints in shared db) ----------
let historyDb;
async function renderHistory() {
  const el = $('#tab-history');
  el.innerHTML = `<h3>Section health over time</h3>
    <p class="lead">Save each period's fingerprints to a shared history. Over weeks this builds a baseline that flags sections getting worse (β or delay created rising), an early warning for asset management and a basis for a recurring monitoring service.</p>
    <div class="toolbar"><button class="primary" id="hSave">Save this period's fingerprints</button><button id="hCsv">⬇ CSV</button><span id="hMsg" class="muted"></span></div>
    <div id="hBody"><div class="note">Loading history…</div></div>`;
  historyDb ??= await (window.claude?.use?.('db')?.catch(() => null) ?? null);
  if (!historyDb) { $('#hBody').innerHTML = '<div class="note">History is stored in the shared database of the published claude.ai page. It is not available when the file runs locally.</div>'; $('#hSave').disabled = true; $('#hCsv').disabled = true; return; }
  const load = async () => (await historyDb.collection('history').get()).docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.id.localeCompare(b.id));
  const draw = async () => {
    let hist; try { hist = await load(); } catch (e) { $('#hBody').innerHTML = `<div class="note">Could not read history: ${esc(e.message || e.code)}</div>`; return; }
    if (!hist.length) { $('#hBody').innerHTML = '<div class="note">No snapshots yet. Save one to start the baseline.</div>'; return; }
    const keys = new Set(); hist.forEach(h => h.sections.forEach(s => keys.add(s.key)));
    const pick = state.selected && keys.has(state.selected) ? state.selected : rankOpportunities(state.analysis, state.assumptions, 1)[0]?.s.key || [...keys][0];
    const series = hist.map(h => ({ id: h.id, s: h.sections.find(x => x.key === pick) }));
    const betas = series.filter(p => p.s?.beta != null);
    const trend = betas.length >= 3 ? slope(betas.map((_, i) => i), betas.map(p => p.s.beta)) : null;
    $('#hBody').innerHTML = `<div class="muted">${hist.length} snapshot(s): ${hist.map(h => esc(h.id)).join(', ')}</div>
      <div class="toolbar" style="margin-top:8px"><label>Section <select id="hSec">${[...keys].sort().map(k => `<option value="${esc(k)}" ${k === pick ? 'selected' : ''}>${esc(k.split('-').map(name).join(' → '))}</option>`).join('')}</select></label></div>
      ${trend != null ? `<div class="note">β trend: <b style="color:${trend > 0.02 ? 'var(--bad)' : 'var(--good)'}">${trend > 0.02 ? 'deteriorating' : trend < -0.02 ? 'improving' : 'stable'}</b> (slope ${trend.toFixed(3)} per snapshot)</div>` : '<div class="note">Save at least 3 snapshots to estimate a trend.</div>'}
      <div class="chartbox"><canvas id="hChart"></canvas></div>`;
    $('#hSec').onchange = e => { state.selected = e.target.value; draw(); };
    makeChart('hChart', { type: 'line', data: { labels: series.map(p => p.id), datasets: [
      { label: 'β propagation', data: series.map(p => p.s?.beta ?? null), borderColor: cssVar('--bad'), yAxisID: 'y', spanGaps: true },
      { label: 'Created min/day', data: series.map(p => p.s ? p.s.createdMinPerDay : null), borderColor: cssVar('--navy'), yAxisID: 'y1', spanGaps: true }] },
      options: { scales: { y: { title: { display: true, text: 'β' } }, y1: { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'min/day' } } } } });
    $('#hCsv').onclick = () => download('fingerprint-history.csv', toCSV(hist.flatMap(h => h.sections.map(s => ({ snapshot: h.id, ...s })))), 'text/csv');
  };
  $('#hSave').onclick = async () => {
    const a = state.analysis, days = a.kpis.days || 1;
    const id = `${datesFor(+$('#days').value).at(-1)}_${days}d`;
    const sections = [...a.sections.values()].filter(s => s.n >= 5).map(s => ({
      key: s.key, n: s.n, alpha: s.alpha, beta: s.beta, leverage: Math.round(s.leverage * 100) / 100,
      createdMinPerDay: Math.round(s.created / 60 / days * 10) / 10, infraShare: share(s.causeMix),
    }));
    try { await historyDb.collection('history').doc(id).set({ savedAt: new Date().toISOString(), days, trains: a.kpis.trains, sections }); $('#hMsg').textContent = `Saved ${id}`; draw(); }
    catch (e) { $('#hMsg').textContent = 'Save failed: ' + (e.message || e.code); }
  };
  draw();
}
const share = mix => { const t = Object.values(mix).reduce((a, b) => a + b, 0); return t ? Math.round(((mix.infrastructure || 0) + (mix.works || 0)) / t * 100) / 100 : 0; };
function slope(x, y) { const n = x.length, mx = x.reduce((a, b) => a + b) / n, my = y.reduce((a, b) => a + b) / n; let num = 0, den = 0; for (let i = 0; i < n; i++) { num += (x[i] - mx) * (y[i] - my); den += (x[i] - mx) ** 2; } return den ? num / den : 0; }

// ---------- Assumptions ----------
function renderAssumptions() {
  const a = state.assumptions;
  $('#tab-assumptions').innerHTML = `<h3>Assumptions</h3>
    <p class="lead">Every euro figure comes from these values. Change them and all costs, rankings and payback recompute instantly. No re-download is needed.</p>
    <div class="formgrid">
      <label for="aVot">Value of time (€/passenger-hour)</label><input type="number" id="aVot" min="0" step="0.5" value="${a.vot}">
      <label for="aLd">Passengers per long-distance train</label><input type="number" id="aLd" min="0" step="10" value="${a.loads['Long-distance']}">
      <label for="aCm">Passengers per commuter train</label><input type="number" id="aCm" min="0" step="10" value="${a.loads.Commuter}">
      <label for="aFr">Freight delay cost (€/train-minute)</label><input type="number" id="aFr" min="0" step="0.5" value="${a.freightPerMin}">
    </div>
    <div class="toolbar" style="margin-top:12px"><button class="primary" id="aApply">Apply</button><button id="aReset">Reset defaults</button></div>
    <div class="note">The defaults are deliberately conservative placeholders. For a client study, replace them with Väylävirasto's official unit values (yksikköarvot) and observed occupancy data. Confidence intervals come from bootstrap resampling of trains (B=200).</div>`;
  $('#aApply').onclick = () => {
    state.assumptions = { vot: +$('#aVot').value, loads: { 'Long-distance': +$('#aLd').value, Commuter: +$('#aCm').value }, freightPerMin: +$('#aFr').value };
    redrawAll();
  };
  $('#aReset').onclick = () => { state.assumptions = structuredClone(DEFAULT_ASSUMPTIONS); redrawAll(); };
}

// ---------- AI report & templates ----------
async function initReport() {
  state.store = await createTemplateStore();
  state.sampler = await getSampler();
  await loadTemplates();
  renderReport();
}
async function loadTemplates() {
  let custom = [];
  try { custom = await state.store.list(); } catch (e) { console.warn('templates', e); }
  state.templates = [...BUILTIN_TEMPLATES, ...custom.filter(t => t && t.name && Array.isArray(t.sections))];
}
function renderReport(selectedId) {
  const el = $('#tab-report');
  const cur = state.templates.find(t => t.id === selectedId) || state.templates[0];
  const ai = !!state.sampler;
  el.innerHTML = `<h3>AI analyst</h3>
    <p class="lead">Claude reads a compact summary of this analysis (KPIs, top sections, CIs, causes, assumptions) and writes to the template you choose. Templates are ${state.store.shared ? '<b>shared with your team</b>' : 'saved in this browser'}.</p>
    ${ai ? '' : '<div class="note">AI needs the published claude.ai page (Claude runs inside it). Templates and exports still work here.</div>'}
    <div class="toolbar"><input type="text" id="askQ" placeholder="Ask about the data, e.g. Which section should Väylävirasto fix first?" style="flex:1;min-width:200px"><button id="askBtn" ${ai ? '' : 'disabled'}>Ask</button></div>
    <div id="askOut"></div>
    <div class="toolbar" style="margin-top:8px">
      <label>Template <select id="tplSel">${state.templates.map(t => `<option value="${esc(t.id)}" ${t.id === cur.id ? 'selected' : ''}>${esc(t.name)}${t.builtin ? '' : ' ★'}</option>`).join('')}</select></label>
      <button class="primary" id="genBtn" ${ai ? '' : 'disabled'}>Generate report</button>
    </div>
    <div class="toolbar"><button id="tplNew">New template</button><button id="tplDup">Duplicate</button><button id="tplEdit" ${cur.builtin ? 'disabled title="Duplicate a built-in template to edit it"' : ''}>Edit</button><button id="tplDel" ${cur.builtin ? 'disabled' : ''}>Delete</button><button id="tplExp">⬇ Export JSON</button><label class="muted" style="cursor:pointer"><input type="file" id="tplImp" accept="application/json" hidden><span class="chip">⬆ Import JSON</span></label></div>
    <div id="tplForm"></div>
    <div class="muted" style="font-size:12px;margin:6px 0">Sections: ${cur.sections.map(esc).join(' · ')} · ${esc(cur.language)} · ${esc(cur.tone)}</div>
    <div class="report-out" id="repOut">${state.lastReport ? mdToHtml(state.lastReport) : '<p class="muted">The generated report appears here.</p>'}</div>
    <div class="toolbar" style="margin-top:8px"><button id="repMd" ${state.lastReport ? '' : 'disabled'}>⬇ Markdown</button><button id="repHtml" ${state.lastReport ? '' : 'disabled'}>⬇ HTML</button>${IN_ARTIFACT ? '' : `<button id="repPdf" ${state.lastReport ? '' : 'disabled'}>Print / PDF</button>`}<button id="repCopy" ${state.lastReport ? '' : 'disabled'}>Copy</button></div>`;
  const tpl = () => state.templates.find(t => t.id === $('#tplSel').value);
  $('#tplSel').onchange = e => renderReport(e.target.value);
  $('#genBtn').onclick = () => generate(tpl());
  $('#askBtn').onclick = ask; $('#askQ').onkeydown = e => { if (e.key === 'Enter') ask(); };
  $('#tplNew').onclick = () => templateForm({ id: 'tpl-' + Date.now().toString(36), name: 'My template', audience: '', language: 'English', tone: 'Professional', sections: ['Summary', 'Findings', 'Recommendations'], instructions: '' });
  $('#tplDup').onclick = () => { const t = tpl(); templateForm({ ...structuredClone(t), id: 'tpl-' + Date.now().toString(36), name: t.name + ' (copy)', builtin: undefined }); };
  $('#tplEdit').onclick = () => templateForm(structuredClone(tpl()));
  $('#tplDel').onclick = async e => {
    const t = tpl(), b = e.currentTarget;
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = `Confirm delete “${t.name}”`; b.classList.add('primary'); return; }
    await state.store.remove(t.id); await loadTemplates(); renderReport();
  };
  $('#tplExp').onclick = () => download('report-templates.json', JSON.stringify(state.templates.filter(t => !t.builtin), null, 2), 'application/json');
  $('#tplImp').onchange = async e => {
    try {
      const list = JSON.parse(await e.target.files[0].text());
      for (const t of [].concat(list)) if (t?.name && Array.isArray(t.sections)) await state.store.save(sanitizeTpl({ ...t, id: t.id && !t.builtin ? t.id : 'tpl-' + Math.random().toString(36).slice(2, 9) }));
      await loadTemplates(); renderReport();
    } catch (err) { $('#tplForm').innerHTML = `<div class="note">Import failed: ${esc(err.message)}. Choose a JSON file exported from this tool.</div>`; }
  };
  const md = () => state.lastReport, title = () => `Rail delay report – ${tpl().name}`;
  $('#repMd').onclick = () => download('rail-delay-report.md', md(), 'text/markdown');
  $('#repHtml').onclick = () => download('rail-delay-report.html', reportHTML(title(), md()), 'text/html');
  if ($('#repPdf')) $('#repPdf').onclick = () => printReport(title(), md());
  $('#repCopy').onclick = async () => { try { await navigator.clipboard.writeText(md()); $('#repCopy').textContent = 'Copied ✓'; } catch { $('#repCopy').textContent = 'Copy blocked'; } };
}
const sanitizeTpl = t => ({ id: String(t.id).slice(0, 60), name: String(t.name).slice(0, 80), audience: String(t.audience || '').slice(0, 300), language: String(t.language || 'English').slice(0, 40), tone: String(t.tone || '').slice(0, 120), sections: t.sections.map(s => String(s).slice(0, 120)).slice(0, 12), instructions: String(t.instructions || '').slice(0, 2000) });
function templateForm(t) {
  $('#tplForm').innerHTML = `<div class="card tpl-edit">
    <label>Name<input id="fName" value="${esc(t.name)}"></label>
    <label>Audience<input id="fAud" value="${esc(t.audience)}"></label>
    <label>Language<select id="fLang">${['English', 'Swedish', 'Finnish'].map(l => `<option ${l === t.language ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <label>Tone<input id="fTone" value="${esc(t.tone)}"></label>
    <label>Sections (one per line, in order)<textarea id="fSec" rows="5">${esc(t.sections.join('\n'))}</textarea></label>
    <label>Instructions<textarea id="fIns" rows="3">${esc(t.instructions)}</textarea></label>
    <div class="toolbar"><button class="primary" id="fSave">Save template</button><button id="fCancel">Cancel</button><span id="fMsg" class="inline-confirm"></span></div></div>`;
  $('#fCancel').onclick = () => $('#tplForm').innerHTML = '';
  $('#fSave').onclick = async () => {
    const nt = sanitizeTpl({ id: t.id, name: $('#fName').value || 'Untitled', audience: $('#fAud').value, language: $('#fLang').value, tone: $('#fTone').value, sections: $('#fSec').value.split('\n').map(s => s.trim()).filter(Boolean), instructions: $('#fIns').value });
    const msg = t => { $('#fMsg').textContent = t; };
    if (!nt.sections.length) { msg('Add at least one section.'); return; }
    try { await state.store.save(nt); } catch (e) { msg('Could not save: ' + (e.message || e.code)); return; }
    await loadTemplates(); renderReport(nt.id);
  };
}
let aiAbort;
async function generate(t) {
  if (!state.sampler || !state.analysis) return;
  aiAbort?.abort(); aiAbort = new AbortController();
  const out = $('#repOut'); out.innerHTML = '<p class="muted">Thinking…</p>';
  $('#genBtn').disabled = true;
  try {
    const res = await state.sampler(buildPrompt(t, summarise(state.analysis, state.stations, state.assumptions)), {
      signal: aiAbort.signal, modelTier: 'default', cache: false, onText: ({ text }) => { out.innerHTML = mdToHtml(text); },
    });
    state.lastReport = res.text; renderReport(t.id);
  } catch (e) {
    out.innerHTML = `<p class="muted">${e.code === 'not_granted' ? 'AI access was not granted for this page.' : e.code === 'rate_limited' ? 'Rate limited, try again in a minute.' : 'AI error: ' + esc(e.message || e.code)}</p>`;
    $('#genBtn').disabled = false;
  }
}
async function ask() {
  const q = $('#askQ').value.trim(); if (!q || !state.sampler || !state.analysis) return;
  const out = $('#askOut'); out.innerHTML = '<div class="note">Thinking…</div>';
  try {
    await state.sampler(buildQuestionPrompt(q, summarise(state.analysis, state.stations, state.assumptions)), {
      modelTier: 'quick', cache: false, onText: ({ text }) => { out.innerHTML = `<div class="report-out">${mdToHtml(text)}</div>`; },
    });
  } catch (e) { out.innerHTML = `<div class="note">${esc(e.code === 'rate_limited' ? 'Rate limited, try again shortly.' : 'AI error: ' + (e.message || e.code))}</div>`; }
}

// ---------- snapshot mode (hosts that block outside requests) ----------
async function loadSnapshot() {
  const res = await fetch('data/snapshot.json'); if (!res.ok) throw new Error('no snapshot');
  const snap = await res.json();
  snap.analysis.sections = new Map(snap.analysis.sections); snap.analysis.stations = new Map(snap.analysis.stations);
  state.snapshot = snap; state.stations = new Map(snap.stations); state.causeNames = new Map(snap.causeNames);
  const d = new Date(snap.dates[0] + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  $('.period').classList.add('hidden');
  const b = $('#snapBadge'); b.textContent = `Snapshot · ${d}`; b.title = 'This host blocks live requests, so the page shows a pre-analysed day. Run the repo locally for live data.'; b.classList.remove('hidden');
}

// ---------- home ----------
function renderHome() {
  const a = state.analysis; if (!a) return;
  const k = a.kpis, days = k.days || 1, c = costOf(a, state.assumptions);
  const cb = a.causes.byBucket, tot = Object.values(cb).reduce((x, y) => x + y, 0) || 1;
  const addr = ((cb.infrastructure || 0) + (cb.works || 0) + (cb.capacity || 0)) / tot * 100;
  const dates = state.snapshot ? state.snapshot.dates : datesFor(+$('#days').value);
  $('#heroDate').textContent = dates.length > 1 ? `${dates.at(-1)} – ${dates[0]}` : dates[0];
  const vals = [nf0.format(k.trains), nf1.format(k.onTimePct) + '%', eur(c.eur / days * 365), nf0.format(addr) + '%'];
  document.querySelectorAll('#heroStats .hv').forEach((el, i) => { el.textContent = vals[i]; el.classList.remove('skeleton'); });
  $('#homeOpps').innerHTML = rankOpportunities(a, state.assumptions, 3).map(({ s, eurPerDay }, i) => {
    const iv = interventionFor(s);
    return `<a class="oc" href="#dashboard" data-key="${esc(s.key)}"><span class="rank">0${i + 1}</span><h3>${esc(secName(s))}</h3>
      <div class="eur">${eur(eurPerDay * 365)}<small> / yr est.</small></div>
      <div class="chips"><span class="chip ${s.beta > 1.05 ? 'amp' : ''}">β ${num(s.beta)}</span><span class="chip">α ${s.alpha == null ? '–' : num(s.alpha, 0) + ' s'}</span><span class="chip">${s.n} runs</span></div>
      <div class="fix"><b>${esc(iv.fix)}</b><br>${esc(iv.service)}</div></a>`;
  }).join('');
  document.querySelectorAll('#homeOpps .oc').forEach(el => el.onclick = () => { pendingSelect = el.dataset.key; });
  startHero();
}
let pendingSelect = null;

// Hero: the real network drawn from today's sections, with trains pulsing along the costliest ones.
let heroRaf;
function startHero() {
  cancelAnimationFrame(heroRaf);
  const cv = $('#heroCanvas'), a = state.analysis; if (!cv || !a) return;
  const ctx = cv.getContext('2d'), dpr = Math.min(2, devicePixelRatio || 1);
  const W = cv.clientWidth, H = cv.clientHeight; if (!W || !H) return;
  cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const segs = [...a.sections.values()].map(s => [s, state.stations.get(s.from), state.stations.get(s.to)]).filter(([, A, B]) => A && B);
  if (!segs.length) return;
  // Equirectangular projection, Finland placed on the right side of the hero.
  const lat0 = 59.6, lat1 = 68.2, lon0 = 20.5, lon1 = 31.8, k = Math.cos(64 * Math.PI / 180);
  const aspect = ((lon1 - lon0) * k) / (lat1 - lat0), mapH = Math.min(H * 0.94, (W > 860 ? W * 0.4 : W * 0.9) / aspect), mapW = mapH * aspect;
  const ox = W > 860 ? W - mapW - Math.max(24, (W - 1160) / 2) : (W - mapW) / 2, oy = (H - mapH) / 2;
  const P = (lat, lon) => [ox + (lon - lon0) * k / ((lon1 - lon0) * k) * mapW, oy + (lat1 - lat) / (lat1 - lat0) * mapH];
  const rule = cssVar('--rule'), ink = cssVar('--muted'), red = cssVar('--red');
  const days = a.kpis.days || 1;
  const hot = segs.map(([s, A, B]) => ({ s, A: P(A.lat, A.lon), B: P(B.lat, B.lon), e: sectionCost(s, state.assumptions) / days })).sort((x, y) => y.e - x.e);
  const top = hot.slice(0, 40), maxE = top[0]?.e || 1;
  const pulses = Array.from({ length: 70 }, (_, i) => ({ seg: hot[Math.floor(Math.random() * Math.min(hot.length, 400))], t: Math.random(), v: 0.002 + Math.random() * 0.004 }));
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches || W < 520;
  const frame = () => {
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = 'round';
    ctx.strokeStyle = W < 860 ? rule : ink; ctx.globalAlpha = W < 860 ? 0.6 : 0.55; ctx.lineWidth = 1.4;
    ctx.beginPath(); for (const h of hot) { ctx.moveTo(...h.A); ctx.lineTo(...h.B); } ctx.stroke();
    ctx.globalAlpha = W < 860 ? 0.35 : 0.9; ctx.strokeStyle = red;
    for (const h of top) { ctx.lineWidth = 1.5 + 4 * Math.sqrt(h.e / maxE); ctx.beginPath(); ctx.moveTo(...h.A); ctx.lineTo(...h.B); ctx.stroke(); }
    if (!still) {
      ctx.fillStyle = cssVar('--ink'); ctx.globalAlpha = W < 860 ? 0.3 : 0.75;
      for (const p of pulses) {
        p.t += p.v; if (p.t > 1) { p.t = 0; p.seg = hot[Math.floor(Math.random() * Math.min(hot.length, 400))]; }
        const x = p.seg.A[0] + (p.seg.B[0] - p.seg.A[0]) * p.t, y = p.seg.A[1] + (p.seg.B[1] - p.seg.A[1]) * p.t;
        ctx.beginPath(); ctx.arc(x, y, 1.8, 0, 7); ctx.fill();
      }
      heroRaf = requestAnimationFrame(frame);
    }
    ctx.globalAlpha = 1;
  };
  frame();
}
addEventListener('resize', () => { clearTimeout(startHero.t); startHero.t = setTimeout(startHero, 200); });

// ---------- views (hash routing) ----------
function route() {
  const v = location.hash === '#dashboard' ? 'dashboard' : 'home';
  if (location.hash === '#method') { $('#view-home').classList.remove('hidden'); return; }
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('hidden', el.id !== 'view-' + v));
  document.querySelectorAll('.views a').forEach(a => a.classList.toggle('on', a.dataset.view === v));
  if (v === 'dashboard') {
    cancelAnimationFrame(heroRaf);
    setTimeout(() => { map.invalidateSize(); if (pendingSelect) { selectSection(pendingSelect); pendingSelect = null; } }, 50);
    scrollTo(0, 0);
  } else startHero();
}
addEventListener('hashchange', route);
document.querySelectorAll('[data-tab-link]').forEach(a => a.addEventListener('click', () => setTimeout(() => document.querySelector(`#tabs [data-tab=${a.dataset.tabLink}]`)?.click(), 60)));

// ---------- tabs ----------
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab));
  if (b.dataset.tab === 'whatif' && state.analysis) renderWhatIf();
});

// ---------- boot ----------
(async function boot() {
  route(); drawLegend(); renderKPIs(true);
  setStatus('Loading stations…');
  try { if (new URLSearchParams(location.search).has('snapshot')) throw new Error('snapshot requested'); state.stations = await loadStations(); }
  catch (e) {
    try { await loadSnapshot(); }
    catch { setStatus(e.message, true); $('#tab-opps').innerHTML = `<div class="note">Cannot reach digitraffic.fi: ${esc(e.message)}</div>`; return; }
  }
  if (!state.snapshot) loadCauseNames().then(m => { state.causeNames = m; if (state.analysis) renderCauses(); }).catch(() => { });
  initReport().catch(e => console.warn('report init', e));
  startLive();
  runAnalysis();
})();
