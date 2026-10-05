// Lowering of one machine to the artefacts the engines read (02 §4, PT4.5, PT5):
//   contract.json   stateKeys (control field first), initState, actions, dataDomain, terminalStates
//   next.cjs        a SAM v2 strict-profile module: sealed modelShape, named intents with
//                   schemas and domains, keyed acceptors, reject/next/unchanged
//   invariants.mjs  stateInvariants, transitionInvariants, rejectionInvariants
import type * as A from '@poly/core';
import { boundPath, diag, digest, effectKind, effectClass, durationMs, countBound, beforeKinds, type CheckResult, type Diagnostic, type MachineFacts, type Ty, type TypeEnv } from '@poly/core';
import { layoutOf, prelude, isPayloadUnion, tyOfTypeExpr, checkDomainValues, type Layout } from './layout.js';
import { expr, stmts, mayWrite, resetNames, type Cx, type EmitOptions } from './emit.js';

export interface LowerOptions {
  /** Test-only fault injection; `poly check` never sets it (faults.ts). */
  fault?: Fault;
  /** PT6.5, S152: generate an OpenShell policy per effect kind (`isolation: "openshell"` in poly.json). */
  isolation?: 'openshell';
  /** S176: the program's modules, for a send to or a spawn of a used module's machine. */
  program?: A.Module[];
}

export type Fault = 'skip-content' | 'content-before-unhandled' | 'drop-frame' | 'swap-reason' | 'off-by-one' | 'invert-require' | 'skip-guard' | 'skip-terminal' | 'drop-property' | 'drop-auto-invariant' | 'drop-effect' | 'reorder-effects' | 'unnamed-reject' | 'poison-step' | 'manifest-data' | 'drop-terminal-state' | 'contract-domain' | 'contract-init' | 'path-invariant' | 'compose-invariant' | 'liveness-goal' | 'outcome-entry' | 'widen-target' | 'skip-claims' | 'widen-sandbox' | 'drop-timer-target' | 'workflow-tool' | 'workflow-key';

