// Rail Delay Intelligence: analysis core. Pure functions, no dependencies, browser + jsc compatible.
// All delays are in SECONDS, computed as actualTime - scheduledTime from the ISO strings.

export const DEFAULT_ASSUMPTIONS = Object.freeze({
  vot: 15, // EUR per passenger-hour
  loads: Object.freeze({ 'Long-distance': 250, Commuter: 150 }), // passengers per train
  freightPerMin: 2, // EUR per delay-minute, trainCategory "Cargo"
});

export const EXCLUDED_CATEGORIES = new Set(['Shunting', 'Locomotive', 'On-track machines', 'Test drive']);
export const ON_TIME_SEC = 180;
const MIN_N_FOR_BETA = 5;
const THEIL_SEN_MAX_PAIRS = 1500; // same pair budget for the point fit and every bootstrap replicate
const BETA_MAX = 1.5;
const LEVERAGE_CAP = 3.0;
const DIST_EDGES_MIN = [0, 1, 3, 5, 10, 20]; // bins: <0, 0-1, 1-3, 3-5, 5-10, 10-20, 20+
const DIST_LABELS = ['<0', '0-1', '1-3', '3-5', '5-10', '10-20', '20+'];

// ---------- utilities ----------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function median(arr) {
  if (!arr.length) return NaN;
  const s = Float64Array.from(arr).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// ---------- cause classification ----------
export function classifyCause(code) {
  if (!code || typeof code !== 'string') return 'other';
  const c = code.toUpperCase();
  if (c === 'P1' || c === 'S1' || c === 'S2' || /^T[1-3]$/.test(c)) return 'infrastructure';
  if (/^R[1-4]$/.test(c)) return 'works';
  if (c === 'L2' || c === 'L3') return 'capacity';
  if (/^[KVJM]/.test(c)) return 'operator';
  return 'other';
}

// ---------- statistics ----------
// Theil-Sen: median of pairwise slopes. Exact for n <= ~110 (all pairs <= maxPairs),
// otherwise a seeded random sample of maxPairs pairs, so cost stays bounded.
export function theilSen(xs, ys, maxPairs = 5000, rng) {
  const n = xs.length;
  if (n < 2) return { alpha: n ? ys[0] : NaN, beta: null };
  const slopes = [];
  const total = n * (n - 1) / 2;
  if (total <= maxPairs) {
    for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) {
      const dx = xs[j] - xs[i];
      if (dx !== 0) slopes.push((ys[j] - ys[i]) / dx);
    }
  } else {
    const r = rng || mulberry32(12345);
    for (let k = 0; k < maxPairs; k++) {
      const i = Math.floor(r() * n); let j = Math.floor(r() * (n - 1)); if (j >= i) j++;
      const dx = xs[j] - xs[i];
      if (dx !== 0) slopes.push((ys[j] - ys[i]) / dx);
    }
  }
  if (!slopes.length) return { alpha: median(ys), beta: null };
  const beta = median(slopes);
  const alpha = median(ys.map((y, i) => y - beta * xs[i]));
  return { alpha, beta };
}

// Percentile bootstrap; statFn(resampledItems) -> number | null/NaN (ignored). 95% CI.
export function bootstrap(items, statFn, B = 200, rng = mulberry32(1)) {
  const n = items.length;
  if (!n) return { lo: 0, hi: 0 };
  const stats = [];
  const buf = new Array(n);
  for (let b = 0; b < B; b++) {
    for (let i = 0; i < n; i++) buf[i] = items[Math.floor(rng() * n)];
    const v = statFn(buf);
    if (typeof v === 'number' && Number.isFinite(v)) stats.push(v);
  }
  if (!stats.length) return { lo: NaN, hi: NaN };
  stats.sort((a, b) => a - b);
  return { lo: quantile(stats, 0.025), hi: quantile(stats, 0.975) };
}

// Empirical-Bayes shrinkage: (n*m + k*g)/(n+k). k defaults to the median n.
export function shrink(means, ns, globalMean, k) {
  const kk = k == null ? median(ns) : k;
  return means.map((m, i) => (ns[i] + kk) > 0 ? (ns[i] * m + kk * globalMean) / (ns[i] + kk) : globalMean);
}

// ---------- extraction ----------
const delaySec = row => (Date.parse(row.actualTime) - Date.parse(row.scheduledTime)) / 1000;
const codesOf = row => (row.causes || []).map(c => c.detailedCategoryCode || c.categoryCode).filter(Boolean);

