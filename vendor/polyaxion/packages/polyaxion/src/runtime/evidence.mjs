// Evidence: notary receipts over the session's windows, the four checks, and
// polyaxion's replay of kernel windows through the compiled machine.
//
// Uses polysec's notary as-is (doctrines 12, 13, 27): one ed25519 receipt per
// window, chained per session, binding the window digest, the composite
// triple digest and the composite verdict digest. The per-store key lives in
// <state dir>/notary.key (mode 0600); production deployments move signing to
// the sidecar. Signing is off the decision path: it happens at `end`, on
// `journal sign`, never inside gate/settle.
//
// Replay: polyman windows carry the kernel's pre-action names and the call
// (tool, args); polyaxion re-derives each decision by stepping the composite
// plan over args.actions with the history window rebuilt from the preceding
// allowed windows, and compares decision and post-state. The notary's own
// replay is for polysec-shaped windows and is skipped loudly here.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPairSync, createPrivateKey, createPublicKey } from 'node:crypto';
import { stepPlan } from '../core/step.mjs';
import { digest } from '../core/canon.mjs';
import { ACTIONS_TOOL } from './labeler.mjs';
import { core } from './deps.mjs';

export const notary = () => core('notary');
const polysecCanon = () => core('canon');

/** Load or create the store's signing key. Returns { signer, publicKey, publicKeyB64, keyId, created }. */
export async function loadKey(stateDir) {
  const N = await notary();
  mkdirSync(stateDir, { recursive: true });
  const keyPath = join(stateDir, 'notary.key');
  let created = false;
  if (!existsSync(keyPath)) {
    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    created = true;
  }
  const privateKey = createPrivateKey(readFileSync(keyPath, 'utf8'));
  const publicKey = createPublicKey(privateKey);
  const publicKeyB64 = N.publicKeyB64(publicKey);
  const keyId = 'key:' + digest(publicKeyB64).slice(7, 23);
  writeFileSync(join(stateDir, 'notary.pub'), JSON.stringify({ keyId, publicKey: publicKeyB64, alg: 'ed25519' }, null, 2) + '\n');
  return { signer: N.makeSigner({ keyId, privateKey }), publicKey, publicKeyB64, keyId, created };
}

/** Windows as the notary expects them: `session` present, integers only. */
function forNotary(windows, session) {
  return windows.map((w) => { const { seq, at, spilled, ...rest } = w; return { ...rest, session: rest.session ?? session, seq_hint: seq }; });
}

/**
 * Sign a session's windows into a receipt chain (whole chain, so linkage has one definition — the notary's).
 * @returns {{ receipts, count, policy, verdict, keyId }}
 */
export async function signSession({ store, session, key, policy, verdict }) {
  const N = await notary();
  const windows = store.readAllWindows(session);
  if (!windows.length) return { receipts: [], count: 0, policy, verdict, keyId: key.keyId, note: 'empty journal — nothing to receipt' };
  const receipts = N.notarize({ journal: forNotary(windows, session), policy, verdict, provenAt: windows.length, signer: key.signer, sessionOf: () => session });
  store.putReceipts(session, receipts);
  return { receipts, count: receipts.length, policy, verdict, keyId: key.keyId };
}

/** The four checks (replay skipped loudly: polyman windows are not polysec windows) plus polyaxion's replay. */
export async function verifySession({ store, session, publicKey, policy, verdict, plan, labeler, scope = null, natives = [] }) {
  const N = await notary();
  const windows = store.readAllWindows(session);
  const receipts = store.getReceipts(session);
  if (!receipts.length) return { ok: false, unreceipted: windows.length, note: windows.length ? 'session has windows but no receipts — run sign' : 'empty session' };
  const v = N.verifyAll({ receipts, journal: forNotary(windows, session), publicKey, policyExpected: policy, verdictExpected: verdict, report: null, spec: null, expectCurrent: false });
  // window binding: every receipt names the digest of the window it stands for (the notary's replay does this for polysec windows; here it is done directly)
  const C = await polysecCanon();
  const jw = forNotary(windows, session);
  const mismatches = [];
  if (receipts.length !== jw.length) mismatches.push({ kind: 'count', receipts: receipts.length, windows: jw.length });
  for (let i = 0; i < Math.min(receipts.length, jw.length); i++) {
    const d = C.digest(C.canon(C.canonicalWindow(jw[i])));
    if (receipts[i].window !== d) mismatches.push({ kind: 'window', seq: windows[i].seq, receipt: i });
  }
  const windowsOk = mismatches.length === 0;
  const replay = replaySession({ windows, plan, labeler, scope, natives });
  const ok = v.checks.signature.ok && v.checks.chain.ok && v.checks.binding.ok && windowsOk && replay.ok;
  // m4: did the session end lawfully? reported beside ok, never inside it (doctrine 26)
  const hasDischarge = (plan?.machines ?? []).some((m) => m.discharge);
  const endW = [...windows].reverse().find((w) => w.discharge);
  const discharge = !hasDischarge ? 'none' : !endW ? 'unended' : Object.values(endW.discharge).every((d) => d.discharged) ? 'closed' : 'open';
  return { ok, discharge, dischargeDetail: endW ? endW.discharge : null, checks: { signature: v.checks.signature, chain: v.checks.chain, binding: v.checks.binding, windows: { ok: windowsOk, mismatches }, replay: { ok: replay.ok, ran: true, steps: replay.steps, divergences: replay.divergences, notaryReplay: v.checks.replay } }, currency: v.currency, receipts: receipts.length, windows: windows.length, unreceipted: Math.max(0, windows.length - receipts.length) };
}

