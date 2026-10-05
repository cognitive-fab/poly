// The M8a review, part A: workflows on poly-runtime (S173 to S175, S188, S189, the store lock). Each test failed on
// the tree before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import { admit } from '@poly/check';
import { loadRun } from '@poly/runtime';
import { ROOT } from './helpers.mjs';
import { admitted, loaded, approvalFor, makeKey, project } from './runtime-helpers.mjs';

const BRIEF = 'conformance/m6/customer-brief.poly';
const WIN = process.platform === 'win32';
/** A path's 8.3 short form, or null where the volume makes none. */
const shortOf = (p) => { const s = execSync(`cmd /c for %I in ("${p}") do @echo %~sI`, { encoding: 'utf8' }).trim(); return s.toLowerCase() === p.toLowerCase() ? null : s; };

function runProject(name, run) {
  const key = makeKey(name);
  const dir = project(name, [BRIEF], key, 'test-review-m8a-a');
  writeFileSync(join(dir, 'admission.pub.pem'), key.publicKey);
  const m = JSON.parse(readFileSync(join(dir, 'poly.json'), 'utf8'));
  m.run = { trust: { [key.id]: 'file:admission.pub.pem' }, ...run };
  writeFileSync(join(dir, 'poly.json'), JSON.stringify(m, null, 2));
  return { dir, m, save: () => writeFileSync(join(dir, 'poly.json'), JSON.stringify(m, null, 2)) };
}

test('A-F1, S188: a signer inside the project is refused when named by its 8.3 short path', { skip: !WIN && 'Windows 8.3 names only', timeout: 180_000 }, async (t) => {
  const p = runProject('review-a-signer', {});
  await admit(p.dir);
  const keyDir = join(p.dir, 'ledgerkeysdirectory');
  mkdirSync(keyDir, { recursive: true });
  const keyFile = join(keyDir, 'ledgersigningkey.pem');
  writeFileSync(keyFile, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const short = shortOf(keyFile);
  if (!short) { t.skip('this volume makes no 8.3 names'); return; }
  p.m.run.ledger = { keyId: 'ops-ledger', signer: `file:${short}` };
  p.save();
  await assert.rejects(loadRun(p.dir), /inside the project/);
});

test('A-F2, S189: an approvals entry that cannot be read is refused and journaled, and the records after it are taken', { skip: !WIN && 'a junction and an ACL', timeout: 180_000 }, async () => {
  const build = await admitted('review-a-poison', [BRIEF]);
  const gate = { propose: (p) => (p.effectKind === 'post_brief' && !p.approved ? { decision: 'escalate', reason: 'public-post' } : { decision: 'allow' }), settle: () => 'ok' };
  const RESULTS = { fetch_tickets: { count: 2 }, draft_brief: {}, request_approval: {}, post_brief: {} };
  const base = join(ROOT, '.poly', 'test-review-m8a-a', 'approvals');
  mkdirSync(base, { recursive: true });
  for (const kind of ['junction', 'unreadable']) {
    const { rt } = await loaded(build, { gate: { gate } });
    const dir = mkdtempSync(join(base, `${kind}-`));
    try {
      const { instanceId } = await rt.startWorkflow('customer-brief', { date: '2026-10-04' });
      for (let k = 0; k < 6; k++) {
        await rt.advance();
        const [o] = await rt.workOrders(instanceId);
        if (!o) break;
        await rt.reportWorkOrder(o.orderId, { ok: true, result: RESULTS[o.kind] });
      }
      await rt.advance();
      const intent = rt.store.db.prepare("SELECT intent_id FROM pr_outbox WHERE instance_id = ? AND kind = 'post_brief'").get(instanceId).intent_id;
      if (kind === 'junction') symlinkSync(join(dir, 'no-such-dir'), join(dir, '000-bad.json'), 'junction');
      else { writeFileSync(join(dir, '000-bad.json'), '{}'); execFileSync('icacls', [join(dir, '000-bad.json'), '/deny', `${userInfo().username}:(R)`], { stdio: 'ignore' }); }
      writeFileSync(join(dir, '001-approve.json'), JSON.stringify(await approvalFor(rt, intent)));
      const out = await rt.takeApprovals(dir);
      assert.deepEqual(out.map((x) => [x.file, x.outcome, x.reason ?? null]), [['000-bad.json', 'refused', 'not-a-record'], ['001-approve.json', 'applied', null]], kind);
      assert.deepEqual(await rt.takeApprovals(dir), [], `${kind}: each entry is journaled once`);
      const journal = (await rt.chain('runtime:approvals')).filter((e) => e.body?.stage === 'approval').map((e) => [e.body.file, e.body.outcome]);
      assert.deepEqual(journal, [['000-bad.json', 'refused'], ['001-approve.json', 'applied']], kind);
    } finally {
      await rt.close();
      for (const f of [join(dir, '000-bad.json'), join(dir, 'refused', '000-bad.json')]) if (existsSync(f)) try { execFileSync('icacls', [f, '/remove:d', userInfo().username], { stdio: 'ignore' }); } catch { /* a junction has no ACL to restore */ }
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('A-F3, S174: a second runtime that names the owned store another way is refused; a store with two names is refused', { skip: !WIN && 'Windows 8.3 names', timeout: 180_000 }, async (t) => {
  const p = runProject('review-a-lock', { store: 'state/store.sqlite' });
  await admit(p.dir);
  const first = await loadRun(p.dir);
  const storeFile = join(p.dir, 'state', 'store.sqlite');
  try {
    const short = shortOf(storeFile);
    if (short) {
      p.m.run.store = short;
      p.save();
      await assert.rejects(loadRun(p.dir), /one process owns a store at a time/);
    } else t.diagnostic('this volume makes no 8.3 names; the short-name case did not run');
  } finally { await first.close(); }
  const hard = join(p.dir, 'state', 'same-store.sqlite');
  linkSync(storeFile, hard);
  try {
    for (const s of ['state/store.sqlite', hard]) {
      p.m.run.store = s;
      p.save();
      await assert.rejects(loadRun(p.dir), /has 2 names/, s);
    }
  } finally { rmSync(hard, { force: true }); }
  assert.ok(readdirSync(join(p.dir, 'state')).every((f) => !/same-store/.test(f)));
});
