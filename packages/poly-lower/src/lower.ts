// Lowering of one machine to the artefacts the engines read (02 §4, PT4.5, PT5):
//   contract.json   stateKeys (control field first), initState, actions, dataDomain, terminalStates
//   next.cjs        a SAM v2 strict-profile module: sealed modelShape, named intents with
//                   schemas and domains, keyed acceptors, reject/next/unchanged
//   invariants.mjs  stateInvariants, transitionInvariants, rejectionInvariants
import type * as A from '@poly/core';
import { diag, digest, type CheckResult, type Diagnostic, type MachineFacts, type Ty, type TypeEnv } from '@poly/core';
import { layoutOf, prelude, isPayloadUnion, payloadTy, type Layout } from './layout.js';
import { expr, stmts, mayWrite, resetNames, type Cx, type EmitOptions } from './emit.js';

export interface LowerOptions {
  /** Test-only fault injection; `poly check` never sets it (faults.ts). */
  fault?: Fault;
}

export type Fault = 'drop-frame' | 'swap-reason' | 'off-by-one' | 'invert-require' | 'skip-guard' | 'skip-terminal';

export interface Lowered {
  machine: string;
  files: { 'contract.json': string; 'next.cjs': string; 'invariants.mjs': string };
  contract: Record<string, unknown>;
  layout: Layout;
}

