// M4f's re-check (PT18, S136): every conformance and example source is checked again under PL1207 and the vacuity
// rule, and the result must equal this table. A source not listed has no vacuous property and no PL1207. Each
// listed property restates terminality as a step property: no step is ever accepted from a terminal state
// (PS3.2 row 1), so its antecedent is never true on an accepted step. The record in docs/history/plan-m4.md explains them.
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

// FROZEN is written on main when the M3 set is frozen (M3-5).
// Polywatch on step 10, fixed in M9: the FROZEN commit is the commit that added experiments/m3/FROZEN on main (its
// text names other commits first). Only a checkout with no history, where git is not a repository, makes the re-check
// a todo; any other git error fails, so the re-check is never skipped by accident.
function frozenCommit() {
  let added;
  try {
    added = execFileSync('git', ['log', '--diff-filter=A', '--format=%h', 'main', '--', 'experiments/m3/FROZEN'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (/not a git repository/.test(String(err.stderr ?? ''))) return null;
    throw err;
  }
  return added ? added.split('\n').pop() : null;
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

// Polywatch on step 10, out of scope then and fixed in M9 (plan-m9, carried items): the FROZEN commit is the commit
// that added experiments/m3/FROZEN on main, never the first hex token of its text, which names other commits first.
test('the FROZEN commit is the commit that added experiments/m3/FROZEN on main', { skip: commit ? false : 'not run: experiments/m3/FROZEN is not on main' }, () => {
  const added = execFileSync('git', ['log', '--diff-filter=A', '--format=%h', 'main', '--', 'experiments/m3/FROZEN'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop();
  assert.equal(commit, added);
});
