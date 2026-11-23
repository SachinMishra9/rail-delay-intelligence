// Tiny assert harness shared by the jsc runner and the browser page.
const cases = [];

export function test(name, fn) { cases.push({ name, fn }); }

export function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }

export function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg} expected ${e}, got ${a}`.trim());
}

export function approx(actual, expected, tol = 1e-9, msg = '') {
  if (typeof actual !== 'number' || !(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${msg} expected ${expected} ±${tol}, got ${actual}`.trim());
  }
}

export function runAll() {
  return cases.map(({ name, fn }) => {
    try { fn(); return { name, ok: true }; }
    catch (e) { return { name, ok: false, error: String(e && e.message || e) }; }
  });
}
