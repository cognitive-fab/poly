// SR-AC2: the report of SR2 from sr2.json. For each of the five defective M3 deliveries, every O1 and O1-R test that
// failed before or after, with its result on each side; for every delivery, any test that went from pass to fail.
// Deterministic: the same sr2.json gives the same text.
//
// Usage: node experiments/sr/sr2-report.mjs <sr2.json>
import { readFileSync } from 'node:fs';

const DEFECTIVE = ['T3-arm3-run2', 'T3-arm3-run4', 'T3-arm4-run2', 'T3-arm4-run5', 'T7-arm4-run1'];
const { runs } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const lines = [];
const failing = (x) => new Set(x?.failing ?? []);
let regressions = 0;
let deliveries = 0;
let notScored = 0;
for (const r of runs) {
  if (!Array.isArray(r.after)) { notScored++; lines.push(`${r.id}: not scored (${JSON.stringify(r.after)})`); continue; }
  for (const b of r.before) {
    const a = r.after.find((x) => x.n === b.n);
    if (!a || !b.delivered) continue;
    deliveries++;
    for (const k of ['o1', 'o1r']) {
      const fb = failing(b[k]);
      const fa = failing(a[k]);
      const lost = [...fa].filter((t) => !fb.has(t));
      if (lost.length) { regressions += lost.length; lines.push(`REGRESSION ${r.id} v${b.n} ${k}: ${lost.join('; ')}`); }
      if (DEFECTIVE.includes(r.id) && (fb.size || fa.size)) {
        lines.push(`${r.id} v${b.n} ${k.toUpperCase()}: before ${b[k]?.failed ?? '-'}/${b[k]?.tests ?? '-'} failed, after ${a[k]?.failed ?? '-'}/${a[k]?.tests ?? '-'} failed (admitted ${b.admitted} -> ${a.admitted}, check ${b.check} -> ${a.check})`);
        for (const t of [...new Set([...fb, ...fa])].sort()) lines.push(`  ${fb.has(t) ? 'fail' : 'pass'} -> ${fa.has(t) ? 'fail' : 'pass'}  ${t}`);
      }
    }
    if (a.admitted !== b.admitted) lines.push(`ADMISSION ${r.id} v${b.n}: ${b.admitted} -> ${a.admitted} (${b.check} -> ${a.check})`);
  }
}
lines.push(`${runs.length} runs, ${deliveries} delivered versions compared, ${notScored} not scored, ${regressions} test(s) from pass to fail`);
console.log(lines.join('\n'));