export function lowerMachine(module: A.Module, check: CheckResult, machineName: string, opts: LowerOptions = {}): { lowered: Lowered | null; diagnostics: Diagnostic[] } {
  // Only a program the checker accepted is lowered: every later step relies on its guarantees (finite domains, typed names).
  const refused = check.diagnostics.filter((d) => d.severity === 'error');
  if (refused.length) return { lowered: null, diagnostics: refused };
  const facts = check.machines.get(machineName);
  if (!facts) throw new Error(`poly-lower: no checked machine ${machineName}`);
  const m = facts.machine;
  const { layout, diagnostics } = layoutOf(m, facts, check.env, module.name);
  const actions = m.items.filter((i): i is A.Action => i.kind === 'Action');
  for (const a of actions) {
    for (const p of a.params) {
      const t = paramTy(p, check.env);
      if (t.k === 'ref' || t.k === 'map' || isPayloadUnion(check.env, t)) {
        diagnostics.push(diag('PL0901', { module: module.name, machine: m.name, node: p.id, line: p.span?.line, col: p.span?.col }, `a parameter of type ${t.k === 'union' ? t.name : t.k} is lowered after milestone M0: ${a.name}.${p.name}`));
      }
    }
  }
  if (diagnostics.length) return { lowered: null, diagnostics };
  resetNames();

  const env = check.env;
  const base = { facts, env, layout };
  const pre = prelude(layout);
  const emitOpts: EmitOptions = { dropFrame: opts.fault === 'drop-frame' };
  const mutated = applyFault(m, opts.fault);

  // ── initial state ────────────────────────────────────────────────────
  const initCx: Cx = { ...base, mode: 'init', stateVar: 'model', dataVar: 'data' };
  const initLines = m.fields.map((f) => {
    const l = layout.byField.get(f.name)!;
    const v = expr(f.init, initCx);
    return l.kind === 'union' ? `  __w(next, ${JSON.stringify(f.name)}, ${v});` : `  next[${JSON.stringify(f.name)}] = ${v};`;
  });
  const initCode = `(() => {\n  const next = {};\n${initLines.join('\n')}\n  return next;\n})()`;
  // The generated code is evaluated here once, at build time, to fill contract.json. It is the code
  // the engines run anyway: names come from the lexer ([A-Za-z0-9_$] only) and every literal is JSON-escaped.
  const initState = new Function(`${pre}\nreturn ${initCode};`)() as Record<string, unknown>;

  // ── terminal (S6: also the first acceptor, so polygraph never steps out of a terminal state) ──
  const terminal = mutated.items.find((i): i is A.Terminal => i.kind === 'Terminal');
  const stateCx: Cx = { ...base, mode: 'state', stateVar: 'model', dataVar: 'proposal' };
  const termCode = terminal ? expr(terminal.expr, stateCx) : 'false';
  const control = layout.fields[0];
  const terminalStates = terminal ? controlValues(m.fields[0], facts, env).filter((v) => {
    const fn = new Function(`${pre}\nreturn (model) => ${termCode};`)() as (s: unknown) => boolean;
    return fn({ ...initState, [control.field]: v });
  }) : [];

  // ── acceptors ────────────────────────────────────────────────────────
  const handlers = new Map(mutated.items.filter((i): i is A.Handler => i.kind === 'Handler').map((h) => [h.action, h]));
  const guards = mutated.items.filter((i): i is A.Guard => i.kind === 'Guard');
  const handled = actions.filter((a) => handlers.has(a.name)).map((a) => a.name);
  const strict = actions.flatMap((a) => a.params.filter((p) => p.check?.mode === 'strict').map((p) => ({ a: a.name, p: p.name, values: paramValues(p, env) })));
  const acceptors: string[] = [];
  if ((terminal && opts.fault !== 'skip-terminal') || guards.length || strict.length) {
    const lines = [`    // PS3.2, rows 1 and 2, then the guards of PS2.2 (handled actions only).`, `    '*': (model) => (proposal, { reject }) => {`, `      const action = proposal.__actionName;`];
    if (terminal && opts.fault !== 'skip-terminal') lines.push(`      if (TERMINAL(model)) return reject('terminal');`);
    for (const s of strict) lines.push(`      if (action === ${JSON.stringify(s.a)} && !${JSON.stringify(s.values)}.includes(proposal[${JSON.stringify(s.p)}])) return reject('outside-check-domain');`);
    if (guards.length) {
      lines.push(`      if (!HANDLED.has(action)) return;`);
      for (const g of guards) lines.push(`      if (${expr(g.cond, stateCx)}) return reject(${JSON.stringify(g.reason)});`);
    }
    lines.push(`    },`);
    acceptors.push(lines.join('\n'));
  }
  for (const a of actions) {
    const h = handlers.get(a.name);
    if (!h) {
      // S7: an action with no handler frames everything and writes nothing; SAM classifies the step unhandled (PS3.2).
      acceptors.push(`    ${JSON.stringify(a.name)}: (model) => (proposal, { unchanged }) => {\n      unchanged('*');\n    },`);
      continue;
    }
    const hcx: Cx = { ...base, mode: 'handler', stateVar: 'model', dataVar: 'proposal' };
    const body = stmts(h.body, hcx, '      ', emitOpts);
    const written = mayWrite(h.body, layout);
    const rest = layout.flatKeys.filter((k) => !written.has(k));
    if (rest.length && !emitOpts.dropFrame) body.push(`      unchanged(${rest.map((k) => JSON.stringify(k)).join(', ')});`);
    acceptors.push(`    ${JSON.stringify(a.name)}: (model) => (proposal, { reject, next, unchanged }) => {\n${body.join('\n')}\n    },`);
  }

  // ── next.cjs ─────────────────────────────────────────────────────────
  const modelShape: Record<string, unknown> = {};
  for (const l of layout.fields) Object.assign(modelShape, l.shapes);
  const intentDecls = actions.map((a) => {
    const schema = Object.fromEntries(a.params.map((p) => [p.name, { type: jsType(paramTy(p, env)), required: true }]));
    return `    ${JSON.stringify(a.name)}: { action: (data = {}) => ({ ...data }), schema: ${JSON.stringify(schema)}, domain: ${JSON.stringify(dataDomainOf(a, env))} },`;
  });
  const version = digest(module);
  const next = [
    `'use strict';`,
    `// Generated by poly-lower from ${module.name}.${m.name}, module digest ${version}.`,
    `// A SAM v2 strict-profile module (PT4.5). Do not edit: change the poly source and rebuild.`,
    `const { createInstance } = require('@cognitive-fab/sam-pattern');`,
    ``,
    pre,
    ``,
    `const INITIAL_STATE = ${JSON.stringify(initState)};`,
    `const TERMINAL = (model) => ${termCode};`,
    `const HANDLED = new Set(${JSON.stringify(handled)});`,
    `void HANDLED;`,
    ``,
    `// Unhandled steps are steps (PS3.3), so SAM's development warning for them is off; strict-profile errors still throw.`,
    `const instance = createInstance({ strict: true, devWarnings: false, hasAsyncActions: false, instanceName: ${JSON.stringify(`${module.name}.${m.name}`)} });`,
    ``,
    `const control = instance({`,
    `  initialState: JSON.parse(JSON.stringify(INITIAL_STATE)),`,
    `  component: {`,
    `    modelShape: ${JSON.stringify(modelShape)},`,
    `    actions: {`,
    ...intentDecls.map((l) => '  ' + l),
    `    },`,
    `    acceptors: {`,
    ...acceptors.map((a) => a.split('\n').map((l) => '  ' + l).join('\n')),
    `    },`,
    `    reactors: [],`,
    `  },`,
    `});`,
    ``,
    `const { intents } = control;`,
    `const getState = () => instance({}).getState();`,
    `const setState = (snapshot) => { instance({}).setState(snapshot); };`,
    `const init = () => {`,
    `  // A model key may shadow the state() accessor; clearing the error slot is best-effort.`,
    `  try { const s = instance({}).state(); if (s && typeof s.clearError === 'function') s.clearError(); } catch { /* shadowed */ }`,
    `  setState(INITIAL_STATE);`,
    `};`,
    `const actions = {`,
    ...actions.map((a) => `  ${JSON.stringify(a.name)}: (data = {}) => intents[${JSON.stringify(a.name)}](data),`),
    `};`,
    ``,
    `module.exports = { instance, init, actions, getState, setState };`,
    ``,
  ].join('\n');

  // ── contract.json ────────────────────────────────────────────────────
  const contract = {
    lang: 'javascript',
    machineVersion: version,
    stateKeys: layout.fields.flatMap((l) => l.flat.map((k) => ({ name: k, type: keyTypeText(l, k, env) }))),
    initState,
    actions: Object.fromEntries(actions.map((a) => [a.name, { dataFields: Object.fromEntries(a.params.map((p) => [p.name, typeText(paramTy(p, env), env)])) }])),
    terminalStates,
    dataDomain: Object.fromEntries(actions.filter((a) => a.params.length).map((a) => [a.name, Object.fromEntries(a.params.map((p) => [p.name, paramValues(p, env)]))])),
    invariants: 'invariants.mjs',
  };

  // ── invariants.mjs ───────────────────────────────────────────────────
  const invariants = invariantsModule(mutated, facts, env, layout, pre, actions.filter((a) => !handlers.has(a.name)).map((a) => a.name));

  return {
    lowered: {
      machine: m.name,
      files: { 'contract.json': JSON.stringify(contract, null, 2) + '\n', 'next.cjs': next, 'invariants.mjs': invariants },
      contract,
      layout,
    },
    diagnostics: [],
  };
}

