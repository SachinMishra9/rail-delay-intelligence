// Runs the heavy analysis off the main thread: fetch days, analyse, post back.
import { loadDay } from './data.js';
import { analyseDays } from './analysis.js';

self.onmessage = async ({ data: { id, dates, assumptions } }) => {
  try {
    const trains = [];
    for (const [i, d] of dates.entries()) {
      self.postMessage({ id, progress: `Downloading ${d} (${i + 1}/${dates.length})` });
      trains.push(...await loadDay(d));
    }
    self.postMessage({ id, progress: `Analysing ${trains.length.toLocaleString()} trains` });
    self.postMessage({ id, result: analyseDays(trains, { assumptions }) });
  } catch (e) {
    self.postMessage({ id, error: e.message || String(e) });
  }
};
