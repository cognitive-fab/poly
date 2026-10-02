// `poly journal verify | replay | export` (PT14, PF8.6, S131) over a store the runtime wrote to a file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { load } from '@poly/runtime';
import { ROOT } from './helpers.mjs';
import { admitted, makeKey } from './runtime-helpers.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const poly = (...args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; }
};

const a = await admitted('journal-cli', ['conformance/m1/children.poly', 'conformance/m1/records.poly']);
const signer = makeKey('cli-ledger');
const db = join(a.dir, 'run.db');
const pub = join(a.dir, 'ledger.pub');
const adm = join(a.dir, 'admission.pub');
writeFileSync(pub, signer.publicKey);
writeFileSync(adm, a.key.publicKey);

async function populate() {
  rmSync(db, { force: true });
  const rt = await load(a.build, { certificate: a.certificate, trust: a.trust, store: { sqlite: db }, ledger: { keyId: signer.id, privateKeyPem: readFileSync(signer.file, 'utf8') } });
  const o = await rt.create('shop.Order', { id: 'o-1' });
  await rt.dispatch(o.id, 'Checkout');
  const p = await rt.create('rec.Packer', { id: 'p-1' });
  await rt.dispatch(p.id, 'Fill', { with: { size: 'Small', count: 1 } });
  await rt.dispatch(p.id, 'Seal');
  await rt.archive(p.id);
  await rt.signHeads();
  await rt.publishAnchor({ from: 0, to: 1 });
  await rt.close();
}

test('verify: every run, its verdict, and PL9002 for a changed event', async () => {
  await populate();
  const ok = poly('journal', 'verify', '--db', db, '--trust', `${signer.id}=${pub}`);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /o-1 \(shop\.Order\): open-and-signed, signed through seq 1/);
  assert.match(ok.out, /p-1 \(rec\.Packer\): closed-and-signed/);
  const sql = new DatabaseSync(db);
  const row = sql.prepare(`SELECT event FROM poly_ledger WHERE run = 'p-1' AND seq = 1`).get();
  const e = JSON.parse(row.event);
  e.body.stepKind = 'rejected';
  sql.prepare(`UPDATE poly_ledger SET event = ? WHERE run = 'p-1' AND seq = 1`).run(JSON.stringify(e));
  sql.close();
  const bad = poly('journal', 'verify', '--db', db, '--trust', `${signer.id}=${pub}`, '--run', 'p-1');
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /PL9002 LEDGER_BROKEN  run p-1: chain breaks at seq 1: hash does not match content/);
});

test('replay: every live run reproduced through the certified build; export: one run as JSON', async () => {
  await populate();
  const r = poly('journal', 'replay', '--db', db, '--build', a.build, '--certificate', a.certificate, '--trust', `${a.key.id}=${adm}`);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /o-1 \(shop\.Order\): 2 rows folded by poly-ref, 1 windows replayed by polygraph, reproduced/);
  const x = poly('journal', 'export', '--db', db, '--run', 'p-1');
  assert.equal(x.code, 0, x.out);
  const bundle = JSON.parse(x.out);
  assert.equal(bundle.events.at(-1).kind, 'closure');
  assert.ok(bundle.heads.length >= 1);
  assert.equal(poly('journal', 'verify', '--db', db).code, 1, 'no trusted key: nothing is vouched for');
  assert.equal(poly('journal', 'export', '--db', db).code, 64);
});

// Review B1: verify requires a signed head for every run and an anchor that covers each run's latest head.
test('review B1: deleted heads, a missing anchor, or a head the anchor does not cover are PL9002, and verify exits 1', async () => {
  const run = (...extra) => poly('journal', 'verify', '--db', db, '--trust', `${signer.id}=${pub}`, ...extra);
  await populate();
  assert.equal(run().code, 0, run().out);
  // Heads deleted: what remains is no longer vouched for.
  let sql = new DatabaseSync(db);
  sql.prepare(`DELETE FROM poly_head WHERE run = 'p-1'`).run();
  sql.close();
  let r = run('--run', 'p-1');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /PL9002 LEDGER_BROKEN  run p-1: no signed head/);
  // No anchor at all.
  await populate();
  sql = new DatabaseSync(db);
  sql.prepare('DELETE FROM poly_anchor').run();
  sql.close();
  r = run('--run', 'o-1');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no anchor covers/);
  // A head signed after the last anchor.
  await populate();
  const rt = await load(a.build, { certificate: a.certificate, trust: a.trust, store: { sqlite: db }, ledger: { keyId: signer.id, privateKeyPem: readFileSync(signer.file, 'utf8') } });
  await rt.dispatch('o-1', 'Hurry');
  await rt.signHeads();
  await rt.close();
  r = run('--run', 'o-1');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /the latest anchor covers o-1 at seq \d+, and its latest signed head is at seq \d+/);
});