function invariantsModule(m: A.Machine, facts: MachineFacts, env: TypeEnv, layout: Layout, pre: string, unhandled: string[]): string {
  const q = JSON.stringify;
  const state: string[] = [];
  const invCx: Cx = { facts, env, layout, mode: 'state', stateVar: 's', dataVar: 'data' };
  for (const p of m.items) {
    if (p.kind === 'Property' && p.form === 'invariant') state.push(`  { name: ${q(p.name)}, pred: (s) => ${expr(p.expr, invCx)} },`);
  }
  // Automatic invariants: domain (PT3.5), shape (PS9.1b), bound (PS4.2a).
  for (const f of m.fields) {
    const l = layout.byField.get(f.name)!;
    const t = l.ty;
    if (t.k === 'int' && Number.isFinite(t.lo)) state.push(`  { name: ${q(`domain:${f.name}`)}, pred: (s) => Number.isInteger(s[${q(f.name)}]) && s[${q(f.name)}] >= ${t.lo} && s[${q(f.name)}] <= ${t.hi} },`);
    if (t.k === 'map' && t.value.k === 'int' && Number.isFinite(t.value.lo)) state.push(`  { name: ${q(`domain:${f.name}`)}, pred: (s) => Object.values(s[${q(f.name)}]).every((x) => Number.isInteger(x) && x >= ${t.value.lo} && x <= ${t.value.hi}) },`);
    if (l.kind === 'union') {
      state.push(`  { name: ${q(`shape:${f.name}`)}, pred: (s) => __SHAPES[${q(f.name)}][s[${q(f.name)}]] !== undefined && __FLAT[${q(f.name)}].every(([p, k]) => (__SHAPES[${q(f.name)}][s[${q(f.name)}]].some(([x]) => x === p) ? s[k] !== null : s[k] === null)) },`);
      const u = env.unions.get((t as { name: string }).name)!;
      for (const [p, k] of l.payloads!) {
        const decl = u.ctors.flatMap((c) => c.fields).find((x) => x.name === p)!;
        if (decl.type.kind === 'TRange') state.push(`  { name: ${q(`domain:${k}`)}, pred: (s) => s[${q(k)}] === null || (Number.isInteger(s[${q(k)}]) && s[${q(k)}] >= ${decl.type.lo} && s[${q(k)}] <= ${decl.type.hi}) },`);
      }
    }
    if (f.check && (t.k === 'int' || t.k === 'string')) {
      const values = f.check.domain.kind === 'DomainRange' ? null : f.check.domain.values.map((v) => (v as A.IntLit | A.StringLit).value);
      const pred = values ? `${q(values)}.includes(s[${q(f.name)}])` : `s[${q(f.name)}] >= ${(f.check.domain as A.DomainRange).lo} && s[${q(f.name)}] <= ${(f.check.domain as A.DomainRange).hi}`;
      state.push(`  { name: ${q(`bound:${f.name}`)}, pred: (s) => ${pred} },`);
    }
  }
  const stepCx: Cx = { facts, env, layout, mode: 'step', stateVar: 'pre', dataVar: 'data' };
  const trans = m.items.filter((p): p is A.Property => p.kind === 'Property' && p.form === 'step')
    // S8: the engine calls transitionInvariants on every step; a step property holds on accepted steps only (PS5.2).
    .map((p) => `  { name: ${q(p.name)}, pred: (pre, action, data, post, v) => (!!(v && v.rejected)) || UNHANDLED.has(action) || ${expr(p.expr, stepCx)} },`);
  const rejCx: Cx = { facts, env, layout, mode: 'reject', stateVar: 'state', dataVar: 'data' };
  const rej = m.items.filter((p): p is A.Property => p.kind === 'Property' && p.form === 'reject')
    .map((p) => `  { name: ${q(p.name)}, pred: (state, action, data, v) => ${expr(p.expr, rejCx)} },`);
  return [
    `// Generated by poly-lower from ${m.name}. Do not edit.`,
    pre,
    `const UNHANDLED = new Set(${q(unhandled)});`,
    `void UNHANDLED;`,
    ``,
    `export const stateInvariants = [`,
    ...state,
    `];`,
    ``,
    `export const transitionInvariants = [`,
    ...trans,
    `];`,
    ``,
    `export const rejectionInvariants = [`,
    ...rej,
    `];`,
    ``,
  ].join('\n');
}

