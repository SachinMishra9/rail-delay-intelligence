import { test, assert, eq, approx } from './harness.js';
import {
  extractRuns, theilSen, bootstrap, shrink, analyseDays, costOf, sectionCost,
  classifyCause, mulberry32, DEFAULT_ASSUMPTIONS,
} from '../src/analysis.js';

const row = (type, st, sched, act, extra = {}) =>
  ({ type, stationShortCode: st, scheduledTime: sched, actualTime: act, cancelled: false, trainStopping: true, ...extra });

// A -> B -> C. Departs A +60s, arrives B +150s (gain 90), dwells (dep B +120s: gain -30),
// arrives C +300s (gain 180).
const T = (n, cat = 'Long-distance', extra = {}) => ({
  trainNumber: n, departureDate: '2026-11-23', trainCategory: cat, trainType: 'IC', cancelled: false,
  timeTableRows: [
    row('DEPARTURE', 'A', '2026-11-23T10:00:00.000Z', '2026-11-23T10:01:00.000Z'),
    row('ARRIVAL', 'B', '2026-11-23T10:10:00.000Z', '2026-11-23T10:12:30.000Z', { causes: [{ categoryCode: 'P', detailedCategoryCode: 'P1' }] }),
    row('DEPARTURE', 'B', '2026-11-23T10:12:00.000Z', '2026-11-23T10:14:00.000Z'),
    row('ARRIVAL', 'C', '2026-11-23T10:30:00.000Z', '2026-11-23T10:35:00.000Z'),
  ], ...extra,
});

test('classifyCause buckets', () => {
  eq(classifyCause('P1'), 'infrastructure'); eq(classifyCause('S2'), 'infrastructure');
  eq(classifyCause('T3'), 'infrastructure'); eq(classifyCause('R2'), 'works');
  eq(classifyCause('L3'), 'capacity'); eq(classifyCause('K2'), 'operator');
  eq(classifyCause('V1'), 'operator'); eq(classifyCause('Z9'), 'other'); eq(classifyCause(undefined), 'other');
});

test('theilSen robust to an outlier', () => {
  const xs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], ys = xs.map(x => 2 + 0.5 * x);
  ys[5] = 100;
  const { alpha, beta } = theilSen(xs, ys);
  approx(beta, 0.5, 0.01); approx(alpha, 2, 0.05);
});

test('mulberry32 is deterministic and in [0,1)', () => {
  const a = mulberry32(7), b = mulberry32(7);
  for (let i = 0; i < 20; i++) { const x = a(); eq(x, b()); assert(x >= 0 && x < 1); }
});

test('shrink pulls small samples toward global mean', () => {
  const out = shrink([10, 10], [1, 99], 0, 10);
  approx(out[0], 10 * 1 / 11, 1e-9); approx(out[1], 990 / 109, 1e-9);
});

test('bootstrap CI brackets the mean', () => {
  const items = Array.from({ length: 100 }, (_, i) => i);
  const { lo, hi } = bootstrap(items, a => a.reduce((s, x) => s + x, 0) / a.length, 200, mulberry32(1));
  assert(lo < 49.5 && hi > 49.5 && lo > 40 && hi < 59);
});

test('extractRuns exact gains', () => {
  const { runs, dwells, finalDelay } = extractRuns(T(1));
  eq(runs.length, 2);
  eq(runs[0], { from: 'A', to: 'B', dIn: 60, dOut: 150, gain: 90, causes: ['P1'] });
  eq(runs[1].from, 'B'); eq(runs[1].to, 'C'); eq(runs[1].dIn, 120); eq(runs[1].dOut, 300); eq(runs[1].gain, 180);
  eq(dwells.length, 1); eq(dwells[0].st, 'B'); eq(dwells[0].gain, -30);
  eq(finalDelay, 300);
});

test('extractRuns handles a run across midnight', () => {
  const t = { trainCategory: 'Commuter', cancelled: false, timeTableRows: [
    row('DEPARTURE', 'A', '2026-11-23T23:58:00.000Z', '2026-11-23T23:59:00.000Z'),
    row('ARRIVAL', 'B', '2026-11-24T00:04:00.000Z', '2026-11-24T00:07:00.000Z'),
  ] };
  const { runs, finalDelay } = extractRuns(t);
  eq(runs[0].dIn, 60); eq(runs[0].dOut, 180); eq(runs[0].gain, 120); eq(finalDelay, 180);
});

test('extractRuns skips cancelled rows and rows without actualTime', () => {
  const t = T(2);
  t.timeTableRows[1].cancelled = true;
  const { runs } = extractRuns(t);
  eq(runs.length, 1); eq(runs[0].from, 'B');
  const u = T(3); delete u.timeTableRows[3].actualTime;
  const r = extractRuns(u);
  eq(r.runs.length, 1); eq(r.finalDelay, 150);
});

