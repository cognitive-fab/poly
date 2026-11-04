// S586, the amended criteria (RT21 to RT23): a second desk, beside risk-desk.mjs's, so RT10's store stays as it was.
// Its policy escalates a refund on unknown input and refuses a wire on unknown input, and a never statement relies on a
// rule that refuses every ping. Its cases give two exhausted outcomes: one a person resolves with a step that carries
// claims, after a step that carries none; one with only the step that carries none (PT34.4 item 5).
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admit } from '@poly/check';
import { load } from '@poly/runtime';
import { ROOT } from '../../helpers.mjs';
import { approveAs, handleWith, makeKey, project, signPolicies } from '../../runtime-helpers.mjs';
import { T0, ESCALATION_TIMEOUT_MS, untag } from './risk-desk.mjs';

export const DESK2 = readFileSync(join(ROOT, 'test', 'fixtures', 's586', 'riskdesk-amended.poly'), 'utf8');

export const DESK2_POLICY = [
  '// S586: the amended desk\'s policy, tagged (PT8.6).',
  'module riskdesk2_policy',
  '',
  'policy desk2 {',
  '  scope "riskdesk2"',
  '  obligation refund-while-clerk-works "A refund waits for a person unless the clerk is working." mitigates "mit:7.3" implements "iso:A.9.2" rule {',
  '    when effect.kind == "desk2.refund" && machine("riskdesk2.Clerk").phase == Working',
  '    require false else deny',
  '    on unknown escalate',
  '  }',
  '  obligation wire-while-clerk-works "A wire is refused unless the clerk is working." mitigates "mit:4.3" rule {',
  '    when effect.kind == "desk2.wire" && machine("riskdesk2.Clerk").phase == Working',
  '    require false else deny',
  '    on unknown deny',
  '  }',
  '  obligation no-ping "The clerk pings nobody." mitigates "mit:6.1" rule {',
  '    when effect.kind == "clerk2.ping"',
  '    require false else deny',
  '  }',
  '  never no-ping-allowed "No ping is ever allowed." mitigates "mit:6.1"',
  '    : allow when effect.kind == "clerk2.ping"',
  '}',
  '',
].join('\n');

/** The person whose claims the resolving step carries, and a canary for them: the report prints no claim (item 5, 7). */
export const STAFF = 'canary-staff-7c41d2';

export const RUNS2 = {
  unknownApproved: 'r-u-approved', unknownTimedOut: 'r-u-timeout', unknownOpen: 'r-u-open', unknownRefused: 'w-u-1',
  resolved: 'case-resolved', unresolved: 'case-unresolved',
};

/** The amended desk as a project, its policy signed by a person, not yet admitted. */
export async function desk2Project({ tagged, name, key = makeKey(name) }) {
  const dir = project(name, [], key, 'test-s586-report');
  writeFileSync(join(dir, 'src', 'riskdesk2.poly'), DESK2);
  writeFileSync(join(dir, 'src', 'riskdesk2.policy.poly'), tagged ? DESK2_POLICY : untag(DESK2_POLICY));
  await signPolicies(dir);
  return { dir, key };
}

/** Admits the amended desk (tagged or not) and runs RUNS2 through the runtime on a store file with a ledger signer. */
export async function desk2Scenario({ tagged, name = tagged ? 's586-desk2-tagged' : 's586-desk2-untagged' } = {}) {
  const { dir, key } = await desk2Project({ tagged, name });
  const admitted = await admit(dir);
  const build = join(dir, '.poly', 'build');
  const certificate = join(dir, 'certificate.json');
  copyFileSync(admitted.certificatePath, certificate);
  const signer = makeKey(`${name}-ledger`);
  const db = join(dir, 'store.db');
  for (const f of [db, `${db}-wal`, `${db}-shm`, `${db}.lock.db`]) rmSync(f, { force: true });
  let t = T0;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const rt = await load(build, {
    certificate: admitted.certificatePath, trust: { [key.id]: key.publicKey }, now: clock.now,
    store: { sqlite: db }, ledger: { keyId: signer.id, privateKeyPem: readFileSync(signer.file, 'utf8') },
    gate: { escalationTimeoutMs: ESCALATION_TIMEOUT_MS },
    verifier: (c) => (c ? { principal: c.principal } : null),
  });
  const steps = {};
  try {
    // One handler module serves every kind (runtime-helpers.mjs), and here every call fails: each allowed note, and the
    // approved refund, is exhausted.
    for (const kind of ['desk2.note', 'desk2.wire', 'desk2.refund', 'clerk2.ping']) handleWith(rt, kind, () => { throw new Error('scripted failure'); });
    const go = async (machine, id) => { await rt.create(`riskdesk2.${machine}`, { id }); await rt.dispatch(id, 'Go'); };
    const settle = async (n = 8) => { for (let k = 0; k < n; k++) { clock.advance(1_000); await rt.worker.tick(); } };
    const intentOf = async (id) => (await rt.outbox(id))[0].intent_id;
    await go('Wire', RUNS2.unknownRefused);
    await settle(4);
    await go('Refund', RUNS2.unknownApproved);
    await settle(2);
    await approveAs(rt, await intentOf(RUNS2.unknownApproved));
    await settle(12);
    await go('Refund', RUNS2.unknownTimedOut);
    await settle(2);
    clock.advance(ESCALATION_TIMEOUT_MS + 60_000);
    await settle(2);
    for (const id of [RUNS2.resolved, RUNS2.unresolved]) { await go('Case', id); await settle(12); }
    // After each exhausted outcome: a step with no claims, then, on one case only, a person's step with claims.
    for (const id of [RUNS2.resolved, RUNS2.unresolved]) steps[`${id}:Note`] = await rt.dispatch(id, 'Note');
    steps[`${RUNS2.resolved}:Resolve`] = await rt.dispatch(RUNS2.resolved, 'Resolve', {}, { credentials: { principal: STAFF } });
    await go('Refund', RUNS2.unknownOpen);
    await settle(2);
    await rt.signHeads();
    await rt.publishAnchor({ from: 0, to: clock.now() + 1 });
  } finally { await rt.close(); }
  const ledger = join(dir, 'ledger.pub.pem');
  const adm = join(dir, 'admission.pub.pem');
  writeFileSync(ledger, signer.publicKey);
  writeFileSync(adm, key.publicKey);
  return { dir, key, signer, db, build, certificate, cert: admitted.certificate, trust: { ledger: { id: signer.id, file: ledger }, admission: { id: key.id, file: adm } }, steps };
}
