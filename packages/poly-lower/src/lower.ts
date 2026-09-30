// Lowering of one machine to the artefacts the engines read (02 §4, PT4.5, PT5):
//   contract.json   stateKeys (control field first), initState, actions, dataDomain, terminalStates
//   next.cjs        a SAM v2 strict-profile module: sealed modelShape, named intents with
//                   schemas and domains, keyed acceptors, reject/next/unchanged
//   invariants.mjs  stateInvariants, transitionInvariants, rejectionInvariants
import type * as A from '@poly/core';
import { diag, digest, effectKind, effectClass, durationMs, countBound, beforeKinds, type CheckResult, type Diagnostic, type MachineFacts, type Ty, type TypeEnv } from '@poly/core';
import { layoutOf, prelude, isPayloadUnion, tyOfTypeExpr, checkDomainValues, type Layout } from './layout.js';
import { expr, stmts, mayWrite, resetNames, type Cx, type EmitOptions } from './emit.js';

export interface LowerOptions {
  /** Test-only fault injection; `poly check` never sets it (faults.ts). */
  fault?: Fault;
}

export type Fault = 'drop-frame' | 'swap-reason' | 'off-by-one' | 'invert-require' | 'skip-guard' | 'skip-terminal' | 'drop-property' | 'drop-auto-invariant' | 'drop-effect' | 'reorder-effects' | 'unnamed-reject' | 'poison-step';

export interface Lowered {
  machine: string;
  files: { 'contract.json': string; 'next.cjs': string; 'invariants.mjs': string; 'effects.cjs'?: string; 'effects.manifest.json'?: string; 'effect-invariants.mjs'?: string; 'invariants.compose.mjs'?: string };
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
      const t = tyOfTypeExpr(p.type, check.env);
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
  const emitOpts: EmitOptions = {
    dropFrame: opts.fault === 'drop-frame',
    unnamedReject: opts.fault === 'unnamed-reject' ? { done: false } : undefined,
    poison: opts.fault === 'poison-step' ? { done: false } : undefined,
  };
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
  // The terminal predicate is compiled once, then applied to each control value (review finding 10).
  const isTerminal = terminal ? (new Function(`${pre}\nreturn (model) => ${termCode};`)() as (s: unknown) => boolean) : null;
  const terminalStates = isTerminal ? controlValues(m.fields[0], facts, env).filter((v) => isTerminal({ ...initState, [control.field]: v })) : [];

  // ── acceptors ────────────────────────────────────────────────────────
  const handlers = new Map(mutated.items.filter((i): i is A.Handler => i.kind === 'Handler').map((h) => [h.action, h]));
  const guards = mutated.items.filter((i): i is A.Guard => i.kind === 'Guard');
  // S35: an action with no handler is not lowered. It is not an intent of the module and not in the
  // contract's actions, so the runtime answers it before any acceptor runs (PS9.1a): terminal in a terminal
  // state, unhandled elsewhere. sam-pattern 2.3 throws for an intent no acceptor constrains (S34, option b).
  const lowerable = actions.filter((a) => handlers.has(a.name));
  // PT3.4a: strict as declared, or by the flow of a parameter into an irreversible or compensable payload.
  const strict = lowerable.flatMap((a) => a.params.filter((p) => facts.strictParams.has(`${a.name}.${p.name}`)).map((p) => ({ a: a.name, p: p.name, values: paramValues(p, env, facts, a.name) })));
  const acceptors: string[] = [];
  if ((terminal && opts.fault !== 'skip-terminal') || guards.length || strict.length) {
    const lines = [`    // PS3.2, rows 1 and 2, then the guards of PS2.2. It runs for handled actions only: no other is an intent (S35).`, `    '*': (model) => (proposal, { reject }) => {`, `      const action = proposal.__actionName;`];
    if (terminal && opts.fault !== 'skip-terminal') lines.push(`      if (TERMINAL(model)) return reject('terminal');`);
    for (const s of strict) lines.push(`      if (action === ${JSON.stringify(s.a)} && !${JSON.stringify(s.values)}.includes(proposal[${JSON.stringify(s.p)}])) return reject('outside-check-domain');`);
    if (guards.length) {
      for (const g of guards) lines.push(`      if (${expr(g.cond, stateCx)}) return reject(${JSON.stringify(g.reason)});`);
    }
    lines.push(`    },`);
    acceptors.push(lines.join('\n'));
  }
  for (const a of lowerable) {
    const h = handlers.get(a.name)!;
    const hcx: Cx = { ...base, mode: 'handler', stateVar: 'model', dataVar: 'proposal' };
    const body = stmts(h.body, hcx, '      ', emitOpts);
    // S55: each map the handler writes entry by entry gathers its entries in an accumulator.
    for (const f of mapUpdated(h.body)) body.unshift(`      let __m_${f} = model[${JSON.stringify(f)}];`);
    const written = mayWrite(h.body, layout);
    const rest = layout.flatKeys.filter((k) => !written.has(k));
    if (rest.length && !emitOpts.dropFrame) body.push(`      unchanged(${rest.map((k) => JSON.stringify(k)).join(', ')});`);
    acceptors.push(`    ${JSON.stringify(a.name)}: (model) => (proposal, { reject, next, unchanged }) => {\n${body.join('\n')}\n    },`);
  }