test('analyseDays([]) has zero trains and no NaN', () => {
  const a = analyseDays([]);
  eq(a.kpis.trains, 0); eq(a.sections.size, 0);
  assert(!JSON.stringify(a.kpis).includes('null') && !/NaN/.test(JSON.stringify(a.kpis)));
  for (const v of Object.values(a.kpis)) assert(Number.isFinite(v), 'kpi finite');
  const c = costOf(a, DEFAULT_ASSUMPTIONS, mulberry32(1));
  eq(c.eur, 0); eq(c.lo, 0); eq(c.hi, 0);
});

test('excluded categories and cancelled trains are dropped', () => {
  const trains = [T(1), T(2, 'Shunting'), T(3, 'Locomotive'), T(4, 'On-track machines'), T(5, 'Test drive'), T(6, 'Long-distance', { cancelled: true })];
  eq(analyseDays(trains).kpis.trains, 1);
});

test('section with n=3 has beta=null; n>=5 gets beta and CI', () => {
  const a3 = analyseDays([T(1), T(2), T(3)]);
  const s = a3.sections.get('A-B');
  eq(s.n, 3); eq(s.beta, null); eq(s.betaCI, null);
  const trains = [];
  for (let i = 0; i < 12; i++) {
    const t = T(i);
    const extra = i * 20;
    t.timeTableRows[0].actualTime = new Date(Date.parse(t.timeTableRows[0].scheduledTime) + extra * 1000).toISOString();
    t.timeTableRows[1].actualTime = new Date(Date.parse(t.timeTableRows[1].scheduledTime) + (30 + 0.5 * extra) * 1000).toISOString();
    trains.push(t);
  }
  const s12 = analyseDays(trains).sections.get('A-B');
  approx(s12.beta, 0.5, 1e-6); approx(s12.alpha, 30, 1e-6);
  assert(s12.betaCI && s12.betaCI.lo <= 0.5 + 1e-9 && s12.betaCI.hi >= 0.5 - 1e-9);
});

test('analyseDays KPIs, sections, stations, causes, dist, cost', () => {
  const a = analyseDays([T(1), T(2, 'Cargo')]);
  eq(a.kpis.trains, 2); eq(a.kpis.onTimePct, 0);
  approx(a.kpis.meanFinalDelayMin, 5, 1e-9);
  const ab = a.sections.get('A-B');
  eq(ab.created, 180); eq(ab.recovered, 0); eq(ab.causeMix, { infrastructure: 2 });
  eq(ab.from, 'A'); eq(ab.to, 'B');
  eq(a.sections.get('B-C').created, 360);
  eq(a.stations.get('B').dwellCreated, 0); eq(a.stations.get('B').n, 2); approx(a.stations.get('B').meanArrDelay, 150, 1e-9);
  eq(a.causes.byBucket.infrastructure, 2); eq(a.causes.byCode.P1, 2);
  eq(a.dist.map(d => d.n), [0, 0, 0, 0, 2, 0, 0]);   // 5 min final delay -> 5-10 bin
  // Section cost: A-B gains 90 s/train; LD 250 pax, cargo 2 EUR/min
  approx(sectionCost(ab, DEFAULT_ASSUMPTIONS), 90 / 3600 * 250 * 15 + 1.5 * 2, 1e-9);
  approx(ab.eurPerDay, sectionCost(ab, DEFAULT_ASSUMPTIONS), 1e-9);
  const c = costOf(a, DEFAULT_ASSUMPTIONS, mulberry32(3));
  approx(c.eur, 300 / 3600 * 250 * 15 + 5 * 2, 1e-9);
  approx(c.paxHours, 300 / 3600 * 250, 1e-9);
  assert(c.lo <= c.eur + 1e-9 && c.hi >= c.eur - 1e-9);
});

test('leverage uses downstream beta products (capped) and is efficient', () => {
  // chain A-B-C-D-E, each section beta=1 by construction (out = in + 10), 10 trains with varying delay
  const mk = (n, d0) => {
    const rows = []; const sts = ['A', 'B', 'C', 'D', 'E'];
    for (let i = 0; i < 4; i++) {
      const tIn = Date.parse('2026-11-23T10:00:00Z') + i * 600000;
      rows.push(row('DEPARTURE', sts[i], new Date(tIn).toISOString(), new Date(tIn + (d0 + i * 10) * 1000).toISOString()));
      rows.push(row('ARRIVAL', sts[i + 1], new Date(tIn + 300000).toISOString(), new Date(tIn + 300000 + (d0 + (i + 1) * 10) * 1000).toISOString()));
    }
    return { trainNumber: n, trainCategory: 'Commuter', cancelled: false, departureDate: '2026-11-23', timeTableRows: rows };
  };
  const trains = Array.from({ length: 10 }, (_, i) => mk(i, i * 30));
  const a = analyseDays(trains);
  // betas are all 1; section A-B has 3 downstream sections: 1+1+1 = 3 (cap 3); C-D has 1; D-E has 0
  approx(a.sections.get('A-B').leverage, 3, 1e-6);
  approx(a.sections.get('C-D').leverage, 1, 1e-6);
  approx(a.sections.get('D-E').leverage, 0, 1e-6);
});
