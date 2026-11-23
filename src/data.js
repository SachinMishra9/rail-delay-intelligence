// Data layer: Fintraffic / digitraffic.fi open rail API (CC BY 4.0). No key needed.
export const API = 'https://rata.digitraffic.fi/api/v1';
const HEADERS = { 'Digitraffic-User': 'rail-delay-intelligence-demo' };
const dayCache = new Map();

async function getJSON(path) {
  let res;
  try { res = await fetch(API + path, { headers: HEADERS }); }
  catch (e) { throw new Error(`Network error reaching digitraffic.fi (${path}): ${e.message}`); }
  if (!res.ok) throw new Error(`digitraffic.fi returned ${res.status} for ${path}`);
  return res.json();
}

/** Map<code,{name,lat,lon,passenger}> */
export async function loadStations() {
  const list = await getJSON('/metadata/stations');
  const m = new Map();
  for (const s of list) {
    m.set(s.stationShortCode, {
      name: s.stationName.replace(/ asema$/, ''), lat: s.latitude, lon: s.longitude, passenger: s.passengerTraffic,
    });
  }
  return m;
}

/** All trains of one departure date (YYYY-MM-DD), memoised. */
export function loadDay(dateStr) {
  if (!dayCache.has(dateStr)) {
    const p = getJSON(`/trains/${dateStr}`);
    p.catch(() => dayCache.delete(dateStr));
    dayCache.set(dateStr, p);
  }
  return dayCache.get(dateStr);
}

/** GeoJSON FeatureCollection of latest GPS positions. */
export function loadLive() { return getJSON('/train-locations.geojson/latest'); }

/** Trains changed since a version number (incremental live updates). */
export function loadChangedSince(version) { return getJSON(`/trains?version=${version}`); }

/** Map<detailedCode, Finnish name> */
export async function loadCauseNames() {
  const list = await getJSON('/metadata/detailed-cause-category-codes');
  return new Map(list.map(c => [c.detailedCategoryCode, c.detailedCategoryName]));
}

/** Current delay (s) of a train = last row with an actual time; null if not started. */
export function currentDelay(train) {
  const rows = train.timeTableRows || [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.actualTime && !r.cancelled) return (Date.parse(r.actualTime) - Date.parse(r.scheduledTime)) / 1000;
  }
  return null;
}
