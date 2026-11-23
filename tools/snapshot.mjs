// Build a static snapshot for hosts that block outside requests (e.g. claude.ai artifacts).
// Usage: python3 tools/fetch_snapshot_inputs.py DIR && jsc -m tools/snapshot.mjs -- DIR > data/snapshot.json
import { analyseDays } from '../src/analysis.js';
const dir = arguments[0];
const J = f => JSON.parse(readFile(`${dir}/${f}`));
const meta = J('meta.json');
const trains = meta.dates.flatMap(d => J(`trains-${d}.json`));
const a = analyseDays(trains);
const stations = J('stations.json').map(s => [s.stationShortCode, { name: s.stationName.replace(/ asema$/, ''), lat: s.latitude, lon: s.longitude, passenger: s.passengerTraffic }]);
const causeNames = J('causes.json').map(c => [c.detailedCategoryCode, c.detailedCategoryName]);
const live = J('live.json');
const today = J('today.json');
const cur = t => { const r = [...t.timeTableRows].reverse().find(r => r.actualTime && !r.cancelled); return r ? (Date.parse(r.actualTime) - Date.parse(r.scheduledTime)) / 1000 : null; };
const liveDelays = Object.fromEntries(today.map(t => [t.trainNumber, { type: t.trainType, d: cur(t) }]));
const out = {
  generatedAt: meta.generatedAt, dates: meta.dates, stations, causeNames, live, liveDelays,
  analysis: { ...a, sections: [...a.sections.entries()], stations: [...a.stations.entries()] },
};
print(JSON.stringify(out));