// Walk valid rows (not cancelled, with actualTime). A run is DEPARTURE(A) -> next ARRIVAL(B);
// a dwell is ARRIVAL(X) -> DEPARTURE(X).
export function extractRuns(train) {
  const runs = [], dwells = [];
  let pending = null, lastArr = null, finalDelay = null;
  for (const row of train.timeTableRows || []) {
    if (row.cancelled || !row.actualTime || !row.scheduledTime) continue;
    const d = delaySec(row);
    if (!Number.isFinite(d)) continue;
    if (row.type === 'DEPARTURE') {
      if (lastArr && lastArr.st === row.stationShortCode) {
        dwells.push({ st: row.stationShortCode, gain: d - lastArr.d, causes: codesOf(row) });
      }
      pending = { st: row.stationShortCode, d };
    } else if (row.type === 'ARRIVAL') {
      if (pending) {
        runs.push({ from: pending.st, to: row.stationShortCode, dIn: pending.d, dOut: d, gain: d - pending.d, causes: codesOf(row) });
        pending = null;
      }
      lastArr = { st: row.stationShortCode, d };
      finalDelay = d;
    }
  }
  return { runs, dwells, finalDelay };
}

// ---------- cost ----------
const isPax = (cat, a) => a.loads[cat] != null;
function trainCost(cat, finalDelay, a) {
  if (finalDelay == null || finalDelay <= 0) return { eur: 0, paxHours: 0 };
  if (isPax(cat, a)) { const ph = finalDelay / 3600 * a.loads[cat]; return { eur: ph * a.vot, paxHours: ph }; }
  if (cat === 'Cargo') return { eur: finalDelay / 60 * a.freightPerMin, paxHours: 0 };
  return { eur: 0, paxHours: 0 };
}

// Overall cost of final-arrival delay (>= 0) with a bootstrap CI over trains.
export function costOf(analysis, assumptions = DEFAULT_ASSUMPTIONS, rng = mulberry32(1)) {
  const a = { ...DEFAULT_ASSUMPTIONS, ...assumptions };
  const recs = analysis.trainRecs || [];
  const sum = list => { let e = 0; for (const r of list) e += trainCost(r.cat, r.finalDelay, a).eur; return e; };
  let eur = 0, paxHours = 0;
  for (const r of recs) { const c = trainCost(r.cat, r.finalDelay, a); eur += c.eur; paxHours += c.paxHours; }
  if (!recs.length) return { eur: 0, lo: 0, hi: 0, paxHours: 0 };
  const { lo, hi } = bootstrap(recs, sum, 200, rng);
  return { eur, lo, hi, paxHours };
}

// EUR of delay created on a section: sum of positive gains x train load x VoT (+ freight).
export function sectionCost(section, assumptions = DEFAULT_ASSUMPTIONS) {
  const a = { ...DEFAULT_ASSUMPTIONS, ...assumptions };
  let eur = 0;
  for (const cat in section.createdByCat) {
    const sec = section.createdByCat[cat];
    if (isPax(cat, a)) eur += sec / 3600 * a.loads[cat] * a.vot;
    else if (cat === 'Cargo') eur += sec / 60 * a.freightPerMin;
  }
  return eur;
}

