// M6 step 1: where a slow check spends its time. Checks one file and prints, for each machine and configuration, each
// stage's time and its note (states explored, bounds), with the whole check's time.
//
// Usage: node scripts/measure-check-stages.mjs <file.poly>
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFile } from '@poly/check';
import { assertNotExperimentTree } from './tree-guard.mjs';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
assertNotExperimentTree(ROOT);
const file = process.argv[2];
if (!file) { console.error('usage: node scripts/measure-check-stages.mjs <file.poly>'); process.exit(64); }
const t0 = performance.now();
const r = await checkFile(file, { root: join(ROOT, '.poly', 'test-build', 'stages') });
const total = Math.round(performance.now() - t0);
const rows = [...r.machines.map((m) => ({ unit: m.machine, stages: m.stages })), ...(r.configurations ?? []).map((c) => ({ unit: `configuration ${c.configuration}`, stages: c.stages ?? [] }))];
console.log(JSON.stringify({ file, verdict: r.verdict, totalMs: total, units: rows.map((u) => ({ unit: u.unit, stages: u.stages.map((s) => ({ stage: s.stage, ms: Math.round(s.ms ?? 0), status: s.status, note: s.note })) })) }, null, 1));
