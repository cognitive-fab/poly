// PT14a: seeded defects. Each defect's edits are applied in memory, the patched program is checked in the
// configurations it keeps, through the cache, and the defect is found when the check reports the expected code on the
// named property and nothing else but a bound. The program is examples/checkout: an Order that confirms on OutOfStock
// lets two buyers be Done with one unit of stock, which two-buyers' invariant confirmed-within-stock catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { baseKeys, checkDefects, checkFile, judgeDefect, readDefects } from '@poly/check';
import { ROOT } from './helpers.mjs';
import { comparable } from './check-cache-helpers.mjs';

const CHECKOUT = join(ROOT, 'examples', 'checkout', 'checkout.poly');
const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const EDIT = { find: `on OutOfStock { require st is Taking else reject "not-taking"  st' = Refused }`, replace: `on OutOfStock { require st is Taking else reject "not-taking"  st' = Done }` };
const FOUND = { name: 'confirm-without-stock', note: 'OutOfStock confirms the order.', expected: 'FINDING PL5401', finding: 'confirmed-within-stock', keep: ['two-buyers'], edits: [EDIT] };
// The same fault with no configuration kept: no property sees it, so the check is CLEAN and the defect is not found.
const UNSEEN = { ...FOUND, name: 'confirm-without-stock-unseen', keep: [] };
const COMMENT = { name: 'a-comment', expected: 'CLEAN', keep: ['two-buyers'], edits: [{ find: '// Taking waits for', replace: '// Taking still waits for' }] };
const scratch = () => mkdtempSync(join(tmpdir(), 'poly-defects-test-'));

