// M4f's re-check (PT18, S136): every conformance and example source is checked again under PL1207 and the vacuity
// rule, and the result must equal this table. A source not listed has no vacuous property and no PL1207. Each
// listed property restates terminality as a step property: no step is ever accepted from a terminal state
// (PS3.2 row 1), so its antecedent is never true on an accepted step. The record in docs/plan-m4.md explains them.
//
// The other half, M3's references at the commit FROZEN records, waits until FROZEN exists, and says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep, dirname } from 'node:path';
import { checkFile } from '@poly/check';
import { ROOT } from './helpers.mjs';

const VACUOUS = {
  'conformance/m2/embed/orders.ts': { Order: [{ property: 'cancel-is-final', antecedent: 'pre.status == Cancelled' }] },
  'examples/orders/orders.poly': { Order: [{ property: 'cancel-is-final', antecedent: 'pre.status == Cancelled' }] },
  'examples/field-studies/raft/raft.poly': { Node: [{ property: 'shutdown-is-a-true-terminal-state', antecedent: 'pre.role == Shutdown' }] },
};

function sources() {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) { if (e !== 'errors') walk(p); } else if (p.endsWith('.poly') || (p.endsWith('.ts') && !p.endsWith('.d.ts'))) out.push(p);
    }
  };
  walk(join(ROOT, 'conformance'));
  walk(join(ROOT, 'examples'));
  return out.sort();
}

async function vacuityOf(file, root) {
  const r = await checkFile(file, { root });
  const vacuous = {};
  for (const m of [...r.machines.map((x) => [x.machine, x.vacuous]), ...r.configurations.map((x) => [x.configuration, x.vacuous])]) {
    if (m[1].length) vacuous[m[0]] = m[1].map((v) => ({ property: v.property, antecedent: v.antecedent }));
  }
  const pl1207 = [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics)].filter((d) => d.code === 'PL1207').length;
  return { vacuous, pl1207, verdict: r.verdict };
}

test('every conformance and example source under PL1207 and vacuity equals the recorded table', async () => {
  const root = join(ROOT, '.poly', 'test-recheck');
  const files = sources();
  assert.ok(files.length >= 50, `${files.length} sources`);
  for (const f of files) {
    const rel = relative(ROOT, f).split(sep).join('/');
    const got = await vacuityOf(f, root);
    assert.equal(got.pl1207, 0, rel);
    assert.deepEqual(got.vacuous, VACUOUS[rel] ?? {}, rel);
    if (VACUOUS[rel]) assert.notEqual(got.verdict, 'CLEAN', rel);
  }
});

// FROZEN is written on main when the M3 set is frozen (M3-5); it names the commit the freeze was taken from.
function frozenCommit() {
  try {
    const text = execFileSync('git', ['show', 'main:experiments/m3/FROZEN'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /\b([0-9a-f]{7,40})\b/.exec(text);
    if (!m) throw new Error('experiments/m3/FROZEN names no commit');
    return m[1];
  } catch (err) {
    if (/names no commit/.test(err.message)) throw err;
    return null;
  }
}

const commit = frozenCommit();

test("M3's references at the FROZEN commit, under PL1207 and vacuity (S136)",
  commit ? {} : { todo: 'not run: experiments/m3/FROZEN does not exist on main yet (S136)' },
  async () => {
    if (!commit) return;
    const names = execFileSync('git', ['ls-tree', '-r', '--name-only', commit, 'experiments/m3/tasks'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter((p) => /\/reference\/[^/]+\.(poly|ts)$/.test(p));
    assert.ok(names.length >= 40, `${names.length} references`);
    const dir = mkdtempSync(join(tmpdir(), 'poly-m3-refs-'));
    try {
      const found = [];
      for (const p of names) {
        const file = join(dir, p);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, execFileSync('git', ['show', `${commit}:${p}`], { cwd: ROOT }));
        const got = await vacuityOf(file, join(dir, '.poly'));
        if (got.pl1207 || Object.keys(got.vacuous).length) found.push({ reference: p, ...got });
      }
      // A change of verdict is a finding for the M3 report, never a change to the frozen set (S136).
      assert.deepEqual(found, [], JSON.stringify(found, null, 2));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