// ── domains and types, flat-encoded ─────────────────────────────────────────

function paramTy(p: A.Param, env: TypeEnv): Ty {
  const t = p.type;
  switch (t.kind) {
    case 'TBool': return { k: 'bool' };
    case 'TInt': return { k: 'int', lo: -Infinity, hi: Infinity };
    case 'TString': return { k: 'string' };
    case 'TRange': return { k: 'int', lo: t.lo, hi: t.hi };
    case 'TName': return env.unions.has(t.name) ? { k: 'union', name: t.name } : { k: 'error' };
    case 'TMap': return { k: 'map', key: { k: 'error' }, value: { k: 'error' }, array: false };
    case 'TRef': return { k: 'ref' };
  }
}

function valuesOfTy(t: Ty, env: TypeEnv): unknown[] {
  if (t.k === 'bool') return [false, true];
  if (t.k === 'int') {
    // The checker refuses an int with no check domain (PL1101), so this is only reached by a caller that ignored it.
    if (!Number.isFinite(t.lo) || !Number.isFinite(t.hi)) throw new Error('poly-lower: an unbounded int has no domain (PL1101)');
    return Array.from({ length: t.hi - t.lo + 1 }, (_, i) => t.lo + i);
  }
  if (t.k === 'union') return env.unions.get(t.name)!.ctors.map((c) => c.name);
  return [];
}

