// PS13.10, PT14a: goals. A goal is a predicate on a configuration's global states, expected to fail somewhere; it joins
// the configuration's exploration, is reported reached with its path or PL5410, and never changes the configuration's
// own findings. The program is examples/checkout: one unit of stock and two buyers, so one order can be Done and two
// never can.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkFile } from '@poly/check';
import { ROOT } from './helpers.mjs';
import { comparable } from './check-cache-helpers.mjs';

const CHECKOUT = join(ROOT, 'examples', 'checkout', 'checkout.poly');
const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const ONE = { configuration: 'two-buyers', name: 'one-done', expr: 'count(order[*] is Done) < 1', path: 'a buyer gets the unit' };
const TWO = { configuration: 'two-buyers', name: 'two-done', expr: 'count(order[*] is Done) < 2', path: 'both buyers get a unit' };
const scratch = () => mkdtempSync(join(tmpdir(), 'poly-goals-test-'));

test('PS13.10: a reachable goal is reached with its path, and the configuration is judged as without it', async () => {
  const dir = scratch();
  try {
    const plain = await checkFile(CHECKOUT, { root: join(dir, 'a') });
    const withGoal = await checkFile(CHECKOUT, { root: join(dir, 'b'), goals: [ONE] });
    const [g] = withGoal.configurations[0].goals;
    assert.equal(g.name, 'one-done');
    assert.equal(g.reached, true);
    assert.ok(g.witness.length > 0 && g.witness.trace.every((s) => s.global), 'the path is global steps');
    assert.equal(g.witness.trace.at(-1).post.st, 'Done', 'the path ends where a buyer is Done');
    const { goals, ...rest } = withGoal.configurations[0];
    assert.deepEqual(comparable(rest), comparable(plain.configurations[0]), 'a reached goal changes nothing else');
    assert.equal(withGoal.verdict, plain.verdict);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PS13.10: a goal no path reaches is PL5410 GOAL_UNREACHED, INCONCLUSIVE, and its configuration\'s findings are unchanged', async () => {
  const dir = scratch();
  try {
    const r = await checkFile(CHECKOUT, { root: dir, goals: [ONE, TWO] });
    const c = r.configurations[0];
    assert.deepEqual(c.goals.map((g) => [g.name, g.reached]), [['one-done', true], ['two-done', false]]);
    const d = c.diagnostics.filter((x) => x.code === 'PL5410');
    assert.equal(d.length, 1);
    assert.equal(d[0].property, 'two-done');
    assert.equal(d[0].severity, 'inconclusive');
    assert.match(d[0].message, /reached by no path of two-buyers \(both buyers get a unit\)/);
    assert.ok(d[0].at.line > 0, 'it points at the configuration');
    assert.equal(c.verdict, 'INCONCLUSIVE');
    assert.equal(r.verdict, 'INCONCLUSIVE');
    assert.equal(r.exit, 2);
    assert.deepEqual(c.diagnostics.filter((x) => x.code !== 'PL5410'), [], 'no other finding');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PS13.10: when a bound cuts the exploration, an unreached goal is unknown, not unreachable', async () => {
  const dir = scratch();
  try {
    const text = readFileSync(CHECKOUT, 'utf8').replace('bounds    { transit 4 }', 'bounds    { transit 1 }');
    const r = await checkFile(CHECKOUT, { root: dir, text, goals: [TWO] });
    const c = r.configurations[0];
    assert.ok(c.diagnostics.some((x) => x.code === 'PL5301'), 'the bound is hit');
    const d = c.diagnostics.find((x) => x.code === 'PL5410');
    assert.match(d.message, /hit a bound, so whether a path reaches it is unknown/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PT14a: a goal that does not type-check in its configuration, or names no configuration, is a usage error', async () => {
  const dir = scratch();
  try {
    await assert.rejects(checkFile(CHECKOUT, { root: dir, goals: [{ configuration: 'two-buyers', name: 'bad', expr: 'order[0].nope == 1' }] }), /goal bad is refused in its configuration/);
    await assert.rejects(checkFile(CHECKOUT, { root: dir, goals: [{ configuration: 'three-buyers', name: 'x', expr: 'true' }] }), /names the configuration three-buyers/);
    await assert.rejects(checkFile(CHECKOUT, { root: dir, goals: [{ configuration: 'two-buyers', name: 'confirmed-within-stock', expr: 'true' }] }), /has the name of a property/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PT14a: a goal is cached with its configuration, under a key that holds the goal', async () => {
  const dir = scratch();
  const cache = join(dir, 'cache');
  try {
    const a = await checkFile(CHECKOUT, { root: join(dir, 'a'), cache, goals: [ONE] });
    const b = await checkFile(CHECKOUT, { root: join(dir, 'b'), cache, goals: [ONE] });
    const c = await checkFile(CHECKOUT, { root: join(dir, 'c'), cache, goals: [TWO] });
    assert.equal(a.configurations[0].cache.hit, false);
    assert.equal(b.configurations[0].cache.hit, true);
    assert.deepEqual(comparable(b), comparable(a));
    assert.equal(c.configurations[0].cache.hit, false, 'another goal is another key');
    assert.equal(c.configurations[0].goals[0].reached, false);
    assert.equal(c.machines.every((m) => m.cache.hit), true, 'the machines do not read the goals');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PT14a: poly check --goals prints each goal, and exits 2 when one is not reached; --config lists the others as not run', () => {
  const dir = scratch();
  try {
    const goals = join(dir, 'goals.json');
    writeFileSync(goals, JSON.stringify([ONE, TWO]));
    const r = spawnSync(process.execPath, [CLI, 'check', CHECKOUT, '--goals', goals, '--root', dir, '--no-cache'], { encoding: 'utf8' });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stdout, /reached {5}one-done \(\d+ global steps?\): a buyer gets the unit/);
    assert.match(r.stdout, /NOT REACHED two-done: both buyers get a unit/);
    assert.match(r.stdout, /PL5410 GOAL_UNREACHED {2}two-done/);
    const one = join(dir, 'one.json');
    writeFileSync(one, JSON.stringify([ONE]));
    const ok = spawnSync(process.execPath, [CLI, 'check', CHECKOUT, '--goals', one, '--root', dir, '--no-cache'], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stdout);
    const bad = spawnSync(process.execPath, [CLI, 'check', CHECKOUT, '--config', 'nope', '--root', dir, '--no-cache'], { encoding: 'utf8' });
    assert.equal(bad.status, 64);
    assert.match(bad.stderr + bad.stdout, /declares no configuration nope/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