  // ── next.cjs ─────────────────────────────────────────────────────────
  const modelShape: Record<string, unknown> = {};
  for (const l of layout.fields) Object.assign(modelShape, l.shapes);
  const intentDecls = lowerable.map((a) => {
    const schema = Object.fromEntries(a.params.map((p) => [p.name, { type: jsType(tyOfTypeExpr(p.type, env)), required: true }]));
    return `    ${JSON.stringify(a.name)}: { action: (data = {}) => ({ ...data }), schema: ${JSON.stringify(schema)}, domain: ${JSON.stringify(dataDomainOf(a, env, facts))} },`;
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
    ``,
    `// SAM's development warnings are off; strict-profile errors still throw.`,
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
    ...lowerable.map((a) => `  ${JSON.stringify(a.name)}: (data = {}) => intents[${JSON.stringify(a.name)}](data),`),
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
    actions: Object.fromEntries(lowerable.map((a) => [a.name, { dataFields: Object.fromEntries(a.params.map((p) => [p.name, typeText(tyOfTypeExpr(p.type, env), env)])) }])),
    terminalStates,
    dataDomain: Object.fromEntries(lowerable.filter((a) => a.params.length).map((a) => [a.name, Object.fromEntries(a.params.map((p) => [p.name, paramValues(p, env, facts, a.name)]))])),
    invariants: 'invariants.mjs',
  };

  // ── invariants.mjs ───────────────────────────────────────────────────
  const invariants = invariantsModule(mutated, facts, env, layout, pre, actions.filter((a) => !handlers.has(a.name)).map((a) => a.name), opts.fault);

  const files: Lowered['files'] = { 'contract.json': JSON.stringify(contract, null, 2) + '\n', 'next.cjs': next, 'invariants.mjs': invariants };
  // ── effects (PT6.1, PT5): the mapper and manifest when the machine declares effects, the path properties' module when it has any ──
  // A machine that arms timers needs the mapper too: a timer is an intent (PT6.3).
  if (facts.effects.size || facts.timerKeys.size || facts.children.size) {
    files['effects.cjs'] = effectsModule(mutated, lowerable, handlers, { ...base, mode: 'handler', stateVar: 'pre', dataVar: 'data', module: module.name, moduleDecls: module.decls }, pre, opts.fault);
    files['effects.manifest.json'] = JSON.stringify(manifestOf(facts, env), null, 2) + '\n';
  }
  const pathProps = mutated.items.filter((p): p is A.Property => p.kind === 'Property' && p.form === 'path');
  if (pathProps.length) files['effect-invariants.mjs'] = effectInvariantsModule(m.name, pathProps);
  // PT7: compose invariants, as polyrun's check-product reads them.
  const composeProps = mutated.items.filter((p): p is A.Property => p.kind === 'Property' && p.form === 'compose');
  if (composeProps.length) {
    const ccx: Cx = { ...base, mode: 'compose', stateVar: 'joint', dataVar: 'data' };
    files['invariants.compose.mjs'] = [
      `// Generated by poly-lower from ${m.name}: compose invariants (PS7.3, PT7). Do not edit.`,
      pre,
      `export const stateInvariants = [`,
      ...composeProps.map((p) => `  { name: ${JSON.stringify(p.name)}, pred: (joint) => ${expr(p.expr, ccx)} },`),
      `];`,
      `export const transitionInvariants = [];`,
      ``,
    ].join('\n');
  }

  return {
    lowered: {
      machine: m.name,
      files,
      contract,
      layout,
    },
    diagnostics: [],
  };
}

/**
 * effects.cjs (PT6.1): `effects(pre, action, data, post, stepKind)` re-runs the accepted step's handler over
 * the pre-state and the data, writes left out, and returns its intents in statement order. The state it
 * reads is the flat snapshot the kernel passes. Rejected and unhandled steps emit nothing.
 */
function effectsModule(m: A.Machine, lowerable: A.Action[], handlers: Map<string, A.Handler>, cx: Cx, pre: string, fault?: Fault): string {
  const dropEffect = fault === 'drop-effect' ? { done: false } : undefined;
  const entries: string[] = [];
  for (const a of lowerable) {
    const h = handlers.get(a.name)!;
    if (!emitsAny(h.body)) continue;
    const body = stmts(h.body, cx, '    ', { effects: true, dropEffect });
    // Test-only fault reorder-effects: the step's intents come back in reverse order.
    const ret = fault === 'reorder-effects' ? '__E.reverse()' : '__E';
    entries.push(`  ${JSON.stringify(a.name)}: (pre, data) => {\n    const __E = [];\n${body.join('\n')}\n    return ${ret};\n  },`);
  }
  return [
    `'use strict';`,
    `// Generated by poly-lower from ${m.name}: the effects mapper (PT6.1). Do not edit.`,
    pre,
    ``,
    `const HANDLERS = {`,
    ...entries,
    `};`,
    ``,
    `function effects(pre, action, data, post, stepKind) {`,
    `  if (stepKind !== 'accepted') return [];`,
    `  const h = HANDLERS[action];`,
    `  return h ? h(pre, data ?? {}) : [];`,
    `}`,
    ``,
    `module.exports = { effects };`,
    ``,
  ].join('\n');
}

/** The fields a handler writes with `m' = m with [k] = v`, anywhere in its body. */
function mapUpdated(body: A.Stmt[]): Set<string> {
  const out = new Set<string>();
  const walk = (b: A.Stmt[]): void => {
    for (const s of b) {
      if (s.kind === 'MapUpdate') out.add(s.field);
      if (s.kind === 'If') { walk(s.then); walk(s.else ?? []); }
      if (s.kind === 'Match') for (const a of s.arms) walk(a.body);
      if (s.kind === 'For') walk(s.body);
    }
  };
  walk(body);
  return out;
}

function emitsAny(body: A.Stmt[]): boolean {
  return body.some((s) => (s.kind === 'Intent' && (s.op === 'emit' || s.op === 'after' || s.op === 'cancel' || s.op === 'spawn' || s.op === 'signal')) || (s.kind === 'If' && (emitsAny(s.then) || emitsAny(s.else ?? []))) || (s.kind === 'Match' && s.arms.some((a) => emitsAny(a.body))) || (s.kind === 'For' && emitsAny(s.body)));
}

/** effects.manifest.json (PT6.1): one kind per effect, with its completions, retry policy, labels and class. */
function manifestOf(facts: MachineFacts, env: TypeEnv): { effects: Record<string, unknown> } {
  // Kinds are the author's strings, so the manifest is built from entries: an assignment to a key such
  // as "__proto__" would set a prototype instead of adding the kind.
  const out: [string, unknown][] = [];
  for (const e of facts.effects.values()) {
    const entry: Record<string, unknown> = {
      payloadSchema: Object.fromEntries(e.params.map((p) => [p.name, { type: jsType(tyOfTypeExpr(p.type, env)), required: true }])),
    };
    const hooks: Record<string, string> = { ok: 'onSuccess', failed: 'onFailure', exhausted: 'onExhausted' };
    for (const it of e.items) {
      if (it.kind === 'EffOutcome') {
        const data = Object.fromEntries(it.args.map((a) => [a.name!, constValue(a.value)]));
        entry[hooks[it.outcome]] = it.args.length ? { action: it.action, data } : { action: it.action };
      }
      if (it.kind === 'EffRetry') entry.retry = { maxAttempts: it.attempts, baseMs: durationMs(it.base), timeoutMs: durationMs(it.timeout) };
      if (it.kind === 'EffLabels') entry.labels = it.labels;
    }
    // polyrun ignores fields it does not read, so labels and class stay in the manifest (PT6.1).
    entry.class = effectClass(e);
    out.push([effectKind(e), entry]);
  }
  return { effects: Object.fromEntries(out) };
}

/** A completion argument as the manifest carries it: the checker proved it constant (PT6.1). */
function constValue(e: A.Expr): unknown {
  switch (e.kind) {
    case 'Int': case 'Bool': case 'String': return e.value;
    case 'Name': return e.name;
    case 'Member': return e.prop;
    case 'Unary': return e.op === '-' ? -(constValue(e.arg) as number) : !(constValue(e.arg) as boolean);
    default: throw new Error('poly-lower: a completion argument is not a constant (the checker must refuse it)');
  }
}

/**
 * effect-invariants.mjs (PT5): each path property as a predicate over polyrun's Path. `count` is
 * `p.count(kind)`; `before` reads `p.emitted`, the path's intents in order (S37).
 */
function effectInvariantsModule(machine: string, props: A.Property[]): string {
  const lines = props.map((p) => {
    const conj: string[] = [];
    const walk = (e: A.Expr): void => {
      if (e.kind === 'Binary' && e.op === '&&') { walk(e.left); walk(e.right); return; }
      const order = beforeKinds(e);
      if (order) { conj.push(`__before(p, ${JSON.stringify(order.first.kind)}, ${JSON.stringify(order.then.kind)})`); return; }
      const b = countBound(e);
      if (!b) throw new Error(`poly-lower: path property ${p.name} is not prefix-closed (PL1701 must refuse it)`);
      conj.push(`p.count(${JSON.stringify(b.kind)}) <= ${b.max}`);
    };
    walk(p.expr);
    return `  { name: ${JSON.stringify(p.name)}, pred: (p) => ${conj.join(' && ')} },`;
  });
  return [
    `// Generated by poly-lower from ${machine}: path properties (PS5.4). Do not edit.`,
    `/** before(k1, k2): every emission of k2 is preceded by an emission of k1 (S37). */`,
    `const __before = (p, first, then) => {`,
    `  let seen = false;`,
    `  for (const e of p.emitted) {`,
    `    if (e.kind === then && !seen) return false;`,
    `    if (e.kind === first) seen = true;`,
    `  }`,
    `  return true;`,
    `};`,
    ``,
    `export const effectInvariants = [`, ...lines, `];`, ``,
  ].join('\n');
}

function invariantsModule(m: A.Machine, facts: MachineFacts, env: TypeEnv, layout: Layout, pre: string, unhandled: string[], fault?: Fault): string {
  const q = JSON.stringify;
  const state: string[] = [];
  const auto: string[] = [];
  // Test-only faults: drop the first step or reject property (else the first invariant), or every automatic invariant.
  const dropped = fault === 'drop-property' ? (m.items.find((p) => p.kind === 'Property' && (p.form === 'step' || p.form === 'reject')) ?? m.items.find((p) => p.kind === 'Property' && p.form === 'invariant')) : undefined;
  const invCx: Cx = { facts, env, layout, mode: 'state', stateVar: 's', dataVar: 'data' };
  for (const p of m.items) {
    if (p.kind === 'Property' && p.form === 'invariant' && p !== dropped) state.push(`  { name: ${q(p.name)}, pred: (s) => ${expr(p.expr, invCx)} },`);
  }
  // Automatic invariants: domain (PT3.5), shape (PS9.1b), bound (PS4.2a).
  for (const f of m.fields) {
    const l = layout.byField.get(f.name)!;
    const t = l.ty;
    if (t.k === 'int' && Number.isFinite(t.lo)) auto.push(`  { name: ${q(`domain:${f.name}`)}, pred: (s) => Number.isInteger(s[${q(f.name)}]) && s[${q(f.name)}] >= ${t.lo} && s[${q(f.name)}] <= ${t.hi} },`);
    if (t.k === 'map' && t.value.k === 'int' && Number.isFinite(t.value.lo)) auto.push(`  { name: ${q(`domain:${f.name}`)}, pred: (s) => Object.values(s[${q(f.name)}]).every((x) => Number.isInteger(x) && x >= ${t.value.lo} && x <= ${t.value.hi}) },`);
    if (l.kind === 'union') {
      auto.push(`  { name: ${q(`shape:${f.name}`)}, pred: (s) => __SHAPES[${q(f.name)}][s[${q(f.name)}]] !== undefined && __FLAT[${q(f.name)}].every(([p, k]) => (__SHAPES[${q(f.name)}][s[${q(f.name)}]].some(([x]) => x === p) ? s[k] !== null && s[k] !== undefined : s[k] === null)) },`);
      const u = env.unions.get((t as { name: string }).name)!;
      for (const [p, k] of l.payloads!) {
        const decl = u.ctors.flatMap((c) => c.fields).find((x) => x.name === p)!;
        if (decl.type.kind === 'TRange') auto.push(`  { name: ${q(`domain:${k}`)}, pred: (s) => s[${q(k)}] === null || (Number.isInteger(s[${q(k)}]) && s[${q(k)}] >= ${decl.type.lo} && s[${q(k)}] <= ${decl.type.hi}) },`);
      }
    }
    if (f.check && (t.k === 'int' || t.k === 'string')) {
      const values = f.check.domain.kind === 'DomainRange' ? null : f.check.domain.values.map((v) => (v as A.IntLit | A.StringLit).value);
      const pred = values ? `${q(values)}.includes(s[${q(f.name)}])` : `s[${q(f.name)}] >= ${(f.check.domain as A.DomainRange).lo} && s[${q(f.name)}] <= ${(f.check.domain as A.DomainRange).hi}`;
      auto.push(`  { name: ${q(`bound:${f.name}`)}, pred: (s) => ${pred} },`);
    }
  }
  if (fault !== 'drop-auto-invariant') state.push(...auto);
  const stepCx: Cx = { facts, env, layout, mode: 'step', stateVar: 'pre', dataVar: 'data' };
  const trans = m.items.filter((p): p is A.Property => p.kind === 'Property' && p.form === 'step' && p !== dropped)
    // S8: the engine calls transitionInvariants on every step; a step property holds on accepted steps only (PS5.2).
    .map((p) => `  { name: ${q(p.name)}, pred: (pre, action, data, post, v) => (!!(v && v.rejected)) || UNHANDLED.has(action) || ${expr(p.expr, stepCx)} },`);
  const rejCx: Cx = { facts, env, layout, mode: 'reject', stateVar: 'state', dataVar: 'data' };
  const rej = m.items.filter((p): p is A.Property => p.kind === 'Property' && p.form === 'reject' && p !== dropped)
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


function valuesOfTy(t: Ty, env: TypeEnv): unknown[] {
  if (t.k === 'bool') return [false, true];
  if (t.k === 'int') {
    // The checker refuses an int with no check domain (PL1101), so this is only reached by a caller that ignored it.
    if (!Number.isFinite(t.lo) || !Number.isFinite(t.hi)) throw new Error('poly-lower: an unbounded int has no domain (PL1101)');
    return Array.from({ length: t.hi - t.lo + 1 }, (_, i) => t.lo + i);
  }
  if (t.k === 'union') return env.unions.get(t.name)!.ctors.map((c) => c.name);
  if (t.k === 'record') {
    // S25: every combination of field values, as plain objects.
    let recs: Record<string, unknown>[] = [{}];
    for (const f of env.records.get(t.name)!.fields) {
      const vs = valuesOfTy(tyOfTypeExpr(f.type, env), env);
      recs = recs.flatMap((r) => vs.map((v) => ({ ...r, [f.name]: v })));
    }
    return recs;
  }
  return [];
}

/** A parameter's values; a completion's childKey takes the keys wired to its action (S51). */
function paramValues(p: A.Param, env: TypeEnv, facts?: MachineFacts, action?: string): unknown[] {
  const keys = action ? facts?.childKeyDomains.get(action) : undefined;
  if (keys && p.name === 'childKey' && !p.check) return keys;
  return p.check ? checkDomainValues(p.check) : valuesOfTy(tyOfTypeExpr(p.type, env), env);
}

/** D(a) as the intent's `domain`: every payload object (PS1.1). */
function dataDomainOf(a: A.Action, env: TypeEnv, facts?: MachineFacts): Record<string, unknown>[] {
  let recs: Record<string, unknown>[] = [{}];
  for (const p of a.params) {
    const vs = paramValues(p, env, facts, a.name);
    recs = recs.flatMap((r) => vs.map((v) => ({ ...r, [p.name]: v })));
  }
  return recs;
}

function controlValues(f: A.Field, facts: MachineFacts, env: TypeEnv): unknown[] {
  return f.check ? checkDomainValues(f.check) : valuesOfTy(facts.fieldTypes.get(f.name)!, env);
}

function jsType(t: Ty): string {
  return t.k === 'bool' ? 'boolean' : t.k === 'int' ? 'number' : t.k === 'record' ? 'object' : 'string';
}

function typeText(t: Ty, env: TypeEnv): string {
  switch (t.k) {
    case 'bool': return 'boolean';
    case 'int': return Number.isFinite(t.lo) ? `${t.lo}..${t.hi}` : 'number';
    case 'string': return 'string';
    case 'union': return env.unions.get(t.name)!.ctors.map((c) => `'${c.name}'`).join(' | ');
    case 'record': return `{ ${env.records.get(t.name)!.fields.map((f) => `${f.name}: ${typeText(tyOfTypeExpr(f.type, env), env)}`).join(', ')} }`;
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
  const t = tyOfTypeExpr(decl.type);
  return `${typeText(t, env)} | null (payload of ${owners.join(', ')})`;
}

// ── faults (test-only) ──────────────────────────────────────────────────────
import { applyFault } from './faults.js';