// ---------- main analysis ----------
export function analyseDays(trains, opts = {}) {
  const assumptions = { ...DEFAULT_ASSUMPTIONS, ...(opts.assumptions || {}) };
  const rng = opts.rng || mulberry32(opts.seed != null ? opts.seed : 42);
  const B = opts.B || 200;

  const sections = new Map(), stationAcc = new Map();
  const causes = { byBucket: {}, byCode: {} };
  const trainRecs = [], seqs = []; // seqs: per train, array of Section objects in route order
  const dates = new Set();
  const finals = [];
  let createdRun = 0, createdDwell = 0, recoveredRun = 0, recoveredDwell = 0;
  const distCounts = new Array(DIST_LABELS.length).fill(0);

  const bump = (obj, k) => { obj[k] = (obj[k] || 0) + 1; };
  const station = code => {
    let s = stationAcc.get(code);
    if (!s) stationAcc.set(code, s = { code, n: 0, sumArr: 0, dwellCreated: 0 });
    return s;
  };
  const countCauses = (codes, mix) => {
    for (const c of codes) { const b = classifyCause(c); bump(causes.byBucket, b); bump(causes.byCode, c); if (mix) bump(mix, b); }
  };

  for (const t of trains || []) {
    if (!t || t.cancelled || EXCLUDED_CATEGORIES.has(t.trainCategory)) continue;
    const { runs, dwells, finalDelay } = extractRuns(t);
    if (finalDelay == null) continue;
    if (t.departureDate) dates.add(t.departureDate);
    const cat = t.trainCategory;
    trainRecs.push({ cat, finalDelay });
    finals.push(finalDelay);
    const fm = finalDelay / 60;
    let bin = DIST_EDGES_MIN.findIndex(e => fm < e);
    distCounts[bin < 0 ? DIST_LABELS.length - 1 : bin]++;

    const seq = [];
    for (const r of runs) {
      const key = `${r.from}-${r.to}`;
      let s = sections.get(key);
      if (!s) sections.set(key, s = {
        key, from: r.from, to: r.to, n: 0, created: 0, recovered: 0, createdByCat: {}, causeMix: {},
        alpha: null, beta: null, betaCI: null, shrunkMean: 0, leverage: 0, eur: 0, eurPerDay: 0,
        geometry: { from: r.from, to: r.to }, _xs: [], _ys: [],
      });
      s.n++; s._xs.push(r.dIn); s._ys.push(r.dOut);
      if (r.gain > 0) { s.created += r.gain; s.createdByCat[cat] = (s.createdByCat[cat] || 0) + r.gain; createdRun += r.gain; }
      else { s.recovered -= r.gain; recoveredRun -= r.gain; }
      countCauses(r.causes, s.causeMix);
      const st = station(r.to); st.n++; st.sumArr += r.dOut;
      seq.push(s);
    }
    for (const w of dwells) {
      if (w.gain > 0) { createdDwell += w.gain; station(w.st).dwellCreated += w.gain; } else recoveredDwell -= w.gain;
      countCauses(w.causes, null);
    }
    seqs.push(seq);
  }

  // Per-section transfer function with bootstrap CI.
  const all = [...sections.values()];
  for (const s of all) {
    if (s.n >= MIN_N_FOR_BETA) {
      const fit = theilSen(s._xs, s._ys, THEIL_SEN_MAX_PAIRS);
      s.alpha = fit.alpha; s.beta = fit.beta;
      if (s.beta != null) {
        const idx = s._xs.map((_, i) => i);
        const fitRng = mulberry32(Math.floor(rng() * 4294967296)); // per-section stream, advances across replicates
        s.betaCI = bootstrap(idx, ix => theilSen(ix.map(i => s._xs[i]), ix.map(i => s._ys[i]), THEIL_SEN_MAX_PAIRS, fitRng).beta, B, rng);
      }
    }
  }

  // Empirical-Bayes shrinkage of mean created per run toward the network mean.
  const totalRuns = all.reduce((a, s) => a + s.n, 0);
  const globalMean = totalRuns ? createdRun / totalRuns : 0;
  const shr = shrink(all.map(s => s.created / s.n), all.map(s => s.n), globalMean, all.length ? median(all.map(s => s.n)) : 0);
  all.forEach((s, i) => { s.shrunkMean = shr[i]; });

  // Knock-on leverage, O(total runs): per train, backward recursion
  // L_i = beta_{i+1} * (1 + L_{i+1}) = sum_k prod_{j=i+1..k} beta_j (uncapped), then cap the sum.
  // beta clipped to [0, 1.5]; sections without a fitted beta use the network median beta.
  const fitted = all.filter(s => s.beta != null).map(s => Math.min(BETA_MAX, Math.max(0, s.beta)));
  const fallbackBeta = fitted.length ? median(fitted) : 0.5;
  const betaOf = s => s.beta == null ? fallbackBeta : Math.min(BETA_MAX, Math.max(0, s.beta));
  const levSum = new Map(), levN = new Map();
  for (const seq of seqs) {
    let L = 0; // leverage of the section after the current one
    for (let i = seq.length - 1; i >= 0; i--) {
      const s = seq[i];
      const cur = i === seq.length - 1 ? 0 : betaOf(seq[i + 1]) * (1 + L);
      levSum.set(s, (levSum.get(s) || 0) + Math.min(LEVERAGE_CAP, cur));
      levN.set(s, (levN.get(s) || 0) + 1);
      L = cur;
    }
  }
  const days = Math.max(1, dates.size);
  for (const s of all) {
    s.leverage = levN.get(s) ? levSum.get(s) / levN.get(s) : 0;
    s.eur = sectionCost(s, assumptions);
    s.eurPerDay = s.eur / days;
    delete s._xs; delete s._ys;
  }

  const stations = new Map();
  for (const [code, a] of stationAcc) stations.set(code, { code, n: a.n, meanArrDelay: a.n ? a.sumArr / a.n : 0, dwellCreated: a.dwellCreated });

  const nT = finals.length;
  const sortedF = finals.slice().sort((a, b) => a - b);
  const kpis = {
    trains: nT, days: nT ? days : 0,
    onTimePct: nT ? 100 * finals.filter(d => d <= ON_TIME_SEC).length / nT : 0,
    meanFinalDelayMin: nT ? finals.reduce((a, b) => a + b, 0) / nT / 60 : 0,
    medianFinalDelayMin: nT ? quantile(sortedF, 0.5) / 60 : 0,
    p90FinalDelayMin: nT ? quantile(sortedF, 0.9) / 60 : 0,
    createdMin: (createdRun + createdDwell) / 60, recoveredMin: (recoveredRun + recoveredDwell) / 60,
    createdRunMin: createdRun / 60, createdDwellMin: createdDwell / 60,
  };
  const dist = DIST_LABELS.map((label, i) => ({ label, n: distCounts[i] }));
  return { kpis, sections, stations, causes, dist, trainRecs, assumptions };
}
