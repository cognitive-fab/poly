// Emit the polysec policy triple from a plan.
//
//   next.cjs        SAM v2 strict-profile module: one acceptor per plan action,
//                   all delegating to core/step.mjs#stepPlan over the embedded plan
//   contract.json   stateKeys, initState, actions, dataDomain, terminalStates, specialRules
//   security.json   projection/protected/adversarial, forbiddenRegions, gates, tools, capabilitySet, unenforced
//   invariants.mjs  rejectionInvariants for guards and deny rules (polygraph check()), stateInvariants for regions
//
// Byte-identical output for identical plans: keys are emitted in plan order,
// JSON is canonical, and nothing machine-specific is in the artifacts. The
// module locates polyaxion's interpreter through the package specifier and,
// failing that, through a sidecar `polyaxion.env.json` that the writer drops
// beside the triple (not part of the digest).
import { routeAction } from '../core/step.mjs';
import { canon } from '../core/canon.mjs';

export const CORE_SPECIFIER = '@cognitive-fab/polyaxion/core/step';
const pretty = (o) => JSON.stringify(JSON.parse(canon(o)), null, 2) + '\n';

export function emitTriple(plan, opts = {}) {
  const stateKeys = plan.keys.map((k) => ({ name: k.key, type: k.type === 'string' && k.domain.length <= 12 ? k.domain.map((d) => `'${d}'`).join(' | ') : k.type }));
  const initState = Object.fromEntries(plan.keys.map((k) => [k.key, k.initial]));

  // exploration domain, partitioned by route; every action has at least one sample so nothing is silently unexplored
  const byAction = Object.fromEntries(plan.actions.map((a) => [a, []]));
  for (const a of plan.samples) byAction[routeAction(plan, a)].push({ action: a });
  const patches = [];
  for (const [name, spec] of Object.entries(plan.varSpecs)) for (const d of spec.domain) patches.push({ patch: { [name]: d } });
  byAction.PATCH = patches.length ? patches : [{ patch: {} }];
  byAction.SETTLE = [{ action: { kind: 'tool.call' }, observed: { effects: [] } }, ...['read:web', 'read:private', 'egress:public', 'egress:external'].map((e) => ({ action: { kind: 'tool.call', effects: [e] }, observed: { effects: [e] } }))];
  // settle-phase transitions (02 §2.2) are explored over both outcomes of the actions their machines name
  for (const m of plan.machines) if (m.transitions.some((t) => t.phase === 'settle')) for (const a of (plan.samplesBy?.[m.id] ?? []).slice(0, 24)) for (const ok of [true, false]) byAction.SETTLE.push({ action: a, observed: { effects: a.effects ?? [], ok } });
  byAction.END = [{ reason: 'end' }];
  for (const g of plan.gates) if (!byAction[g].length) plan.findings.push({ level: 'warn', obligation: null, message: `gate ${g} has no sample in the exploration domain; gate-deletion cannot exercise it` });
  if (!byAction.PROPOSE.length) byAction.PROPOSE.push({ action: { kind: 'tool.call' } });

  const contract = {
    lang: 'javascript',
    stateKeys,
    initState,
    actions: Object.fromEntries(plan.actions.map((a) => [a, { dataFields: a === 'PATCH' ? { patch: 'RFC 7386 merge patch over declared vars' } : a === 'END' ? { reason: 'why the run ends' } : a === 'SETTLE' ? { action: 'canonical action', observed: 'observed effect classes' } : { action: 'canonical action object (kind, target, path, …)' } }])),
    dataDomain: Object.fromEntries(plan.actions.map((a) => [a, byAction[a].length ? Object.fromEntries(Object.keys(byAction[a][0]).map((f) => [f, byAction[a].map((s) => s[f])])) : { action: [] }])),
    terminalKey: plan.endedKey ?? undefined,
    terminalStates: plan.endedKey ? [true] : [],
    // polygraph compares the reasons acceptors actually fired against these names: the name must be the reason string itself
    specialRules: plan.rejections.map((r) => ({ name: r.reason, note: r.machine ? `guard #${r.guard} of machine '${r.machine}' rejects in ${r.states.join('|')} with '${r.reason}'` : `rule '${r.rule}' rejects with '${r.reason}'` })),
    noOpRule: 'An action that does not apply in the current state is reject(reason) — an observable no-op with post == pre, never a throw and never a silent mutation.',
    invariants: 'invariants.mjs',
    polyaxion: { policy: plan.policy.id, authoringDigest: plan.policy.authoringDigest, coverage: plan.coverage },
  };

  const security = {
    projection: plan.keys.map((k) => k.key),
    protected: plan.keys.map((k) => k.key),
    adversarial: Object.values(plan.vars),
    domains: Object.fromEntries(plan.keys.map((k) => [k.key, k.domain])),
    forbiddenRegions: plan.regions.length ? plan.regions.map((r) => ({ name: r.name, kind: r.kind, predicate: r.predicate })) : [{ name: 'polyaxion.none', kind: 'safety', predicate: 'false', note: 'this policy declares no state region; its proof value is rejection coverage (see contract.specialRules)' }],
    gates: plan.gates,
    tools: opts.tools ?? {},
    unknownToolPolicy: 'reject',
    capabilitySet: opts.capabilitySet ?? undefined,
    unenforced: plan.recalled,
    polyaxion: { policy: plan.policy.id, authoringDigest: plan.policy.authoringDigest, rejections: plan.rejections, coverage: plan.coverage },
  };

  const module = renderModule(plan);
  const invariants = renderInvariants(plan);
  return { module, contract: pretty(contract), security: pretty(security), invariants, contractObject: contract, securityObject: security };
}

