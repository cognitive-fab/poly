// polyvers lanes on policy replacement (spec 03 §10, 07 §9).
//
// When a servable policy is replaced while sessions are live in a scope, the
// scope's composite changes under them. polyvers classifies the change between
// the old and new composite triples (lanes: shape, vocabulary, intent,
// semantic, migration) and runs the lanes' gates with the live Σ as the fleet
// corpus — after polyaxion's own migration (shared keys carried, new keys
// initial), which is what the sessions will actually hold.
//
// What is `breaking` here is what spec 03 §10 says: a live Σ the new machine
// cannot load (load, shape-roundtrip), one already inside a declared region
// (invariants-pointwise), or one that can be driven into a region
// (semantic-model-check). The vocabulary and stimuli gates are about in-flight
// stimuli from old callers; polyaxion's labeler routes every call by the new
// plan, so their findings are recorded as notes, never as a refusal.
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { engines } from '../admission.mjs';
import { writeTriple } from '../compile/index.mjs';
import { compositeDoc } from './gate.mjs';

const BREAKING = new Set(['load', 'shape-roundtrip', 'invariants-pointwise', 'semantic-model-check']);
let pvPromise = null;
function polyvers(dir) {
  if (!pvPromise) {
    pvPromise = (async () => {
      const u = (f) => pathToFileURL(join(dir, 'polyvers', 'src', f)).href;
      const [artifacts, classify, gates] = await Promise.all([import(u('artifacts.mjs')), import(u('classify.mjs')), import(u('gates.mjs'))]);
      return { ...artifacts, ...classify, ...gates };
    })();
  }
  return pvPromise;
}

function writeComposite(scope, docs, dir) {
  const doc = compositeDoc(scope, docs);
  if (!doc.obligations.length) return null;
  const r = writeTriple(doc, dir);
  // polyvers refuses an invariants file that exports nothing; a composite without regions or rejections has nothing to state
  if (!r.plan.regions.length && !r.plan.rejections.length) unlinkSync(r.files.invariants);
  return r;
}

/**
 * @param {object} o { scope, before: doc[], after: doc[], sessions: [{ session_id, state }], maxStates? }
 * @returns {Promise<object>} { verdict: 'compatible' | 'migration-needed' | 'breaking' | 'unavailable', lanes, gates, failed, notes, ... }
 */
export async function checkReplacement({ scope, before, after, sessions, maxStates = 20000 }) {
  const E = await engines();
  if (E.unavailable) return { verdict: 'unavailable', scope, sessions: sessions.length, error: `polygraph engines unavailable (${E.unavailable})`, lanes: [], gates: {}, failed: [], notes: [] };
  const pv = await polyvers(E.dir);
  const tmp = mkdtempSync(join(tmpdir(), 'px-compat-'));
  try {
    const o = writeComposite(scope, before, join(tmp, 'old'));
    const n = writeComposite(scope, after, join(tmp, 'new'));
    if (!o || !n) return { verdict: 'compatible', scope, sessions: sessions.length, lanes: [], gates: {}, failed: [], notes: [!o ? 'no PX composite before the change' : 'no PX composite after the change'] };
    const oldA = await pv.loadArtifacts(o.dir);
    const newA = await pv.loadArtifacts(n.dir);
    const cls = pv.classify(oldA, newA);
    if (cls.identical) return { verdict: 'compatible', scope, sessions: sessions.length, lanes: [], gates: {}, failed: [], notes: ['composite unchanged'], identical: true };
    // the corpus: live Σ as the runtime migrates them (07 §4)
    const init = Object.fromEntries(n.plan.keys.map((k) => [k.key, k.initial]));
    const seen = new Set(); const corpus = [];
    for (const s of sessions) {
      const st = {}; for (const k of Object.keys(init)) st[k] = Object.prototype.hasOwnProperty.call(s.state ?? {}, k) ? s.state[k] : init[k];
      const key = E.stable(st); if (seen.has(key)) continue; seen.add(key);
      corpus.push({ id: s.session_id, state: st, key, source: 'live' });
    }
    const hasRegions = (newA.invariants ?? []).length > 0;
    const gates = {}; const failed = []; const notes = [];
    const order = [...cls.gates.filter((g) => !pv.NEEDS_CORPUS.has(g)), ...cls.gates.filter((g) => pv.NEEDS_CORPUS.has(g))];
    for (const g of order) {
      if (g === 'migrate') { gates[g] = { ok: true, skipped: 'polyaxion migrates Σ itself: shared keys carried, new keys initial (applied to the corpus above)' }; continue; }
      if ((g === 'semantic-model-check' || g === 'invariants-pointwise') && !hasRegions) { gates[g] = { ok: true, skipped: 'the new composite declares no region; there is nothing a live Σ could be inside or driven into' }; continue; }
      const run = pv.GATE_RUNNERS[g];
      let r;
      try { r = run ? run({ oldA, newA, diffs: cls.diffs, corpus, opts: { maxStates, allowBounded: false } }) : { ok: false, failures: [{ message: `no runner for gate '${g}'` }] }; } catch (e) { r = { ok: false, failures: [{ message: String(e && e.message) }] }; }
      gates[g] = { ok: r.ok, summary: r.summary ?? null, failures: (r.failures ?? []).slice(0, 5).map((f) => f.message + (f.id ? ` [${f.id}]` : '')) };
      if (!r.ok) { if (BREAKING.has(g)) failed.push(g); else notes.push(`${g}: ${gates[g].failures[0]}`); }
    }
    const verdict = failed.length ? 'breaking' : cls.lanes.includes('shape') ? 'migration-needed' : 'compatible';
    return { verdict, scope, sessions: sessions.length, corpus: corpus.length, changeId: cls.changeId, lanes: cls.lanes, gates, failed, notes, migration: cls.lanes.includes('shape') ? 'shared keys carried, new keys initial' : null };
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
  }
}
