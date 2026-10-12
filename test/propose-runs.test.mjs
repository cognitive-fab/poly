// M7.3 / C5 (PT31.10): `poly propose --runs` turns the work orders of a store into transcripts, through the export of PS19, so
// polyness is given a projection with no payload, data or body and the export's own tokens as session ids. Written by the
// implementer from PT31.10 before the code, and seen failing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as check from '@poly/check';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';
import { admitted, handleWith, makeKey } from './runtime-helpers.mjs';
import { shop } from './fixtures/m7/make-shop-traces.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const POLYNESS = process.env.POLY_POLYNESS_DIR ?? join(ROOT, '..', 'polyness');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'm7', 'polyness-git-push');
const NL = String.fromCharCode(10);
const poly = (...args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...args], { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; }
};
const lines = (text) => text.trim().split(NL).filter(Boolean).map((l) => JSON.parse(l));
const calls = (text) => lines(text).flatMap((l) => (l.message?.content ?? []).filter((c) => c?.type === 'tool_use').map((c) => c.input.command));

test('PT31.10: the corpus becomes one session per episode, five episodes to a file, each effect a tool call named by its kind, in order', () => {
  assert.equal(typeof check.transcriptsFromCorpus, 'function');
  const out = check.transcriptsFromCorpus(shop());
  const names = Object.keys(out.files).sort();
  assert.deepEqual(names, ['runs-0.jsonl', 'runs-1.jsonl', 'runs-2.jsonl', 'runs-3.jsonl'], '18 episodes, five to a file');
  assert.equal(out.sessions, 18);
  const sessions = new Set(names.flatMap((n) => lines(out.files[n]).map((l) => l.sessionId)));
  assert.equal(sessions.size, 18);
  for (const s of sessions) assert.match(s, /^d:[0-9a-f]{32}$/, 'the export\'s own token');
  const all = names.map((n) => out.files[n]).join(NL);
  const first = calls(out.files['runs-0.jsonl']);
  assert.deepEqual(first.slice(0, 2), ['stock.reserve', 'payment.charge'], 'the order of the first episode');
  assert.equal(calls(all).filter((c) => c === 'payment.fee').length, 6, 'the six cancelled runs');
});

test('PT31.10: nothing of the corpus but kinds, order and the gate\'s decisions reaches the transcripts: no state, no project name, no consequence', () => {
  const out = check.transcriptsFromCorpus(shop());
  const all = Object.values(out.files).join(NL);
  for (const leak of ['Open', 'Reserving', 'Charging', 'Cancelled', 'shop', 'irreversible', 'compensable', 'write:store', 'egress:external', 'orders.Order', 'Reserve', 'Finish']) assert.ok(!all.includes(leak), `${leak} reached the transcripts`);
  assert.ok(!all.includes('sha256:'), 'no certificate digest');
});

test('PT31.10: a hyphen of a kind reads as a space; an effect the gate denied is an error and the others are not', () => {
  const corpus = shop().split(NL);
  const ep = JSON.parse(corpus[1]);
  ep.steps[1].effects[0] = { ...ep.steps[1].effects[0], kind: 'git-push', gate: { outcome: 'denied', reason: 'denied' } };
  corpus[1] = JSON.stringify(ep);
  const out = check.transcriptsFromCorpus(corpus.join(NL));
  const rows = lines(out.files['runs-0.jsonl']);
  const use = rows.flatMap((l) => (l.message?.content ?? []).filter((c) => c?.type === 'tool_use' && c.input.command === 'git push'));
  assert.equal(use.length, 1);
  const result = rows.flatMap((l) => (l.message?.content ?? []).filter((c) => c?.type === 'tool_result' && c.tool_use_id === use[0].id));
  assert.equal(result.length, 1);
  assert.equal(result[0].is_error, true, 'denied');
  const others = rows.flatMap((l) => (l.message?.content ?? []).filter((c) => c?.type === 'tool_result' && c.tool_use_id !== use[0].id));
  assert.ok(others.length > 0 && others.every((c) => c.is_error !== true), 'allowed effects are not errors');
});

let tmp; let a; let signer;
before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'poly-propose-runs-test-'));
  a = await admitted('propose-runs', ['conformance/m1/effects.poly']);
  signer = makeKey('propose-runs-ledger');
  writeFileSync(join(a.dir, 'ledger.pub'), signer.publicKey);
  writeFileSync(join(a.dir, 'admission.pub'), a.key.publicKey);
});
after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