function paramValues(p: A.Param, env: TypeEnv): unknown[] {
  if (p.check) {
    const d = p.check.domain;
    return d.kind === 'DomainRange' ? Array.from({ length: d.hi - d.lo + 1 }, (_, i) => d.lo + i) : d.values.map((v) => (v.kind === 'Name' ? v.name : v.value));
  }
  return valuesOfTy(paramTy(p, env), env);
}

/** D(a) as the intent's `domain`: every payload object (PS1.1). */
function dataDomainOf(a: A.Action, env: TypeEnv): Record<string, unknown>[] {
  let recs: Record<string, unknown>[] = [{}];
  for (const p of a.params) {
    const vs = paramValues(p, env);
    recs = recs.flatMap((r) => vs.map((v) => ({ ...r, [p.name]: v })));
  }
  return recs;
}

function controlValues(f: A.Field, facts: MachineFacts, env: TypeEnv): unknown[] {
  const t = facts.fieldTypes.get(f.name)!;
  if (f.check) {
    const d = f.check.domain;
    return d.kind === 'DomainRange' ? Array.from({ length: d.hi - d.lo + 1 }, (_, i) => d.lo + i) : d.values.map((v) => (v.kind === 'Name' ? v.name : v.value));
  }
  return valuesOfTy(t, env);
}

function jsType(t: Ty): string {
  return t.k === 'bool' ? 'boolean' : t.k === 'int' ? 'number' : 'string';
}

function typeText(t: Ty, env: TypeEnv): string {
  switch (t.k) {
    case 'bool': return 'boolean';
    case 'int': return Number.isFinite(t.lo) ? `${t.lo}..${t.hi}` : 'number';
    case 'string': return 'string';
    case 'union': return env.unions.get(t.name)!.ctors.map((c) => `'${c.name}'`).join(' | ');
    case 'map': return t.array ? `array of ${typeText(t.value, env)}, indexed ${typeText(t.key, env)}` : `object of ${typeText(t.value, env)}, keyed ${typeText(t.key, env)}`;
    default: return t.k;
  }
}

function keyTypeText(l: import('./layout.js').FieldLayout, key: string, env: TypeEnv): string {
  if (key === l.field) return typeText(l.ty, env);
  const u = env.unions.get((l.ty as { name: string }).name)!;
  const p = l.payloads!.find(([, k]) => k === key)![0];
  const decl = u.ctors.flatMap((c) => c.fields).find((x) => x.name === p)!;
  const owners = u.ctors.filter((c) => c.fields.some((x) => x.name === p)).map((c) => c.name);
  const t = payloadTy(decl.type);
  return `${typeText(t, env)} | null (payload of ${owners.join(', ')})`;
}

// ── faults (test-only) ──────────────────────────────────────────────────────
import { applyFault } from './faults.js';