test('PT14a: a defect is found by the property it was seeded for; one no kept configuration sees is not', async () => {
  const dir = scratch();
  try {
    const out = await checkDefects(CHECKOUT, [FOUND, UNSEEN, COMMENT], { root: dir, cache: join(dir, 'cache') });
    assert.deepEqual(out.map((d) => [d.name, d.found, d.verdict]), [['confirm-without-stock', true, 'FINDINGS'], ['confirm-without-stock-unseen', false, 'CLEAN'], ['a-comment', true, 'CLEAN']]);
    assert.ok(out[0].findings.some((d) => d.code === 'PL5401' && d.property === 'confirmed-within-stock'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PT14a: a defect\'s check equals a check of its patched copy with no cache, and reads back the machines it leaves alone', async () => {
  const dir = scratch();
  const cache = join(dir, 'cache');
  try {
    await checkFile(CHECKOUT, { root: join(dir, 'base'), cache });
    const text = readFileSync(CHECKOUT, 'utf8').replace(/\r\n/g, '\n').replace(EDIT.find, () => EDIT.replace);
    const warm = await checkFile(CHECKOUT, { root: join(dir, 'warm'), cache, text, configs: FOUND.keep });
    const none = await checkFile(CHECKOUT, { root: join(dir, 'none'), text, configs: FOUND.keep });
    assert.deepEqual(comparable(warm), comparable(none));
    assert.equal(warm.machines.find((m) => m.machine === 'Inventory').cache.hit, true, 'the machine the patch leaves alone is read back');
    assert.equal(warm.machines.find((m) => m.machine === 'Order').cache.hit, false, 'the machine it changes is checked');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PT14a: a finding the unpatched program reports too, in the same unit about the same thing, is set aside', () => {
  const diag = (code, property) => ({ code, property, at: {} });
  const report = (machine, config) => ({ verdict: 'FINDINGS', diagnostics: [], policies: [], machines: [{ machine: 'Run', diagnostics: machine }], configurations: [{ configuration: 'two-buyers', diagnostics: config }] });
  const unpatched = report([diag('PL4003', 'publish')], []);
  const patched = report([diag('PL4003', 'publish')], [diag('PL5401', 'confirmed-within-stock')]);
  assert.equal(judgeDefect(patched, FOUND), false, 'without the unpatched program, Run\'s finding is another finding');
  assert.equal(judgeDefect(patched, FOUND, baseKeys(unpatched)), true, 'with it, Run\'s finding is set aside');
  const elsewhere = report([diag('PL4003', 'retract')], [diag('PL5401', 'confirmed-within-stock')]);
  assert.equal(judgeDefect(elsewhere, FOUND, baseKeys(unpatched)), false, 'a finding about something else is the defect\'s');
});

// Ruled 2026-10-30: the unpatched program is checked in each defect's own configurations. In chat-ruled-out-plain, Chat's
// never free-when-closed is a finding alone and ruled out by the configuration pair (S178). A defect that keeps no
// configuration sees it, and so does the unpatched program checked with none; checked with pair, it would not, and the
// finding would be read as the defect's.
test('PT14a: each defect is judged against the unpatched program checked in its own configurations', async () => {
  const dir = scratch();
  try {
    const CHAT = join(ROOT, 'test', 'fixtures', 'm9', 'chat-ruled-out-plain.poly');
    const alone = { name: 'never-sent', expected: 'FINDING PL3001', finding: 'never-sent', keep: [], edits: [{ find: '  never free-when-closed:', replace: '  invariant never-sent: !sent\n  never free-when-closed:' }] };
    const paired = { ...alone, name: 'never-sent-paired', keep: ['pair'] };
    const out = await checkDefects(CHAT, [alone, paired], { root: dir, cache: join(dir, 'cache') });
    assert.deepEqual(out.map((d) => [d.name, d.found]), [['never-sent', true], ['never-sent-paired', true]]);
    assert.ok(out[0].preexisting.some((d) => d.code === 'PL3002' && d.property === 'free-when-closed'), 'Chat\'s never finding is set aside, from the unpatched check with no configuration');
    assert.deepEqual(out[1].preexisting, [], 'with pair the finding is ruled out, in the defect\'s check and in its unpatched check');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PT14a: a defects file that does not fit the source is a usage error before anything is checked', async () => {
  const dir = scratch();
  try {
    await assert.rejects(checkDefects(CHECKOUT, [{ ...FOUND, edits: [{ find: 'no such text', replace: 'x' }] }], { root: dir }), /found 0 times, not once/);
    await assert.rejects(checkDefects(CHECKOUT, [{ ...FOUND, edits: [{ find: 'st is Taking', replace: 'st is Asked' }] }], { root: dir }), /found 2 times, not once/);
    await assert.rejects(checkDefects(CHECKOUT, [{ ...FOUND, edits: [{ find: EDIT.find, replace: EDIT.find }] }], { root: dir }), /replaces its text with itself/);
    await assert.rejects(checkDefects(CHECKOUT, [{ ...FOUND, keep: ['three-buyers'] }], { root: dir }), /keeps the configuration three-buyers/);
    await assert.rejects(checkDefects(CHECKOUT, [FOUND], { root: dir, only: ['nope'] }), /no such defect: nope/);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify([{ name: 'x', expected: 'FOUND', keep: [], edits: [EDIT] }]));
    assert.throws(() => readDefects(bad), /expected is "CLEAN" or "FINDING PLxxxx"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PT14a: poly check --defects prints found or NOT FOUND, exits 1 when one is not found, 0 when --only picks found ones', () => {
  const dir = scratch();
  try {
    const file = join(dir, 'defects.json');
    writeFileSync(file, JSON.stringify([FOUND, UNSEEN]));
    const args = (...more) => [CLI, 'check', CHECKOUT, '--defects', file, '--root', dir, '--cache', join(dir, 'cache'), ...more];
    const r = spawnSync(process.execPath, args(), { encoding: 'utf8' });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /^found {7}confirm-without-stock {14}PL5401 confirmed-within-stock$/m);
    assert.match(r.stdout, /^NOT FOUND {3}confirm-without-stock-unseen/m);
    assert.match(r.stdout, /1 seeded defect is not found/);
    const report = JSON.parse(readFileSync(join(dir, '.poly', 'defects.json'), 'utf8'));
    assert.deepEqual(report.defects.map((d) => d.found), [true, false]);
    const only = spawnSync(process.execPath, args('--only', 'confirm-without-stock'), { encoding: 'utf8' });
    assert.equal(only.status, 0, only.stdout);
    assert.match(only.stdout, /all 1 seeded defect is found/);
    const usage = spawnSync(process.execPath, args('--config', 'two-buyers'), { encoding: 'utf8' });
    assert.equal(usage.status, 64);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
