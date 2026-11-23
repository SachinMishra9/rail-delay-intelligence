// Headless runner for macOS JavaScriptCore:
//   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc -m tests/run.mjs
import { runAll } from './harness.js';
import './analysis.test.js';

const results = runAll();
for (const r of results) print((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.ok ? '' : '\n     ' + r.error));
const failed = results.filter(r => !r.ok).length;
print(`\n${results.length - failed}/${results.length} passed`);
if (failed) throw new Error(`${failed} test(s) failed`);