const LOADER = `
// Locate polyaxion's plan interpreter: the package specifier when installed, else the sidecar the writer dropped beside this triple.
function loadCore(require, dir) {
  try { return require(${JSON.stringify(CORE_SPECIFIER)}); } catch {}
  const env = JSON.parse(require('fs').readFileSync(require('path').join(dir, 'polyaxion.env.json'), 'utf8'));
  return require(env.core);
}`;

function renderModule(plan) {
  const keys = plan.keys.map((k) => k.key);
  const shape = plan.keys.map((k) => `    ${JSON.stringify(k.key)}: { type: ${JSON.stringify(k.type === 'list' ? 'array' : k.type)} },`).join('\n');
  const actions = plan.actions.map((a) => `    ${JSON.stringify(a)}: { action: (d = {}) => ({ ...d }), schema: {}, domain: DOMAIN[${JSON.stringify(a)}] },`).join('\n');
  const acceptors = plan.actions.map((a) => `    ${JSON.stringify(a)}: (model) => (p, h) => accept(model, p, h, ${JSON.stringify(a)}),`).join('\n');
  return `'use strict';
// Generated by polyaxion — policy ${plan.policy.id} (authoring ${plan.policy.authoringDigest}).
// SAM v2 strict profile. Every acceptor delegates to polyaxion's plan
// interpreter over the embedded plan; nothing here re-implements an obligation.
const { createInstance } = require('@cognitive-fab/sam-pattern');
${LOADER}
const step = loadCore(require, __dirname);
const PLAN = ${JSON.stringify(stripForModule(plan))};
const DOMAIN = expandDomain(require('./contract.json').dataDomain);
function expandDomain(dd) {
  const out = {};
  for (const [a, fields] of Object.entries(dd)) {
    const names = Object.keys(fields);
    const n = names.length ? fields[names[0]].length : 0;
    out[a] = Array.from({ length: n }, (_, i) => Object.fromEntries(names.map((f) => [f, fields[f][i]])));
  }
  return out;
}
const KEYS = ${JSON.stringify(keys)};
const INITIAL_STATE = ${JSON.stringify(Object.fromEntries(plan.keys.map((k) => [k.key, k.initial])))};

const instance = createInstance({ strict: true, hasAsyncActions: false, instanceName: ${JSON.stringify(plan.policy.id)} });

function accept(model, p, { reject, next, unchanged }, action) {
  let r;
  try { r = step.stepPlan(PLAN, model, action, p || {}); }
  catch (e) { return reject('bad-execution:polyaxion:' + String(e && e.message).slice(0, 60)); }
  if (r.reject) return reject(r.reject);
  const touched = [];
  for (const k of KEYS) { if (Object.prototype.hasOwnProperty.call(r.next, k)) { next[k] = r.next[k]; touched.push(k); } }
  if (!touched.length) { for (const k of KEYS) next[k] = model[k]; return; } // an allowed no-op is an identity write, never 'unhandled'
  const rest = KEYS.filter((k) => !touched.includes(k));
  if (rest.length) unchanged(...rest);
}

const control = instance({
  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),
  component: {
    modelShape: {
${shape}
    },
    actions: {
${actions}
    },
    acceptors: {
${acceptors}
    },
    reactors: [],
  },
});

const { intents } = control;
const getState = () => instance({}).getState();
const setState = (snapshot) => { instance({}).setState(snapshot); };
const init = () => { setState(INITIAL_STATE); };
const actions = Object.fromEntries(Object.keys(intents).map((n) => [n, (d = {}) => intents[n](d)]));
module.exports = { instance, init, actions, getState, setState, PLAN };
`;
}

