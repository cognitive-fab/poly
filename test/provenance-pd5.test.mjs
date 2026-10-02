// PD5.4 (S108, S110): attributed provenance.
//   PD5-A9  a countersignature over a head's hash, made by a host adapter, is stored in its own record and checked by
//           `poly journal verify` through the adapter; a tampered one is PL9002; without an adapter it is listed as not
//           verified (not run), never as ok; the ed25519 head verifies as before;
//   PD5-A10 K11 is in PS10 after K10; a certificate lists K11 exactly when the program declares claims, and the
//           instance line names it;
//   PD5-A11 every step event carries the digest of the claims that admitted it and its lineage digest; verify binds
//           them to the journal row and the lineage record, and replay reproduces them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { replayRuntime } from '@poly/check';
import { journalCommand } from '../packages/poly-check/dist/src/journal.js';
import { ROOT } from './helpers.mjs';
import { admitted, loaded, makeKey } from './runtime-helpers.mjs';

const ANN = { kind: 'Person', attest: 'Verified', assurance: 3, principal: 'ann' };

test('PD5-A10: K11 follows K10 in PS10, and a certificate lists it exactly when the program declares claims', async () => {
  const ps = readFileSync(join(ROOT, 'docs', '04-semantics.md'), 'utf8');
  assert.ok(ps.indexOf('| K11 |') > ps.indexOf('| K10 |') && ps.indexOf('| K10 |') > 0);
  const claimed = await admitted('k11-claims', ['conformance/m5/refund.poly']);
  assert.ok(claimed.cert.poly.kernelAssumptions.includes('K11'));
  const plain = await admitted('k11-plain', ['conformance/m5/orders.poly']);
  assert.ok(!plain.cert.poly.kernelAssumptions.includes('K11'));
  const { checkFile } = await import('@poly/check');
  const { render } = await import('../packages/poly-check/dist/src/render.js');
  const r = await checkFile(join(ROOT, 'conformance/m5/refund.poly'), { root: join(ROOT, '.poly', 'test-k11') });
  assert.match(render(r), /kernel assumptions [^\n]*K11/);
});

async function busy(name, signer) {
  const a = await admitted(name, ['conformance/m5/refund.poly']);
  let caller = ANN;
  const { rt } = await loaded(a, { verifier: () => caller, ledger: signer });
  await rt.create('refund.Refund', { id: 'r' });
  await rt.dispatch('r', 'Request', { a: 2 }, { actionId: 'q0' });
  await rt.dispatch('r', 'Request', { a: 2 }, { actionId: 'q1', credentials: 'x' });
  caller = { ...ANN, principal: 'bob' };
  await rt.dispatch('r', 'Approve', {}, { actionId: 'a1', credentials: 'x' });
  return { a, rt };
}

test('PD5-A11: each step event carries the claims digest and the lineage digest; verify binds them and replay reproduces them', async () => {
  const { rt } = await busy('pd5-a11');
  try {
    const steps = (await rt.chain('r')).filter((e) => e.kind === 'step');
    const journal = await rt.getJournal('r');
    for (const e of steps) {
      const row = journal.find((x) => x.seq === e.body.seq);
      assert.match(e.body.claims ?? '', /^sha256:/, `seq ${e.body.seq} records its claims digest`);
      assert.equal(e.body.lineage, rt.lineageOf('r', row.seq).digest);
    }
    const [run] = await replayRuntime(rt, { runs: ['r'] });
    assert.deepEqual(run.diagnostics.map((d) => d.message), []);
    // An edited lineage record no longer matches its step event: verify and replay both say so.
    rt.store.db.prepare("UPDATE poly_lineage SET origin = ? WHERE run = 'r' AND seq = 2").run(JSON.stringify({ ...ANN, principal: 'mallory' }));
    assert.ok((await rt.verifyAttribution('r')).some((p) => /lineage/.test(p)));
    const [again] = await replayRuntime(rt, { runs: ['r'] });
    assert.ok(again.diagnostics.some((d) => d.code === 'PL9001' && /lineage/.test(d.message)));
  } finally { await rt.close(); }
});

test('PD5-A9: a countersignature by a host adapter is verified through it; tampered is PL9002; with no adapter it is not run', async () => {
  const dir = join(ROOT, '.poly', 'test-countersign');
  mkdirSync(dir, { recursive: true });
  const db = join(dir, `ledger-${Date.now()}.db`);
  const key = makeKey('ledger-pd5');
  const signer = { keyId: key.id, privateKeyPem: readFileSync(key.file, 'utf8') };
  // A workload-identity adapter: here an ed25519 key standing for an SVID. It signs and checks a head's hash.
  const svid = generateKeyPairSync('ed25519');
  const adapterFile = join(dir, 'adapter.mjs');
  writeFileSync(adapterFile, `import { createPublicKey, verify } from 'node:crypto';\nconst pub = createPublicKey(${JSON.stringify(svid.publicKey.export({ type: 'spki', format: 'pem' }).toString())});\nexport default { scheme: 'test-svid', verify: (hash, sig) => verify(null, Buffer.from(hash), pub, Buffer.from(sig, 'base64')) };\n`);
  const adapter = { scheme: 'test-svid', sign: async (hash) => sign(null, Buffer.from(hash), svid.privateKey).toString('base64') };
  const a = await admitted('pd5-a9', ['conformance/m5/refund.poly']);
  const { rt } = await loaded(a, { verifier: () => ANN, ledger: signer, store: { sqlite: db } });
  await rt.create('refund.Refund', { id: 'r' });
  await rt.dispatch('r', 'Request', { a: 1 }, { actionId: 'q', credentials: 'x' });
  await rt.signHeads();
  await rt.publishAnchor({ from: 0, to: Date.now() + 1e12 });
  assert.equal((await rt.countersignHeads(adapter)).length, 1);
  await rt.close();
  const out = [];
  const run = (extra) => journalCommand('verify', ['--db', db, '--trust', `${key.id}=${key.file.replace(/\.pem$/, '.pub.pem')}`, ...extra], (s) => out.push(s));
  writeFileSync(key.file.replace(/\.pem$/, '.pub.pem'), key.publicKey);
  assert.equal(await run(['--countersign', adapterFile]), 0, out.join(''));
  assert.match(out.join(''), /countersignature[^\n]*test-svid[^\n]*verified/);
  out.length = 0;
  assert.equal(await run([]), 0, out.join(''));
  assert.match(out.join(''), /countersignature[^\n]*not verified[^\n]*not run/);
  // A tampered countersignature.
  const { openStore } = await import('@poly/runtime');
  const store = openStore(db);
  store.db.prepare("UPDATE poly_countersign SET sig = ? WHERE run = 'r'").run(Buffer.alloc(64).toString('base64'));
  await store.close();
  out.length = 0;
  assert.equal(await run(['--countersign', adapterFile]), 1);
  assert.match(out.join(''), /PL9002[^\n]*countersignature/);
  void createHash; void verify;
});