export interface Lowered {
  machine: string;
  files: { 'contract.json': string; 'next.cjs': string; 'invariants.mjs': string; 'effects.cjs'?: string; 'effects.manifest.json'?: string; 'effect-invariants.mjs'?: string; 'invariants.compose.mjs'?: string; 'liveness.mjs'?: string; 'openshell.policies.yaml'?: string; [workflow: `../workflows/${string}/polyflow.workflow.json`]: string };
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
      // S65: a union with payloads is lowered as a parameter; a map is not yet.
      if (holdsMap(p.type, check.env, new Set())) {
        diagnostics.push(diag('PL0901', { module: module.name, machine: m.name, node: p.id, line: p.span?.line, col: p.span?.col }, `a parameter of type map is lowered after milestone M1: ${a.name}.${p.name}`));
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
  // The fault content-before-unhandled lowers PS3.2's first row order (S180, before the ruling): an action with no handler
  // that carries a Content gets an empty handler, so the module answers its missing body content-missing.
  if (opts.fault === 'content-before-unhandled') for (const a of actions) if (!handlers.has(a.name) && carriesContent(a, env)) handlers.set(a.name, { kind: 'Handler', id: `${a.id}#fault`, action: a.name, params: null, body: [] });
  // S35: an action with no handler is not lowered. It is not an intent of the module and not in the
  // contract's actions, so the runtime answers it before any acceptor runs (PS9.1a): terminal in a terminal
  // state, unhandled elsewhere. sam-pattern 2.3 throws for an intent no acceptor constrains (S34, option b).
  const lowerable = actions.filter((a) => handlers.has(a.name));
  // PT3.4a: strict as declared, or by the flow of a parameter into an irreversible or compensable payload.
  const strict = lowerable.flatMap((a) => a.params.filter((p) => facts.strictParams.has(`${a.name}.${p.name}`)).map((p) => ({ a: a.name, p: p.name, values: paramValues(p, env, facts, a.name) })));
  // PD5.1.2c, S101: each action with `by c: C`, and the domain of each claims field (a principal is a non-empty string).
  const claimed = new Map<string, Record<string, unknown[] | 'principal'>>();
  for (const a of lowerable) {
    const by = handlers.get(a.name)?.by;
    if (!by) continue;
    const rec = env.records.get(by.type)!;
    claimed.set(a.name, Object.fromEntries(rec.fields.map((f) => { const ty = tyOfTypeExpr(f.type, env); return [f.name, ty.k === 'principal' ? 'principal' : ty.k === 'int' ? Array.from({ length: ty.hi - ty.lo + 1 }, (_, k) => ty.lo + k) : ty.k === 'bool' ? [false, true] : env.unions.get((ty as { name: string }).name)!.ctors.map((c) => c.name)]; })));
  }
  // PS3.2's claims row as one expression: an object with exactly the type's fields, each in its domain.
  const claimsOkText = "((c, spec) => !!c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length === Object.keys(spec).length && Object.entries(spec).every(([f, d]) => d === 'principal' ? typeof c[f] === 'string' && c[f].length > 0 : d.includes(c[f])))";
  const claimsOf = (action: string): Ty | null => { const by = handlers.get(action)?.by; return by ? { k: 'record', name: by.type } : null; };
  const acceptors: string[] = [];
  // PS3.2 row 5 (S180): the actions whose data can carry a Content, for the content row in the first acceptor.
  const contentful = opts.fault === 'skip-content' ? [] : lowerable.filter((a) => carriesContent(a, env));
  if ((terminal && opts.fault !== 'skip-terminal') || guards.length || strict.length || claimed.size || contentful.length) {
    const lines = [`    // PS3.2, rows 1 and 2, then the guards of PS2.2. It runs for handled actions only: no other is an intent (S35).`, `    '*': (model) => (proposal, { reject }) => {`, `      const action = proposal.__actionName;`];
    if (terminal && opts.fault !== 'skip-terminal') lines.push(`      if (TERMINAL(model)) return reject('terminal');`);
    for (const s of strict) {
      // PD1.4b: a Conf is explored by its intervals, and at runtime its domain is 0..1000 (PD1.3a).
      const isConf = actions.find((a) => a.name === s.a)?.params.find((p) => p.name === s.p)?.type.kind === 'TConf';
      const test = isConf ? `!(Number.isInteger(proposal[${JSON.stringify(s.p)}]) && proposal[${JSON.stringify(s.p)}] >= 0 && proposal[${JSON.stringify(s.p)}] <= 1000)` : s.values.some((v) => v !== null && typeof v === 'object')
          // A record or a union with payloads is compared by value (review B1): `includes` compares objects by identity.
          ? `!${JSON.stringify(s.values)}.some((v) => __eq(v, proposal[${JSON.stringify(s.p)}]))`
          : `!${JSON.stringify(s.values)}.includes(proposal[${JSON.stringify(s.p)}])`;
      lines.push(`      if (action === ${JSON.stringify(s.a)} && ${test}) return reject('outside-check-domain');`);
    }
    // PS3.2's claims row (S101): claims missing, malformed or outside their domains, after row 2 and before the guards.
    for (const [name, spec] of claimed) {
      if (opts.fault === 'skip-claims') continue;
      lines.push(`      if (action === ${JSON.stringify(name)} && !${claimsOkText}(proposal.$claims, ${JSON.stringify(spec)})) return reject('claims-unverified');`);
    }
    // PS3.2's content row (S180): after the claims row and before the guards, which are h_a's (polywatch muvf62zx-3c89f81a).
    for (const a of contentful) lines.push(`      if (action === ${JSON.stringify(a.name)} && proposal.$content === 'missing') return reject('content-missing');`);
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
    // PD5.1.2: the claims binder reads the label's claims, carried under $claims (S155).
    // Review A-F2: sam-pattern runs this acceptor even after the first one rejects, so the body is guarded by the row too.
    // The fault skip-claims drops the row here too: with the row in either place the step is still rejected.
    // PS3.2, S180: a Content that names no body in the store is marked by the runtime under $content. The first acceptor
    // rejects it before the guards; the row is repeated here, as the claims row is, since this acceptor runs anyway
    // (A-F2). The fault skip-content drops it in both places.
    if (carriesContent(a, env) && opts.fault !== 'skip-content') body.unshift(`      if (proposal.$content === 'missing') return reject('content-missing');`);
    if (h.by) body.unshift(...(opts.fault === 'skip-claims' ? [] : [`      if (!${claimsOkText}(proposal.$claims, ${JSON.stringify(claimed.get(a.name))})) return reject('claims-unverified');`]), `      proposal = { ...proposal, ${JSON.stringify(h.by.name)}: proposal.$claims };`);
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
    // S58: an address is a string, and none is null.
    const schema: Record<string, unknown> = Object.fromEntries(a.params.map((p) => { const ty = tyOfTypeExpr(p.type, env); return [p.name, { type: jsType(ty, env), required: true, ...(p.type.kind === 'TRef' || ty.k === 'principal' || ty.k === 'content' ? { nullable: true } : {}) }]; }));
    // PS3.2, S180: the runtime's mark of a missing body travels under the reserved key $content.
    if (carriesContent(a, env)) schema.$content = { type: 'string', required: false, nullable: true };
    // PD5.1.2c, S155: the claims travel under the reserved key $claims; their absence is refused by the acceptor, not
    // the schema, so it is the reserved rejection claims-unverified (PS3.2).
    if (claimed.has(a.name)) schema.$claims = { type: ['object', 'string', 'number', 'boolean', 'array'], required: false, nullable: true };
    const claimsTy = claimsOf(a.name);
    const domain = claimsTy ? dataDomainOf(a, env, facts).flatMap((d) => valuesOfTy(claimsTy, env, facts.machine).map((c) => ({ ...d, $claims: c }))) : dataDomainOf(a, env, facts);
    return `    ${JSON.stringify(a.name)}: { action: (data = {}) => ({ ...data }), schema: ${JSON.stringify(schema)}, domain: ${JSON.stringify(domain)} },`;
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
    // PD5.1.2c, S155: an action with claims has the field $claims, explored over the principal representatives.
    actions: Object.fromEntries(lowerable.map((a) => [a.name, { dataFields: { ...Object.fromEntries(a.params.map((p) => [p.name, typeText(tyOfTypeExpr(p.type, env), env)])), ...(claimsOf(a.name) ? { $claims: typeText(claimsOf(a.name)!, env) } : {}) } }])),
    terminalStates,
    dataDomain: Object.fromEntries(lowerable.filter((a) => a.params.length || claimsOf(a.name)).map((a) => [a.name, { ...Object.fromEntries(a.params.map((p) => [p.name, paramValues(p, env, facts, a.name)])), ...(claimsOf(a.name) ? { $claims: valuesOfTy(claimsOf(a.name)!, env, facts.machine) } : {}) }])),
    invariants: 'invariants.mjs',
  };

  // ── invariants.mjs ───────────────────────────────────────────────────
  const invariants = invariantsModule(mutated, facts, env, layout, pre, actions.filter((a) => !handlers.has(a.name)).map((a) => a.name), opts.fault);

  const files: Lowered['files'] = { 'contract.json': JSON.stringify(contract, null, 2) + '\n', 'next.cjs': next, 'invariants.mjs': invariants };
  // ── effects (PT6.1, PT5): the mapper and manifest when the machine declares effects, the path properties' module when it has any ──
  // A machine that arms timers needs the mapper too: a timer is an intent (PT6.3).
  // A machine that sends needs it too (S58): a send is an intent.
  if (facts.effects.size || facts.decisions.size || facts.timerKeys.size || facts.children.size || lowerable.some((a) => emitsAny(handlers.get(a.name)!.body))) {
    files['effects.cjs'] = effectsModule(mutated, lowerable, handlers, { ...base, mode: 'handler', stateVar: 'pre', dataVar: 'data', module: module.name, moduleDecls: module.decls, program: opts.program }, pre, opts.fault);
    files['effects.manifest.json'] = JSON.stringify(manifestOf(facts, env, { ...base, mode: 'init', stateVar: 'model', dataVar: 'data', fault: opts.fault }), null, 2) + '\n';
    // PT6.5, S152: the opt-in sandbox, one OpenShell policy per effect kind, from its labels and targets.
    // The broken variant widen-sandbox generates it too, so translation validation has a policy to catch.
    if (opts.isolation === 'openshell' || opts.fault === 'widen-sandbox') files['openshell.policies.yaml'] = JSON.stringify(sandboxPolicies(facts, opts.fault), null, 2) + '\n';
  }
  const pathProps = mutated.items.filter((p): p is A.Property => p.kind === 'Property' && p.form === 'path');
  if (pathProps.length) files['effect-invariants.mjs'] = effectInvariantsModule(m.name, pathProps);
  // PT10, S165: each workflow that runs this machine gets its descriptor; the machine has effect-invariants.mjs, since
  // PL6804 refuses a workflow whose machine declares no path property (S172).
  const workflows = module.decls.filter((d): d is A.Workflow => d.kind === 'Workflow' && d.machine === m.name);
  for (const w of workflows) files[`../workflows/${w.name}/polyflow.workflow.json`] = JSON.stringify(workflowDescriptor(module.name, m.name, w, opts.fault), null, 2) + '\n';
  // S74: each liveness property's goal (and, for leads to, its start) as a state predicate, for exported witness
  // tests. Its own module, so no engine can take it for an invariant; it is read back like every artefact.
  const live = mutated.items.filter((p): p is A.Liveness => p.kind === 'Liveness' && !p.quant);
  if (live.length) {
    const lcx: Cx = { ...base, mode: 'state', stateVar: 's', dataVar: 'data' };
    files['liveness.mjs'] = [
      `// Generated by poly-lower from ${m.name}: liveness goals (PS5.5, S74), for witness tests only. Do not edit.`,
      pre,
      `export const liveness = [`,
      ...live.map((p) => `  { name: ${JSON.stringify(p.name)}, goal: (s) => ${expr(p.expr, lcx)}, from: ${p.from ? `(s) => ${expr(p.from, lcx)}` : 'null'}, fair: ${JSON.stringify((p.fair ?? []).map((g) => g.members.map((x) => ({ action: x.action, perValue: x.perValue }))))} },`),
      `];`,
      ``,
    ].join('\n');
  }
  // PT7: compose invariants, as polyrun's check-product reads them.
  const composeProps = mutated.items.filter((p): p is A.Property => p.kind === 'Property' && p.form === 'compose');
  if (composeProps.length) {
    const ccx: Cx = { ...base, mode: 'compose', stateVar: 'joint', dataVar: 'data', moduleDecls: module.decls };
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

  if (opts.fault) breakArtefact(opts.fault, files, contract);
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
 * Test-only faults in the artefacts the engines read without running the module (the standing rule after the
 * M1 review): each must be caught by poly-ref's read-back (artefacts.ts). Each changes one thing, if present.
 */
function breakArtefact(fault: Fault, files: Lowered['files'], contract: Record<string, unknown>): void {
  const rewrite = (f: keyof Lowered['files'], from: RegExp, to: (m: string) => string) => { const t = files[f]; if (t) files[f] = t.replace(from, to); };
  const recontract = () => { files['contract.json'] = JSON.stringify(contract, null, 2) + '\n'; };
  if (fault === 'drop-terminal-state' && Array.isArray(contract.terminalStates) && contract.terminalStates.length) { contract.terminalStates = (contract.terminalStates as unknown[]).slice(1); recontract(); }
  if (fault === 'contract-init') { const init = contract.initState as Record<string, unknown>; const k = Object.keys(init).find((x) => typeof init[x] === 'number' || typeof init[x] === 'boolean'); if (k) { init[k] = typeof init[k] === 'number' ? (init[k] as number) + 1 : !init[k]; recontract(); } }
  if (fault === 'contract-domain') {
    const dd = contract.dataDomain as Record<string, Record<string, unknown[]>>;
    const a = Object.keys(dd).find((x) => Object.values(dd[x]).some((v) => v.length > 1));
    if (a) { const p = Object.keys(dd[a]).find((x) => dd[a][x].length > 1)!; dd[a][p] = dd[a][p].slice(0, -1); recontract(); }
  }
  if (fault === 'manifest-data' && files['effects.manifest.json']) {
    const man = JSON.parse(files['effects.manifest.json']) as { effects: Record<string, Record<string, { action: string }>> };
    const entry = Object.values(man.effects).find((e) => e.onSuccess);
    if (entry) { entry.onSuccess = { ...entry.onSuccess, action: `${entry.onSuccess.action}Broken` }; files['effects.manifest.json'] = JSON.stringify(man, null, 2) + '\n'; }
  }
  // PD2.4, S129: an outcome kind that names another decision; the read-back expects the one the handlers adjudicate.
  if (fault === 'outcome-entry' && files['effects.manifest.json']) {
    const man = JSON.parse(files['effects.manifest.json']) as { effects: Record<string, { outcome?: { decision: string } }> };
    const entry = Object.values(man.effects).find((e) => e.outcome);
    if (entry) { entry.outcome = { decision: `${entry.outcome!.decision}Broken` }; files['effects.manifest.json'] = JSON.stringify(man, null, 2) + '\n'; }
  }
  // S151: a capability bound wider than the source declares (the first egress prefix cut back to its origin).
  if (fault === 'widen-target' && files['effects.manifest.json']) {
    const man = JSON.parse(files['effects.manifest.json']) as { effects: Record<string, { targets?: Record<string, string[]> }> };
    const entry = Object.values(man.effects).find((e) => e.targets?.egress?.length);
    if (entry) { entry.targets!.egress[0] = new URL(entry.targets!.egress[0]).origin + '/'; files['effects.manifest.json'] = JSON.stringify(man, null, 2) + '\n'; }
  }
  if (fault === 'path-invariant') rewrite('effect-invariants.mjs', /<= (\d+)/, (m) => `<= ${Number(m.slice(3)) + 1}`);
  if (fault === 'compose-invariant') rewrite('invariants.compose.mjs', /pred: \(joint\) => /, () => 'pred: (joint) => !');
  if (fault === 'liveness-goal') rewrite('liveness.mjs', /goal: \(s\) => /, () => 'goal: (s) => !');
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
    // PD5.1.2: the claims binder, as in the acceptor (S155).
    if (h.by) body.unshift(`    data = { ...data, ${JSON.stringify(h.by.name)}: data.$claims ?? {} };`);
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
  return body.some((s) => (s.kind === 'Intent' && (s.op === 'emit' || s.op === 'after' || s.op === 'cancel' || s.op === 'spawn' || s.op === 'signal' || s.op === 'send' || s.op === 'decide' || s.op === 'adjudicate')) || (s.kind === 'If' && (emitsAny(s.then) || emitsAny(s.else ?? []))) || (s.kind === 'Match' && s.arms.some((a) => emitsAny(a.body))) || (s.kind === 'For' && emitsAny(s.body)));
}

/** PT6.1, S137: the retry of an effect with no retry clause, polyrun's own default written out. */
export const DEFAULT_RETRY = { maxAttempts: 5, baseMs: 500, timeoutMs: 30_000 } as const;

/** effects.manifest.json (PT6.1): one kind per effect, with its completions, retry policy, labels, targets (S151) and class. */
function manifestOf(facts: MachineFacts, env: TypeEnv, cx: Cx & { fault?: Fault }): { effects: Record<string, unknown>; timerTargets?: string[] } {
  // Kinds are the author's strings, so the manifest is built from entries: an assignment to a key such
  // as "__proto__" would set a prototype instead of adding the kind.
  const out: [string, unknown][] = [];
  for (const e of facts.effects.values()) {
    const entry: Record<string, unknown> = {
      payloadSchema: Object.fromEntries(e.params.map((p) => [p.name, { type: jsType(tyOfTypeExpr(p.type, env), env), required: true }])),
    };
    const hooks: Record<string, string> = { ok: 'onSuccess', failed: 'onFailure', exhausted: 'onExhausted' };
    for (const it of e.items) {
      if (it.kind === 'EffOutcome') entry[hooks[it.outcome]] = outcomeEntry(it, cx);
      if (it.kind === 'EffRetry') entry.retry = { maxAttempts: it.attempts, baseMs: durationMs(it.base), timeoutMs: durationMs(it.timeout) };
      if (it.kind === 'EffLabels') entry.labels = it.labels;
      // PT6.5, S151: the runtime binds the handler's capabilities to these; polyrun ignores the field.
      if (it.kind === 'EffTargets') entry.targets = Object.fromEntries(it.targets.map((t) => [t.key, t.values]));
    }
    // S137: an effect with no retry clause declares polyrun's default bound, so every manifest entry has its maxAttempts (S120).
    if (!entry.retry) entry.retry = { ...DEFAULT_RETRY };
    // polyrun ignores fields it does not read, so labels and class stay in the manifest (PT6.1).
    entry.class = effectClass(e);
    out.push([effectKind(e), entry]);
  }
  // PD1.7: a decision is an effect of kind decision.<d>, tried once within its timeout, class none; its reply is
  // mapped into the completion's data with polyrun's `map`, and a timeout is a failure.
  for (const d of facts.decisions.values()) {
    const entry: Record<string, unknown> = {
      payloadSchema: Object.fromEntries(d.params.map((p) => [p.name, { type: jsType(tyOfTypeExpr(p.type, env), env), required: true }])),
    };
    let timeout = 0;
    for (const it of d.items) {
      if (it.kind === 'DecTimeout') timeout = durationMs(it.value)!;
      if (it.kind === 'EffLabels') entry.labels = it.labels;
    }
    entry.retry = { maxAttempts: 1, timeoutMs: timeout };
    for (const it of d.items) {
      if (it.kind !== 'EffOutcome') continue;
      entry[it.outcome === 'ok' ? 'onSuccess' : 'onFailure'] = outcomeEntry(it, cx);
      if (it.outcome === 'failed') entry.onExhausted = outcomeEntry(it, cx);
    }
    entry.class = 'none';
    const provider = d.items.find((i) => i.kind === 'DecProvider') as { value: string } | undefined;
    const band = d.items.find((i) => i.kind === 'DecBand') as { lo: number; hi: number } | undefined;
    entry.decision = { provider: provider?.value ?? null, result: resultValues(tyOfTypeExpr(d.result, env), env, facts), ...(band ? { band: [band.lo, band.hi] } : {}) };
    out.push([`decision.${d.name}`, entry]);
  }
  // PD2.4, S129: each adjudicated decision's outcome kind, class none, tried once, with no completion; its handler is
  // built into the runtime, which writes the outcome event in the adjudicating step's transaction.
  for (const name of adjudicated(facts.machine)) {
    out.push([`outcome.${name}`, { payloadSchema: { outcome: { type: 'string', required: true } }, retry: { maxAttempts: 1, baseMs: 500, timeoutMs: 30_000 }, class: 'none', outcome: { decision: name } }]);
  }
  // S162: the actions the machine's timers start, which only a timer starts in a scope that requires attribution.
  const timers = timerTargets(facts.machine);
  if (cx.fault === 'drop-timer-target') timers.pop();
  return { effects: Object.fromEntries(out), ...(timers.length ? { timerTargets: timers } : {}) };
}

/** The actions a machine's timers start (PT6.3, S162), sorted. */
export function timerTargets(m: A.Machine): string[] {
  const found = new Set<string>();
  const walk = (body: A.Stmt[]): void => {
    for (const s of body) {
      if (s.kind === 'Intent' && s.op === 'after') found.add(s.target);
      if (s.kind === 'If') { walk(s.then); walk(s.else ?? []); }
      if (s.kind === 'Match') for (const a of s.arms) walk(a.body);
      if (s.kind === 'For') walk(s.body);
    }
  };
  for (const it of m.items) if (it.kind === 'Handler') walk(it.body);
  return [...found].sort();
}

/** The decisions a machine's handlers adjudicate (PD2.4), sorted. */
export function adjudicated(m: A.Machine): string[] {
  const found = new Set<string>();
  const walk = (body: A.Stmt[]): void => {
    for (const s of body) {
      if (s.kind === 'Intent' && s.op === 'adjudicate') found.add(s.target);
      if (s.kind === 'If') { walk(s.then); walk(s.else ?? []); }
      if (s.kind === 'Match') for (const a of s.arms) walk(a.body);
      if (s.kind === 'For') walk(s.body);
    }
  };
  for (const it of m.items) if (it.kind === 'Handler') walk(it.body);
  return [...found].sort();
}

/** A completion as the manifest carries it: constants as `data`, and a bound reply as `map` (PD1.7, S79). */
function outcomeEntry(it: A.EffOutcomeItem, cx: Cx): Record<string, unknown> {
  const data: [string, unknown][] = [];
  const map: [string, string][] = [];
  for (const a of it.args) {
    const path = it.bind !== undefined ? boundPath(a.value, it.bind) : null;
    if (path) { map.push([a.name!, ['$.result', ...path].join('.')]); continue; }
    // PD1.3a: an int constant passed as a Conf is in [0, 1], so 1 is 1000 thousandths (review B4).
    const conf = cx.facts.machine.items.find((i): i is A.Action => i.kind === 'Action' && i.name === it.action)?.params.find((p) => p.name === a.name)?.type.kind === 'TConf';
    data.push([a.name!, conf && a.value.kind === 'Int' ? a.value.value * 1000 : constValue(a.value, cx)]);
  }
  return { action: it.action, ...(data.length ? { data: Object.fromEntries(data) } : {}), ...(map.length ? { map: Object.fromEntries(map) } : {}) };
}

/** The answers a decision can give (PD1.7): an enum's constructors, a range's values, or each field's for a record. */
function resultValues(t: Ty, env: TypeEnv, facts: MachineFacts): unknown {
  if (t.k === 'record') return Object.fromEntries(env.records.get(t.name)!.fields.map((f) => [f.name, valuesOfTy(tyOfTypeExpr(f.type, env), env, facts.machine)]));
  return valuesOfTy(t, env, facts.machine);
}

/** A completion argument as the manifest carries it: the checker proved it constant (PT6.1). */
function constValue(e: A.Expr, cx: Cx): unknown {
  // The checker proved the argument constant; it is evaluated as the generated code writes it, so a union
  // constructor is { $: C } (S65), none is null (S58) and 1 + 2 is 3 (review finding L1).
  return new Function(`${prelude(cx.layout)}\nreturn (${expr(e, cx)});`)();
}

/**
 * effect-invariants.mjs (PT5): each path property as a predicate over polyrun's Path. `count` is
 * `p.count(kind)`; `before` reads `p.emitted`, the path's intents in order (S37).
 */
/**
 * polyflow.workflow.json (PT10, S165), written to .poly/build/workflows/<name>/: polyflow names a workflow by its
 * directory, and the descriptor names the machine's lowered files beside it, so nothing is copied.
 */
export function workflowDescriptor(module: string, machine: string, w: A.Workflow, fault?: Fault): Record<string, unknown> {
  const rel = (f: string) => `../../${module}.${machine}/${f}`;
  const tools = w.tools.map((t) => [t.effect, { tool: t.tool, ...(t.target === null ? {} : { target: t.target }), why: t.why }] as [string, Record<string, string>]);
  // The broken variants the read-back must catch (standing rule on artefacts).
  if (fault === 'workflow-tool' && tools.length > 1) { const first = tools[0][1].tool; tools[0][1].tool = tools[1][1].tool; tools[1][1].tool = first; }
  const fields = (w.key?.fields ?? []).map((f) => [f.name, { pattern: f.pattern }] as [string, { pattern: string }]);
  if (fault === 'workflow-key' && fields.length) fields.shift();
  return {
    name: w.name,
    inputAction: w.input,
    tools: Object.fromEntries(tools),
    ...(w.key ? { key: { template: w.key.template, fields: Object.fromEntries(fields) } } : {}),
    contract: rel('contract.json'),
    machine: rel('next.cjs'),
    effects: rel('effects.cjs'),
    manifest: rel('effects.manifest.json'),
    effectInvariants: rel('effect-invariants.mjs'),
    invariants: rel('invariants.mjs'),
  };
}

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


/**
 * S57: alone, a Ref<M> ranges over none and n addresses M#1 … M#n, n being the machine's Ref<M> fields plus
 * the most Ref<M> parameters of one action, plus one per key of a detached spawn of M (S78), plus one for self when
 * M is the machine itself, so every pattern of equalities between addresses is realised.
 */
function refDomain(m: A.Machine, target: string, module: string): unknown[] {
  // S176: a target is spelled M for this module's machine and m.M for a used module's; a name in source is compared
  // in the same spelling.
  const spelled = (parts: string[]) => (parts.length > 1 && parts.slice(0, -1).join('.') !== module ? parts.join('.') : parts[parts.length - 1]);
  const isRef = (t: A.TypeExpr) => t.kind === 'TRef' && spelled(t.machine) === target;
  const fields = m.fields.filter((f) => isRef(f.type)).length;
  const params = Math.max(0, ...m.items.filter((i): i is A.Action => i.kind === 'Action').map((a) => a.params.filter((p) => isRef(p.type)).length));
  // S78: each key of a detached spawn of the target is one more distinct address.
  const keys = new Set<string>();
  const walk = (body: A.Stmt[]): void => {
    for (const s of body) {
      if (s.kind === 'Intent' && s.op === 'spawn' && s.modifier === 'detached' && s.as && spelled(s.target.split('.')) === target) keys.add(s.as);
      if (s.kind === 'If') { walk(s.then); walk(s.else ?? []); }
      if (s.kind === 'Match') for (const a of s.arms) walk(a.body);
      if (s.kind === 'For') walk(s.body);
    }
  };
  for (const i of m.items) if (i.kind === 'Handler') walk(i.body);
  // S57: for the machine's own type, self is one more distinct address.
  const self = target === m.name ? 1 : 0;
  return [null, ...Array.from({ length: fields + params + keys.size + self }, (_, i) => `${target}#${i + 1}`)];
}

/** Whether a parameter's type is a map or holds one through record fields (S65, review finding C3). */
function holdsMap(t: A.TypeExpr, env: TypeEnv, seen: Set<string>): boolean {
  if (t.kind === 'TMap') return true;
  if (t.kind !== 'TName' || seen.has(t.name)) return false;
  seen.add(t.name);
  const r = env.records.get(t.name);
  if (r) return r.fields.some((f) => holdsMap(f.type, env, seen));
  return (env.unions.get(t.name)?.ctors ?? []).some((c) => c.fields.some((f) => holdsMap(f.type, env, seen)));
}

function valuesOfTy(t: Ty, env: TypeEnv, m?: A.Machine): unknown[] {
  // PD5.1.3c: the principal representatives p1..pn, n the Principal positions of the state plus one, at least 2.
  if (t.k === 'principal') {
    if (!m) throw new Error('poly-lower: a principal domain needs its machine (PD5.1.3c)');
    const state = m.fields.reduce((k, f) => k + principalPositions(tyOfTypeExpr(f.type, env), env, new Set()), 0);
    // Review A-F3: plus the most principals one label carries (its parameters and its claims), at least one.
    const handlers = m.items.filter((i): i is A.Handler => i.kind === 'Handler');
    const label = Math.max(1, ...m.items.filter((i): i is A.Action => i.kind === 'Action').map((a) => a.params.reduce((k, p) => k + principalPositions(tyOfTypeExpr(p.type, env), env, new Set()), 0) + (handlers.find((h) => h.action === a.name)?.by ? principalPositions({ k: 'record', name: handlers.find((h) => h.action === a.name)!.by!.type }, env, new Set()) : 0)));
    const n = Math.max(2, state + label);
    return Array.from({ length: n }, (_, i) => `p${i + 1}`);
  }
  // PS4.1f, S180: the content representatives c1..cn and none, n by PS4.1c's rule applied to Content apart. Each ci is
  // spelled as a digest (sha256: and i in 64 hex digits) so that every value of the contract's domain is in the type
  // the runtime reads (S140); none of them names a body.
  if (t.k === 'content') {
    if (!m) throw new Error('poly-lower: a content domain needs its machine (PS4.1f)');
    return [null, ...Array.from({ length: contentCount(m, env) }, (_, i) => `sha256:${(i + 1).toString(16).padStart(64, '0')}`)];
  }
  if (t.k === 'ref') {
    if (!m || t.machine === null) throw new Error('poly-lower: an address domain needs its machine (S57)');
    return refDomain(m, t.machine, env.module ?? '');
  }
  if (t.k === 'bool') return [false, true];
  if (t.k === 'int') {
    // The checker refuses an int with no check domain (PL1101), so this is only reached by a caller that ignored it.
    if (!Number.isFinite(t.lo) || !Number.isFinite(t.hi)) throw new Error('poly-lower: an unbounded int has no domain (PL1101)');
    return Array.from({ length: t.hi - t.lo + 1 }, (_, i) => t.lo + i);
  }
  if (t.k === 'union') {
    if (!isPayloadUnion(env, t)) return env.unions.get(t.name)!.ctors.map((c) => c.name);
    // S65: every constructor with every combination of its payloads, as { $: C, payloads }.
    return env.unions.get(t.name)!.ctors.flatMap((c) => {
      let recs: Record<string, unknown>[] = [{ $: c.name }];
      for (const f of c.fields) {
        const vs = valuesOfTy(tyOfTypeExpr(f.type, env), env, m);
        recs = recs.flatMap((r) => vs.map((v) => ({ ...r, [f.name]: v })));
      }
      return recs;
    });
  }
  if (t.k === 'record') {
    // S25: every combination of field values, as plain objects.
    let recs: Record<string, unknown>[] = [{}];
    for (const f of env.records.get(t.name)!.fields) {
      const vs = valuesOfTy(tyOfTypeExpr(f.type, env), env, m);
      recs = recs.flatMap((r) => vs.map((v) => ({ ...r, [f.name]: v })));
    }
    return recs;
  }
  return [];
}

/** A parameter's values; a completion's childKey takes the keys wired to its action (S51). */
function paramValues(p: A.Param, env: TypeEnv, facts?: MachineFacts, action?: string): unknown[] {
  if (p.type.kind === 'TConf' && facts && action) return confValues(facts, action, p.name);
  const keys = action ? facts?.childKeyDomains.get(action) : undefined;
  if (keys && p.name === 'childKey' && !p.check) return keys;
  return p.check ? checkDomainValues(p.check) : valuesOfTy(tyOfTypeExpr(p.type, env), env, facts?.machine);
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

/**
 * PT6.5, S152: an OpenShell policy for each effect kind, generated from its labels and targets, deterministically
 * (written as JSON, which is YAML). The filesystem is a scratch directory and the system's read-only trees; each
 * declared egress prefix is a REST endpoint by host, port and path (the prefix and below it), bound to each declared
 * secret as a credential provider; a kind with no egress label has no network policy at all. OpenShell has no
 * per-command allowlist, so the declared commands stay enforced in process only (the capability object).
 */
function sandboxPolicies(facts: MachineFacts, fault?: Fault): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const e of facts.effects.values()) {
    const labels = e.items.flatMap((x) => (x.kind === 'EffLabels' ? x.labels : []));
    const targets = Object.fromEntries(e.items.flatMap((x) => (x.kind === 'EffTargets' ? x.targets.map((t) => [t.key, t.values]) : [])));
    const egress = labels.includes('egress:external') || labels.includes('egress:public') ? (targets.egress ?? []) : [];
    const secrets: string[] = labels.includes('read:private') ? (targets.secrets ?? []) : [];
    const endpoints = egress.flatMap((p: string) => {
      const u = new URL(p);
      const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
      const paths = fault === 'widen-sandbox' ? ['/**'] : u.pathname.endsWith('/') ? [`${u.pathname}**`] : [u.pathname, `${u.pathname}/**`];
      return paths.flatMap((path) => (secrets.length ? secrets : [null]).map((s) => ({ host: u.hostname, port, path, protocol: 'rest', access: 'full', ...(s ? { credential_binding: { provider: s } } : {}) })));
    });
    out[effectKind(e)] = {
      version: 1,
      filesystem_policy: { include_workdir: false, read_only: ['/usr', '/lib', '/etc/ssl'], read_write: ['/sandbox/scratch'] },
      landlock: { compatibility: 'hard_requirement' },
      process: { run_as_user: 'sandbox', run_as_group: 'sandbox' },
      network_policies: endpoints.length ? { egress: { endpoints, binaries: [{ path: '**/node' }] } } : {},
    };
  }
  return Object.fromEntries(Object.entries(out).sort(([x], [y]) => (x < y ? -1 : 1)));
}

/** PS4.1f: the Content positions of a type: one for a Content, one per key for a map of them. */
function contentPositions(t: Ty, env: TypeEnv): number {
  if (t.k === 'content') return 1;
  if (t.k === 'map') return contentPositions(t.value, env) * (t.key.k === 'int' ? t.key.hi - t.key.lo + 1 : t.key.k === 'union' ? env.unions.get(t.key.name)!.ctors.length : 1);
  return 0;
}

/** PS4.1f: the Content positions of the state plus the most Content values one label carries (at least one), at least 2. */
export function contentCount(m: A.Machine, env: TypeEnv): number {
  const state = m.fields.reduce((k, f) => k + contentPositions(tyOfTypeExpr(f.type, env), env), 0);
  const label = Math.max(1, ...m.items.filter((i): i is A.Action => i.kind === 'Action').map((a) => a.params.reduce((k, p) => k + contentPositions(tyOfTypeExpr(p.type, env), env), 0)));
  return Math.max(2, state + label);
}

/** S180: whether an action's data can carry a Content, so the runtime may mark a missing body. */
function carriesContent(a: A.Action, env: TypeEnv): boolean {
  // By the resolved type, not the name: a module may declare its own type named Content (polywatch muva0r1v-3c89f81a).
  const holds = (t: Ty): boolean => t.k === 'content' || (t.k === 'map' && holds(t.value));
  return a.params.some((p) => holds(tyOfTypeExpr(p.type, env)));
}

function principalPositions(t: Ty, env: TypeEnv, seen: Set<string>): number {
  if (t.k === 'principal') return 1;
  if (t.k === 'record' && !seen.has(t.name)) return env.records.get(t.name)!.fields.reduce((n, f) => n + principalPositions(tyOfTypeExpr(f.type, env), env, new Set([...seen, t.name])), 0);
  if (t.k === 'union' && !seen.has(t.name)) return env.unions.get(t.name)!.ctors.reduce((n, c) => n + c.fields.reduce((k, f) => k + principalPositions(tyOfTypeExpr(f.type, env), env, new Set([...seen, t.name])), 0), 0);
  // Review A-F3: a map holds one value per key.
  if (t.k === 'map') return principalPositions(t.value, env, seen) * (t.key.k === 'int' ? t.key.hi - t.key.lo + 1 : t.key.k === 'union' ? env.unions.get(t.key.name)!.ctors.length : 1);
  return 0;
}

function controlValues(f: A.Field, facts: MachineFacts, env: TypeEnv): unknown[] {
  const t = facts.fieldTypes.get(f.name)!;
  // A union with payloads is flattened at the top of a field (PS9.1b): its flat value is the tag (review finding L2).
  if (isPayloadUnion(env, t)) return env.unions.get((t as { name: string }).name)!.ctors.map((c) => c.name);
  return f.check ? checkDomainValues(f.check) : valuesOfTy(t, env, facts.machine);
}

function jsType(t: Ty, env: TypeEnv): string {
  return t.k === 'bool' ? 'boolean' : t.k === 'int' || t.k === 'conf' ? 'number' : t.k === 'record' || isPayloadUnion(env, t) ? 'object' : 'string';
  // A principal (PD5.1.2b) is a string, like an address.
}

function typeText(t: Ty, env: TypeEnv): string {
  switch (t.k) {
    case 'bool': return 'boolean';
    case 'int': return Number.isFinite(t.lo) ? `${t.lo}..${t.hi}` : 'number';
    case 'string': return 'string';
    case 'union': return env.unions.get(t.name)!.ctors.map((c) => (isPayloadUnion(env, t) ? `{ $: '${c.name}'${c.fields.map((f) => `, ${f.name}: ${typeText(tyOfTypeExpr(f.type, env), env)}`).join('')} }` : `'${c.name}'`)).join(' | ');
    case 'record': return `{ ${env.records.get(t.name)!.fields.map((f) => `${f.name}: ${typeText(tyOfTypeExpr(f.type, env), env)}`).join(', ')} }`;
    case 'map': return t.array ? `array of ${typeText(t.value, env)}, indexed ${typeText(t.key, env)}` : `object of ${typeText(t.value, env)}, keyed ${typeText(t.key, env)}`;
    case 'ref': return `address of ${t.machine} | null`;
    case 'principal': return 'principal | null';
    case 'content': return 'content | null';
    default: return t.k;
  }
}

function keyTypeText(l: import('./layout.js').FieldLayout, key: string, env: TypeEnv): string {
  if (key === l.field) return typeText(l.ty, env);
  const u = env.unions.get((l.ty as { name: string }).name)!;
  const p = l.payloads!.find(([, k]) => k === key)![0];
  const decl = u.ctors.flatMap((c) => c.fields).find((x) => x.name === p)!;
  const owners = u.ctors.filter((c) => c.fields.some((x) => x.name === p)).map((c) => c.name);
  const t = tyOfTypeExpr(decl.type, env);
  return `${typeText(t, env)} | null (payload of ${owners.join(', ')})`;
}

// ── faults (test-only) ──────────────────────────────────────────────────────
import { applyFault } from './faults.js';

/**
 * PD1.4b: the values a Conf parameter is explored over. The comparisons of the parameter with constants, in the
 * machine's handlers and properties, split 0..1000 into the intervals they can tell apart; one representative,
 * the least value, stands for each. Under PD1.3b no expression can tell two values of one interval apart.
 */
export function confValues(facts: MachineFacts, action: string, param: string): number[] {
  const tests: { op: string; c: number; flip: boolean }[] = [];
  const isParam = (x: A.Expr) => x.kind === 'Name' && facts.resolutions.get(x.id)?.k === 'param' && (facts.resolutions.get(x.id) as { name: string }).name === param;
  const constant = (x: A.Expr) => (x.kind === 'Decimal' ? x.value : x.kind === 'Int' ? x.value * 1000 : null);
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const e = n as A.Expr;
    if (e.kind === 'Binary' && ['==', '!=', '<', '<=', '>', '>='].includes(e.op)) {
      if (isParam(e.left) && constant(e.right) !== null) tests.push({ op: e.op, c: constant(e.right)!, flip: false });
      if (isParam(e.right) && constant(e.left) !== null) tests.push({ op: e.op, c: constant(e.left)!, flip: true });
    }
    for (const [k, v] of Object.entries(e)) if (k !== 'span' && k !== 'id') walk(v);
  };
  for (const it of facts.machine.items) if ((it.kind === 'Handler' && it.action === action) || it.kind === 'Property' || it.kind === 'Guard') walk(it);
  const holds = (v: number, t: { op: string; c: number; flip: boolean }) => {
    const [a, b] = t.flip ? [t.c, v] : [v, t.c];
    switch (t.op) { case '==': return a === b; case '!=': return a !== b; case '<': return a < b; case '<=': return a <= b; case '>': return a > b; default: return a >= b; }
  };
  const seen = new Set<string>();
  const out: number[] = [];
  for (let v = 0; v <= 1000; v++) {
    const sig = tests.map((t) => (holds(v, t) ? '1' : '0')).join('');
    if (!seen.has(sig)) { seen.add(sig); out.push(v); }
  }
  return out;
}
