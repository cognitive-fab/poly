// Native obligations (spec 02 §2.5, 04 §2.1): a hand-written polysec triple
// embedded in a policy document, served by its own polyman kernel beside the
// PX composite. Its security.tools map is its tool surface — it is consulted
// only for calls whose host tool it labels — and its Σ lives in its own
// px_session row ('<session>@@<policy id>'). Windows it produces are appended
// under the real session with `policy` set, so receipts cover them and replay
// re-derives them through this engine.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteSessionStore } from './stores.mjs';
import { digest } from '../core/canon.mjs';

export const NATIVE_SEP = '@@';

/** Write the embedded triple to disk (polyman's loaders take paths). */
export function writeNativeTriple(dir, native) {
  mkdirSync(dir, { recursive: true });
  const files = { module: join(dir, 'next.cjs'), contract: join(dir, 'contract.json'), security: join(dir, 'security.json') };
  writeFileSync(files.module, native.module);
  writeFileSync(files.contract, JSON.stringify(native.contract, null, 2) + '\n');
  writeFileSync(files.security, JSON.stringify(native.security, null, 2) + '\n');
  return files;
}

/** The identity a receipt binds for a native policy: the triple bytes plus the authoring document's digest. */
export function nativeTripleDigest(native, authoringHash) {
  return digest({ module: native.module, contract: JSON.stringify(native.contract), security: JSON.stringify(native.security), authoring: authoringHash });
}

/**
 * Open one native obligation's kernel.
 * @param {object} pm     the polyman module
 * @param {object} o      { policy, obligation (compiled, kind 'native'), dir, store, scope, policySet }
 */
export async function openNative(pm, o) {
  const id = `${o.policy}::${o.obligation.id}`;
  const files = writeNativeTriple(o.dir, o.obligation.native);
  const engine = pm.loadEngine(files.module);
  const security = pm.loadSecurity(files.security);
  const labeler = pm.makeLabeler(security);
  const suffix = NATIVE_SEP + o.policy;
  const inner = new SqliteSessionStore(o.store, { scope: `${o.scope}#${o.policy}`, init: () => engine.init(), policySet: o.policySet, historyWindow: 1 });
  const sessions = { get: (s) => inner.get(s + suffix), set: (s, st) => inner.set(s + suffix, st), inner, suffix };
  const journal = { append: (e) => o.store.appendWindow(e.session, { ...e, policy: o.policy }, !!e.spilled), read: () => [] };
  const kernel = await pm.createPolyman({ engine, security: files.security, labeler, store: sessions, journal });
  return {
    id, policy: o.policy, short: o.obligation.id, kind: 'native', text: o.obligation.text, hint: o.obligation.hint ?? null, severity: 'deny', coverage: 'checked',
    tools: Object.keys(security.tools), regions: (security.forbiddenRegions ?? []).map((r) => r.name),
    engine, labeler, security, kernel, sessions, files,
    state(session) { return sessions.get(session); },
  };
}

/** A witness for a native refusal: no expression to show, so the machine's own reason and the labels the call carried. */
export function nativeWitness(nk, d, action) {
  const reason = String(d.reason ?? 'rejected');
  const i = reason.indexOf(':');
  const misfire = i > 0 && ['no-procedure', 'wrong-participant', 'bad-execution', 'wrong-state'].includes(reason.slice(0, i)) ? reason.slice(0, i) : null;
  const pre = action ? nk.labeler.pre({ tool: action.tool, args: {} }).map((a) => a.action) : [];
  return {
    obligation: nk.short, id: nk.id, policy: nk.policy, kind: 'native', severity: 'deny', text: nk.text, hint: nk.hint,
    misfire, detail: `machine '${nk.policy}' refused ${misfire ? reason.slice(i + 1) : reason}${d.region ? ` (forbidden region '${d.region}')` : ''}; the call was labeled ${pre.length ? pre.join(', ') : '(nothing)'} for tool '${action?.tool ?? '?'}'`,
    reason: 'native', region: d.region ?? null, expression: null, bindings: action ? { 'action.tool': action.tool, labels: pre } : {}, sequence: action ? [{ step: 'proposed', action: { kind: action.kind, tool: action.tool, target: action.target ?? null } }] : [],
    machine: { state: d.post ?? null, region: d.region ?? null, path: [] }, class: d.class ?? null,
  };
}
