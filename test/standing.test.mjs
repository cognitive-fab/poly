// Standing rule (decisions-m0.md, after the review): PL2501 and PL2001 are
// for toolchain faults only. A user program with an error is reported at its
// source line with a user-facing code; any user program that reaches PL2501
// or PL2001 is a checker bug.
//
// Every poly source in the repository, except the path S163 names below, goes through the whole `poly check`
// pipeline with no exception. The deliberately broken lowerings, the only
// programs allowed a toolchain code, are not sources: they are named in the
// explicit list of test/toolchain-faults.mjs, which is checked here against
// poly-lower's own list, and are exercised only by test/tv.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, relative, sep } from 'node:path';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { checkFile } from '@poly/check';
import { FAULTS } from '@poly/lower';
import { ROOT } from './helpers.mjs';
import { DELIBERATELY_BROKEN_LOWERINGS, toolchainFaults } from './toolchain-faults.mjs';
import { serial } from './serial-sources.mjs';

// Build output and installed packages are not sources. Their directories are not entered at all: an
// installed package may be a link to an engine's own checkout, with files a walk cannot stat.
const NOT_SOURCES = new Set(['node_modules', '.poly', '.git']);

// S163: the exceptions, by path from the repository root. The M3 runs are frozen experiment evidence: the programs
// the arms wrote, kept as delivered, not repository source. Checking them is optional and outside the gate. SR3's runs
// and its voided first block join them, as the reviewer ruled on accepting V1 to V9 (decisions-v1.md).
const OUTSIDE_THE_RULE = ['experiments/m3/runs/', 'experiments/sr/runs/', 'experiments/sr/void/'];

function sources(dir, root = ROOT) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (NOT_SOURCES.has(e)) continue;
    if (statSync(p).isDirectory()) {
      if (OUTSIDE_THE_RULE.includes(relative(root, p).split(sep).join('/') + '/')) continue;
      out.push(...sources(p, root));
    } else if (p.endsWith('.poly')) out.push(p);
  }
  return out.sort();
}

// Every directory that holds poly sources, and nothing filtered out of them.
const ALL = ['examples', 'conformance', join('test', 'fixtures'), 'experiments', join('packages', 'poly-runtime', 'model'), 'std'].flatMap((d) => sources(join(ROOT, d)));
const OUT = join(ROOT, '.poly', 'test-build', 'standing');

// S163: the only sources outside the standing rule are named, and nothing else is dropped with them.
test('S163: the excepted paths are the M3 and SR3 runs, and a source anywhere else is still covered', () => {
  assert.deepEqual(OUTSIDE_THE_RULE, ['experiments/m3/runs/', 'experiments/sr/runs/', 'experiments/sr/void/']);
  const root = mkdtempSync(join(tmpdir(), 'poly-standing-'));
  try {
    const files = ['experiments/m3/runs/T1-arm3-run1/src/system.poly', 'experiments/m3/tasks/T1/system.poly', 'experiments/m3/runs.poly', 'experiments/runs/x.poly', 'examples/m3/runs/y.poly', 'conformance/z.poly', 'experiments/sr/runs/T3-arm3-run1/src/system.poly', 'experiments/sr/void/b/s.poly', 'experiments/sr/x.poly'];
    for (const f of files) {
      mkdirSync(join(root, dirname(f)), { recursive: true });
      writeFileSync(join(root, f), 'module x\n');
    }
    assert.deepEqual(sources(root, root).map((p) => relative(root, p).split(sep).join('/')).sort(), files.filter((f) => !OUTSIDE_THE_RULE.some((x) => f.startsWith(x))).sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the exception is an explicit list, equal to poly-lower\'s faults', () => {
  assert.deepEqual([...DELIBERATELY_BROKEN_LOWERINGS].sort(), [...FAULTS].sort());
});

test('the standing rule covers every source in the repository', () => {
  const everywhere = sources(ROOT);
  assert.deepEqual(everywhere.map((p) => relative(ROOT, p)).sort(), ALL.map((p) => relative(ROOT, p)).sort());
  assert.ok(ALL.length >= 49, `${ALL.length} sources`);
});

// Ruled 2026-10-10: a source of the serial group is checked in test/after/serial-sources.test.mjs instead, with the same
// assertion; it stays in ALL, so the coverage test above still holds it.
for (const file of ALL.filter((f) => !serial(f))) {
  test(`no toolchain fault: ${relative(ROOT, file)}`, async () => {
    const r = await checkFile(file, { root: OUT });
    assert.ok(r.verdict !== 'ERROR', `poly check errored: ${r.error}`);
    const faults = toolchainFaults([...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics)]);
    assert.deepEqual(faults.map((d) => `${d.code} ${d.message}`), []);
  });
}

// Ruled 2026-10-15: a control character in a source is a typo that no reviewer sees. Two backspaces (0x08) once stood where a
// regex's \b belonged (test/s526-rule.test.mjs), and the regex could never match. No file under test/, conformance/, examples/
// or std/ holds a character below 0x20 other than tab, newline and carriage return.
test('no control character (0x00 to 0x1F but tab, newline, carriage return) in test/, conformance/, examples/ or std/', async () => {
  const { readFileSync } = await import('node:fs');
  const BINARY = /\.(png|jpe?g|gif|ico|woff2?|zip|gz|pdf|sqlite|db|bin|wasm)$/i;
  const found = [];
  const scan = (dir) => {
    for (const name of readdirSync(dir)) {
      if (['node_modules', '.poly', 'dist', '.git'].includes(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { scan(p); continue; }
      if (BINARY.test(p)) continue;
      const bytes = readFileSync(p);
      let line = 1;
      let col = 1;
      for (const c of bytes) {
        if (c === 10) { line++; col = 1; continue; }
        if (c < 0x20 && c !== 9 && c !== 13) found.push(`${relative(ROOT, p).split(sep).join('/')}:${line}:${col} 0x${c.toString(16).padStart(2, '0')}`);
        col++;
      }
    }
  };
  for (const d of ['test', 'conformance', 'examples', 'std']) scan(join(ROOT, d));
  assert.deepEqual(found, [], 'control characters found (file:line:column byte)');
});

test('the control-character check detects one (a check that finds nothing is not shown to look)', () => {
  const sample = Buffer.from('const re = /\bword\b/;\n');
  assert.ok([...sample].some((c) => c < 0x20 && c !== 9 && c !== 10 && c !== 13), 'a backspace in a regex is below 0x20');
  assert.ok(![...Buffer.from('tab\tand\r\nnewline\n')].some((c) => c < 0x20 && c !== 9 && c !== 10 && c !== 13), 'tab, newline and carriage return are allowed');
});
