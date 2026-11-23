import { test, assert, eq } from './harness.js';
import { toCSV } from '../src/export.js';
import { BUILTIN_TEMPLATES, buildPrompt, summarise, interventionFor } from '../src/report.js';
import { analyseDays } from '../src/analysis.js';
import { currentDelay } from '../src/data.js';

test('toCSV escapes commas, quotes and newlines', () => {
  const csv = toCSV([{ a: 'x,y', b: 'say "hi"', c: 'l1\nl2', d: 3 }]);
  eq(csv, 'a,b,c,d\n"x,y","say ""hi""","l1\nl2",3');
});

test('toCSV on empty rows gives empty string', () => { eq(toCSV([]), ''); });

test('four built-in templates with required fields', () => {
  eq(BUILTIN_TEMPLATES.length, 4);
  for (const t of BUILTIN_TEMPLATES) for (const f of ['id', 'name', 'audience', 'language', 'tone', 'sections', 'instructions']) assert(t[f] != null, `${t.id} missing ${f}`);
});

test('buildPrompt includes every section heading and the language', () => {
  const t = { ...BUILTIN_TEMPLATES[0], language: 'Swedish', sections: ['Sammanfattning', 'Rekommendation'] };
  const p = buildPrompt(t, { kpis: {} });
  assert(p.includes('Sammanfattning') && p.includes('Rekommendation'), 'sections missing');
  assert(p.includes('Swedish'), 'language missing');
});

const T = (n, delays) => ({
  trainNumber: n, departureDate: '2026-11-23', trainCategory: 'Commuter', cancelled: false,
  timeTableRows: delays.map((d, i) => {
    const sched = Date.UTC(2026, 10, 23, 8, i * 5);
    return { type: i % 2 ? 'ARRIVAL' : 'DEPARTURE', stationShortCode: 'S' + Math.ceil(i / 2), cancelled: false,
      scheduledTime: new Date(sched).toISOString(), actualTime: new Date(sched + d * 1000).toISOString(), causes: [] };
  }),
});

test('summarise stays compact and lists top sections', () => {
  const trains = [];
  for (let n = 0; n < 300; n++) trains.push(T(n, [0, 30 + (n % 7) * 10, 40, 200 + n % 50, 210, 100]));
  const a = analyseDays(trains, { B: 20 });
  const s = summarise(a, new Map());
  const json = JSON.stringify(s);
  assert(json.length < 8000, 'summary too long: ' + json.length);
  assert(s.topSections.length > 0 && s.topSections.length <= 10, 'top sections');
  assert(s.kpis.trains === 300, 'kpis carried');
});

test('summarise on empty analysis has no NaN', () => {
  const s = summarise(analyseDays([]), new Map());
  assert(!JSON.stringify(s).includes('NaN') && !JSON.stringify(s).includes('null,null'), 'NaN in summary');
});

test('interventionFor maps capacity signature to passing loop / double track', () => {
  const i = interventionFor({ beta: 1.2, causeMix: { capacity: 5 }, n: 20 });
  assert(/double|passing/i.test(i.fix), i.fix);
});

test('currentDelay uses last actual row', () => {
  eq(currentDelay(T(1, [0, 60, 120])), 120);
  eq(currentDelay({ timeTableRows: [{ scheduledTime: '2026-01-01T00:00:00Z' }] }), null);
});
