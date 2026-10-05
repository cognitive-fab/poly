#!/usr/bin/env node
// M8a step 3 (S176): the verdict and state counts of every conformance case and example, each checked as a file in a
// process of its own, written to one JSON file, so the toolchain before and after a change can be compared file by
// file. The evidence scripts are compared by their own test (test/evidence.test.mjs), which reproduces their numbers.
//
// Usage: node scripts/measure-verdicts.mjs <out.json> [--jobs 6]
//        node scripts/measure-verdicts.mjs --one <file> <root>     (one file; prints its record as JSON)
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { assertNotExperimentTree } from './tree-guard.mjs';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const rel = (p) => relative(ROOT, p).split(sep).join('/');

if (process.argv[2] === '--one') {
  const { checkFile } = await import('@poly/check');
  const [file, root] = process.argv.slice(3);
  const t0 = Date.now();
  let rec;
  try {
    const r = await checkFile(file, { root });
    rec = {
      verdict: r.verdict,
      error: r.error ?? null,
      diagnostics: [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...(r.configurations ?? []).flatMap((c) => c.diagnostics), ...(r.policies ?? []).flatMap((p) => p.diagnostics)].map((d) => d.code).sort(),
      machines: Object.fromEntries(r.machines.map((m) => [m.machine, { verdict: m.verdict, states: m.instance?.states ?? null, transitions: m.instance?.transitions ?? null, stages: m.stages.map((s) => `${s.stage}:${s.status}:${s.verdict ?? ''}`) }])),
      configurations: Object.fromEntries((r.configurations ?? []).map((c) => [c.configuration, { verdict: c.verdict, states: c.instance?.states ?? null, transitions: c.instance?.transitions ?? null }])),
      policies: (r.policies ?? []).map((p) => ({ scope: p.scope, verdict: p.verdict })),
    };
  } catch (e) {
    rec = { verdict: 'THREW', error: (e).message.slice(0, 300) };
  }
  rec.ms = Date.now() - t0;
  process.stdout.write(JSON.stringify(rec));
  process.exit(0);
}

assertNotExperimentTree(ROOT);
const out = process.argv[2];
const jobs = Number(process.argv[process.argv.indexOf('--jobs') + 1]) || 6;
const walk = (d) => readdirSync(d).flatMap((e) => (statSync(join(d, e)).isDirectory() ? (e === 'node_modules' || e === '.poly' ? [] : walk(join(d, e))) : [join(d, e)]));
const files = ['conformance', 'examples'].flatMap((d) => walk(join(ROOT, d))).filter((f) => f.endsWith('.poly') || (f.endsWith('.ts') && /from ['"]@poly\/embed['"]|^import \{\s*$\s*module,/m.test(readFileSync(f, 'utf8')))).sort();
const scratch = join(ROOT, '.poly', 'measure-verdicts');
rmSync(scratch, { recursive: true, force: true });
const results = {};
let next = 0;
async function worker() {
  for (;;) {
    const i = next++;
    if (i >= files.length) return;
    const f = files[i];
    const root = join(scratch, String(i));
    mkdirSync(root, { recursive: true });
    const text = await new Promise((res) => {
      let s = '';
      const c = spawn(process.execPath, [fileURLToPath(import.meta.url), '--one', f, root], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
      c.stdout.on('data', (b) => { s += b; });
      c.on('exit', () => res(s));
    });
    try { results[rel(f)] = JSON.parse(text); } catch { results[rel(f)] = { verdict: 'CRASHED' }; }
    process.stderr.write(`${Object.keys(results).length}/${files.length} ${rel(f)} ${results[rel(f)].verdict}\n`);
  }
}
await Promise.all(Array.from({ length: jobs }, worker));
const sorted = Object.fromEntries(Object.keys(results).sort().map((k) => [k, results[k]]));
writeFileSync(out, JSON.stringify({ commit: process.env.npm_package_version ?? null, files: sorted }, null, 2) + '\n');
console.log(`${files.length} files measured into ${out}`);