function stripForModule(plan) {
  const { findings, samples, coverage, obligations, ...rest } = plan;
  return rest;
}

function renderInvariants(plan) {
  const rej = plan.rejections.map((r) => {
    if (r.machine) {
      const m = plan.machines.find((x) => x.id === r.machine);
      const g = m.guards[r.guard];
      return `  { name: ${JSON.stringify('rejection:' + r.name)},
    pred: (s, action, d, v) => {
      if (!${JSON.stringify(g.in)}.includes(s[${JSON.stringify(m.key)}])) return true;
      if (!(action === 'PROPOSE' || String(action).startsWith('GATE__'))) return true;
      if (guardFires(${JSON.stringify(m.id)}, ${r.guard}, s, d) !== true) return true;
      return !!(v && v.rejected); // another obligation may refuse first; the guarded action must be refused either way
    } },`;
    }
    return `  { name: ${JSON.stringify('rejection:' + r.name)},
    pred: (s, action, d, v) => {
      if (!(action === 'PROPOSE' || String(action).startsWith('GATE__'))) return true;
      if (ruleFails(${JSON.stringify(r.rule)}, s, d) !== true) return true;
      return !!(v && v.rejected);
    } },`;
  }).join('\n');
  return `// Generated by polyaxion — invariants for policy ${plan.policy.id}.
// A predicate returns true when the rule HOLDS.
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
${LOADER}
const step = loadCore(require, dirname(fileURLToPath(import.meta.url)));
const PLAN = ${JSON.stringify(stripForModule(plan))};

function guardFires(machineId, guardIdx, s, d) {
  const m = PLAN.machines.find((x) => x.id === machineId);
  const g = m.guards[guardIdx];
  try {
    const r = step.stepPlan({ ...PLAN, rules: [], machines: [{ ...m, guards: [g], transitions: [] }], invariants: [] }, s, 'PROPOSE', d || {});
    return r.reject ? true : false;
  } catch { return null; }
}
function ruleFails(ruleId, s, d) {
  const rule = PLAN.rules.find((x) => x.id === ruleId);
  try {
    const r = step.stepPlan({ ...PLAN, rules: [rule], machines: [], invariants: [] }, s, 'PROPOSE', d || {});
    return r.reject ? true : false;
  } catch { return null; }
}

export const stateInvariants = [
${plan.machines.map((m) => `  { name: ${JSON.stringify('state:' + m.id + '.declared')}, pred: (s) => ${JSON.stringify(m.states)}.includes(s[${JSON.stringify(m.key)}]) },`).join('\n')}
${plan.regions.map((r) => `  { name: ${JSON.stringify('region:' + r.name)}, pred: (s) => { const { ${plan.keys.map((k) => k.key).join(', ')} } = s; return !(${r.predicate}); } },`).join('\n')}
];
export const transitionInvariants = [];
export const rejectionInvariants = [
${rej}
];
`;
}