/** Re-derive every kernel decision of a session from its windows. */
export function replaySession({ windows, plan, labeler, scope = null, natives = [] }) {
  const divergences = []; let steps = 0; let allowed = 0; const history = []; const escalatedBefore = new Set();
  for (const w of windows) {
    if (w.policy && (w.decision === 'allow' || w.decision === 'reject')) { // a native obligation's window: re-derive through its own engine
      steps++;
      const nk = natives.find((n) => n.policy === w.policy);
      if (!nk) { divergences.push({ seq: w.seq, recorded: { decision: w.decision, reason: w.reason ?? null }, replayed: null, note: `no native engine for policy '${w.policy}' in the scope now` }); continue; }
      let model = { ...w.pre }; let reject = null;
      for (const a of nk.labeler.pre({ tool: w.data?.tool, args: w.data?.args })) {
        let r; try { r = nk.engine.step(model, a.action, a.data); } catch (e) { r = { rejected: true, reason: 'engine-error: ' + e.message, post: model }; }
        if (r.rejected) { reject = r.reason; break; }
        model = r.post;
      }
      const decision = reject ? 'reject' : 'allow';
      const postOk = decision === 'allow' ? digest(model) === digest(w.post) : true;
      const reasonOk = decision === 'reject' ? reject === w.reason : true;
      if (decision !== w.decision || !postOk || !reasonOk) divergences.push({ seq: w.seq, policy: w.policy, recorded: { decision: w.decision, reason: w.reason ?? null }, replayed: { decision, reason: reject }, postMatches: postOk });
      continue;
    }
    if (!w.data || w.data.tool !== ACTIONS_TOOL || !Array.isArray(w.action) || (w.decision !== 'allow' && w.decision !== 'reject')) continue;
    steps++;
    const args = w.data.args ?? {};
    // the live gate numbers a call as (allowed proposals so far) + 1, in the session's scope
    const run = { id: w.session, scope: scope ?? plan.policy.scope, step: allowed + 1 };
    let model = { ...w.pre }; let reject = null;
    // an approval lifts a recorded escalation only (02 §2.6): the gate refuses a ref no earlier window of this session escalated, before any obligation
    if (args.approved && !escalatedBefore.has(String(args.approved.ref))) reject = 'wrong-participant:polyaxion:approval-unmatched';
    const pre = reject ? [] : labeler.pre({ tool: ACTIONS_TOOL, args: { ...args, [Symbol.for('polyaxion.history')]: history, [Symbol.for('polyaxion.run')]: run } });
    for (const a of pre) {
      let r;
      try { r = stepPlan(plan, model, a.action, a.data); } catch (e) { r = { reject: 'bad-execution:polyaxion:' + e.message, next: {} }; }
      if (r.reject) { reject = r.reject; break; }
      model = { ...model, ...r.next };
    }
    const decision = reject ? 'reject' : 'allow';
    const postOk = decision === 'allow' ? digest(model) === digest(w.post) : true;
    const reasonOk = decision === 'reject' ? reject === w.reason : true;
    if (decision !== w.decision || !postOk || !reasonOk) divergences.push({ seq: w.seq, recorded: { decision: w.decision, reason: w.reason ?? null }, replayed: { decision, reason: reject }, postMatches: postOk });
    if (w.decision === 'allow') { allowed++; for (const a of args.actions ?? []) history.push({ step: allowed, action: a, verdict: 'allow', violated: [] }); }
    if (w.decision === 'reject' && /:escalate$/.test(String(w.reason ?? '')) && args.meta?.tool_use_id) escalatedBefore.add(String(args.meta.tool_use_id));
  }
  return { ok: divergences.length === 0, steps, divergences };
}
