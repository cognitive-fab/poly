// Mandate m2 — lawfully dischargeable (spec 03 §8): from every Σ reachable
// over the exploration domain, some sequence of allowed actions reaches a Σ in
// which END is accepted. A machine that can be trapped in a state from which
// no allowed action leads to discharge is refused at admission, with the
// trapping state and the path into it named.
//
// Exploration is the plan interpreter over the plan's own samples (the same
// action domain the compiler hands polygraph), so what is proved here is what
// the kernel runs. Deterministic, bounded by maxStates; a bounded result is
// reported as such, never as clean (doctrine 24).
import { stepPlan, routeAction, END, SETTLE } from '../core/step.mjs';
import { digest } from '../core/canon.mjs';

/** Per machine with discharge states: where it is and whether that is a discharge state. */
export function dischargeOf(plan, model) {
  const out = {};
  for (const m of plan.machines ?? []) {
    if (!m.discharge) continue;
    const state = model ? model[m.key] : m.initial;
    out[m.id] = { state, discharged: m.discharge.includes(state) };
  }
  return out;
}

/**
 * @param {object} plan
 * @param {object} [opts] { maxStates?: number }
 * @returns {{ ok, applicable, statesExplored, capHit, dischargeable, trapped: { state, machines, path }[] }}
 */
export function checkDischarge(plan, opts = {}) {
  const maxStates = opts.maxStates ?? 5000;
  const machines = (plan.machines ?? []).filter((m) => m.discharge);
  if (!machines.length) return { ok: true, applicable: false, statesExplored: 0, capHit: false, dischargeable: 0, trapped: [], perMachine: {} };
  // one machine at a time, over its own action domain, with every rule in force
  // (a rule can block the recovery action); other machines stay at their initial
  // state. Exploring the product of thirty machines finds nothing this does not
  // and starves the sample domain (a thirty-obligation policy was refused for a
  // recovery command that fell past the sample cap).
  let statesExplored = 0, dischargeable = 0, capHit = false; const trapped = []; const perMachine = {};
  for (const m of machines) {
    const sub = { ...plan, machines: [m], invariants: [] };
    // the machine's own domain plus every rule's: a rule in force can refuse the recovery action unless it is shaped the way that rule accepts (a commit-message rule blocked corp05's recovery commit until its own well-formed sample was in the domain)
    const ruleIds = new Set((plan.rules ?? []).map((r) => r.id));
    const samples = plan.samplesBy ? dedupe([...(plan.samplesBy[m.id] ?? []), ...Object.entries(plan.samplesBy).filter(([id]) => ruleIds.has(id)).flatMap(([, l]) => l)]) : plan.samples;
    const r = explore(sub, samples, m, maxStates);
    statesExplored += r.states; dischargeable += r.dischargeable; capHit = capHit || r.capHit;
    perMachine[m.id] = { statesExplored: r.states, dischargeable: r.dischargeable, capHit: r.capHit, trapped: r.trapped.length };
    for (const t of r.trapped) { trapped.push(t); if (trapped.length >= 5) break; }
  }
  return { ok: trapped.length === 0 && !capHit, applicable: true, statesExplored, capHit, dischargeable, trapped, perMachine };
}

function explore(plan, samples, machine, maxStates) {
  const settles = machine.transitions.some((t) => t.phase === 'settle');
  const init = Object.fromEntries(plan.keys.map((k) => [k.key, k.initial]));
  const run = { id: 'm2', scope: plan.policy?.scope ?? '**', step: 1 };
  const data = (a) => ({ action: a, history: [], run });
  const key = (m) => digest(m);
  const states = new Map(); const queue = [init]; const succ = new Map(); let capHit = false;
  states.set(key(init), { model: init, parent: null, via: null });
  while (queue.length) {
    const model = queue.shift(); const k = key(model); const out = new Set();
    for (const a of samples ?? []) {
      let r; try { r = stepPlan(plan, model, routeAction(plan, a), data(a)); } catch { continue; }
      if (r.reject) continue;
      const next = { ...model, ...r.next };
      if (plan.endedKey && next[plan.endedKey] === true) continue;
      const nk = key(next); out.add(nk);
      if (!states.has(nk)) { if (states.size >= maxStates) { capHit = true; continue; } states.set(nk, { model: next, parent: k, via: a }); queue.push(next); }
      // the effect ran: settle over both outcomes (settle-phase transitions read observed.ok)
      if (settles) for (const ok of [true, false]) {
        let sr; try { sr = stepPlan(plan, next, SETTLE, { action: a, observed: { effects: a.effects ?? [], ok }, history: [], run }); } catch { continue; }
        if (sr.reject) continue;
        const after = { ...next, ...sr.next }; const ak = key(after);
        if (ak === nk) continue;
        if (!states.has(ak)) { if (states.size >= maxStates) { capHit = true; continue; } states.set(ak, { model: after, parent: nk, via: { ...a, settled: ok } }); queue.push(after); }
        if (!succ.has(nk)) succ.set(nk, new Set());
        succ.get(nk).add(ak);
      }
    }
    if (succ.has(k)) for (const x of succ.get(k)) out.add(x);
    succ.set(k, out);
  }
  const disch = new Set();
  for (const [k, s] of states) { let r; try { r = stepPlan(plan, s.model, END, { reason: 'end', history: [], run }); } catch { continue; } if (!r.reject) disch.add(k); }
  let grew = true;
  while (grew) { grew = false; for (const [k, out] of succ) { if (disch.has(k)) continue; for (const nk of out) if (disch.has(nk)) { disch.add(k); grew = true; break; } } }
  const trapped = [];
  for (const [k, s] of states) {
    if (disch.has(k)) continue;
    const path = [];
    for (let cur = s; cur && cur.parent !== null; cur = states.get(cur.parent)) path.unshift({ action: trim(cur.via), state: project(plan, cur.model) });
    trapped.push({ state: project(plan, s.model), machines: [{ id: machine.id, state: s.model[machine.key], discharge: machine.discharge }], path });
    if (trapped.length >= 3) break;
  }
  return { states: states.size, dischargeable: disch.size, capHit, trapped };
}

function dedupe(list) { const seen = new Set(); const out = []; for (const a of list) { const k = digest(a); if (seen.has(k)) continue; seen.add(k); out.push(a); } return out; }
function project(plan, model) {
  const out = {};
  for (const m of plan.machines ?? []) out[m.id] = model[m.key];
  for (const [name, k] of Object.entries(plan.vars ?? {})) out[name] = model[k];
  return out;
}
function trim(a) { if (!a) return null; const o = {}; for (const [k, v] of Object.entries(a)) if (v !== null && v !== undefined && v !== '') o[k] = v; return o; }
