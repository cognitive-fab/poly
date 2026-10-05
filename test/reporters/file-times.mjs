// A node:test reporter that records, for each test file, the summed duration of its top-level tests, and writes them
// as JSON, slowest first, with the run's total (decisions-m6.md: every gate report gives the ten slowest files and the
// suite's total). It reports what node:test measured; it changes no test and decides nothing.
import { relative } from 'node:path';

export default async function* fileTimes(source) {
  const files = new Map();
  let total = 0;
  for await (const event of source) {
    if (event.type === 'test:summary' && event.data?.file === undefined && typeof event.data?.duration_ms === 'number') total = Math.max(total, event.data.duration_ms);
    if ((event.type !== 'test:pass' && event.type !== 'test:fail') || event.data?.nesting !== 0 || !event.data?.file) continue;
    const file = relative(process.cwd(), event.data.file).split('\\').join('/');
    const f = files.get(file) ?? { file, ms: 0, tests: 0, failed: 0 };
    f.ms += event.data.details?.duration_ms ?? 0;
    f.tests += 1;
    if (event.type === 'test:fail') f.failed += 1;
    files.set(file, f);
  }
  const rows = [...files.values()].map((f) => ({ ...f, ms: Math.round(f.ms) })).sort((a, b) => b.ms - a.ms);
  yield JSON.stringify({ totalMs: Math.round(total), files: rows }, null, 1) + '\n';
}