async function store() {
  const db = join(tmp, `run-${Date.now()}.db`);
  const { load } = await import('@poly/runtime');
  const rt = await load(a.build, { certificate: a.certificate, trust: a.trust, store: { sqlite: db }, ledger: { keyId: signer.id, privateKeyPem: readFileSync(signer.file, 'utf8') } });
  for (const k of ['billing.invoice', 'billing.perk', 'billing.receipt', 'mail.notice', 'mail.reminder']) handleWith(rt, k, () => ({ ok: true }));
  for (let i = 0; i < 6; i++) {
    const acc = await rt.create('effects.Account', { id: `acc-${i}` });
    await rt.dispatch(acc.id, 'Bill', { tier: 'Gold' });
    await rt.dispatch(acc.id, 'Notify', {});
  }
  await rt.signHeads();
  await rt.close();
  return db;
}

/** A polyness that logs the transcripts it was given (names and text), then replays the real output for git push. */
function recorder() {
  const dir = join(tmp, `recorder-${Date.now()}`);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  const files = Object.fromEntries(readdirSync(FIXTURE).map((f) => [f, readFileSync(join(FIXTURE, f), 'utf8')]));
  const log = join(dir, 'seen.json');
  writeFileSync(join(dir, 'bin', 'polyness.mjs'), [
    "import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    `const FILES = ${JSON.stringify(files)};`,
    "const d = join(process.env.HOME, '.claude', 'projects', 'project');",
    `writeFileSync(${JSON.stringify(log)}, JSON.stringify(Object.fromEntries(readdirSync(d).map((n) => [n, readFileSync(join(d, n), 'utf8')]))));`,
    "const out = join(process.cwd(), '.polyness', 'proposals', 'git-push-checked'); mkdirSync(out, { recursive: true });",
    'for (const [n, t] of Object.entries(FILES)) writeFileSync(join(out, n), t);',
  ].join(NL));
  const pin = join(tmp, `recorder-${Date.now()}.pin.json`);
  assert.equal(poly('propose', '--pin-polyness', '--polyness', dir, '--polyness-pin', pin).code, 0);
  return { dir, pin, seen: () => JSON.parse(readFileSync(log, 'utf8')) };
}
const runsArgs = (db) => ['--runs', db, '--build', a.build, '--certificate', a.certificate, '--trust', `${a.key.id}=${join(a.dir, 'admission.pub')}`];

test('PT31.10: --runs exports the store in memory, gives polyness the converted transcripts, and leaves no folder behind', async () => {
  const db = await store();
  const r = recorder();
  const before = readdirSync(tmpdir()).filter((x) => x.startsWith('poly-propose-runs-') && !x.startsWith('poly-propose-runs-test-'));
  const out = join(tmp, 'runs-out');
  const ok = poly('propose', '--polyness', r.dir, '--step', 'git push', ...runsArgs(db), '--polyness-pin', r.pin, '--out', out);
  assert.equal(ok.code, 0, ok.out);
  const seen = r.seen();
  assert.deepEqual(Object.keys(seen), ['runs-0.jsonl'], 'six runs, one file');
  const cmds = calls(seen['runs-0.jsonl']);
  assert.ok(cmds.some((c) => /^billing\./.test(c)), cmds.join(','));
  assert.ok(!seen['runs-0.jsonl'].includes('acc-'), 'no run id or instance id');
  assert.deepEqual(readdirSync(tmpdir()).filter((x) => x.startsWith('poly-propose-runs-') && !x.startsWith('poly-propose-runs-test-')), before, 'the converted folder is removed');
  assert.ok(existsSync(join(out, 'proposal.json')));
});

test('PT31.10: exactly one of --runs and --transcripts; --runs needs --build, --certificate and --trust', async () => {
  const db = await store();
  const r = recorder();
  const base = ['propose', '--polyness', r.dir, '--step', 'git push', '--polyness-pin', r.pin];
  const both = poly(...base, ...runsArgs(db), '--transcripts', tmp, '--out', join(tmp, 'o1'));
  assert.equal(both.code, 64, both.out);
  assert.match(both.out, /--runs.*--transcripts|--transcripts.*--runs/);
  const none = poly(...base, '--out', join(tmp, 'o2'));
  assert.equal(none.code, 64, none.out);
  for (const flag of ['--build', '--certificate', '--trust']) {
    const a2 = runsArgs(db);
    const i = a2.indexOf(flag);
    const bad = poly(...base, ...a2.slice(0, i), ...a2.slice(i + 2), '--out', join(tmp, `o3-${flag.slice(2)}`));
    assert.equal(bad.code, 64, `${flag}: ${bad.out}`);
    assert.ok(bad.out.includes(flag), bad.out);
  }
});
