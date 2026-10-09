// Lowering of one machine to the artefacts the engines read (02 §4, PT4.5, PT5):
//   contract.json   stateKeys (control field first), initState, actions, dataDomain, terminalStates
//   next.cjs        a SAM v2 strict-profile module: sealed modelShape, named intents with
//                   schemas and domains, keyed acceptors, reject/next/unchanged
//   invariants.mjs  stateInvariants, transitionInvariants, rejectionInvariants
import type * as A from '@poly/core';
import type { ChannelPlan, ProviderEntry, ProviderProfile, RoutingFiles, PriceTable, CalibrationFile } from '@poly/core';
import { boundPath, diag, digest, effectKind, effectClass, effectLabels, durationMs, countBound, beforeKinds, reservationOf, type CheckResult, type Diagnostic, type MachineFacts, type Ty, type TypeEnv } from '@poly/core';
import { layoutOf, prelude, isPayloadUnion, tyOfTypeExpr, checkDomainValues, type Layout } from './layout.js';
import { emitsCall } from './emit.js';
import { expr, stmts, mayWrite, resetNames, type Cx, type EmitOptions } from './emit.js';
import { hostTypes } from './host-types.js';

export interface LowerOptions {
  /** Test-only fault injection; `poly check` never sets it (faults.ts). */
  fault?: Fault;
  /** PT6.5, S152: generate an OpenShell policy per effect kind (`isolation: "openshell"` in poly.json). */
  isolation?: 'openshell';
  /** S176: the program's modules, for a send to or a spawn of a used module's machine. */
  program?: A.Module[];
  /** PS15: the module's channels as expanded, for each one's descriptor, written with its application's build. */
  channels?: ChannelPlan[];
  /** PT10e: the provider profiles of the module's credentials, which each credential's descriptor records. */
  providers?: Readonly<Record<string, ProviderEntry>>;
  /** PT10r: the price tables and calibration maps of the module's routes, which each route's descriptor records. */
  routing?: Readonly<RoutingFiles>;
}

export type Fault = 'channel-thread' | 'channel-drop-spawn' | 'channel-drop-ack' | 'channel-swap-rename' | 'channel-inbound-to-app' | 'foreign-enum-member' | 'content-row-on-none' | 'skip-content' | 'content-before-unhandled' | 'drop-never' | 'invert-never-while' | 'drop-never-filter' | 'never-post-state' | 'drop-frame' | 'swap-reason' | 'off-by-one' | 'invert-require' | 'skip-guard' | 'skip-terminal' | 'drop-property' | 'drop-auto-invariant' | 'drop-effect' | 'reorder-effects' | 'unnamed-reject' | 'poison-step' | 'manifest-data' | 'drop-terminal-state' | 'contract-domain' | 'contract-init' | 'path-invariant' | 'compose-invariant' | 'liveness-goal' | 'outcome-entry' | 'widen-target' | 'exact-widened' | 'skip-claims' | 'widen-sandbox' | 'drop-timer-target' | 'workflow-tool' | 'workflow-key' | 'credential-scope-added' | 'credential-holder-dropped' | 'credential-base-widened' | 'types-widen-param' | 'source-unowned' | 'source-key-dropped' | 'flow-class-lowered' | 'flow-recipient-dropped' | 'route-threshold-changed' | 'route-tier-dropped' | 'route-price-stale' | 'budget-cap-raised' | 'decision-budget-dropped' | 'range-cut-dropped';

export interface Lowered {
  machine: string;
  files: { 'contract.json': string; 'next.cjs': string; 'invariants.mjs': string; 'effects.cjs'?: string; 'effects.manifest.json'?: string; 'effect-invariants.mjs'?: string; 'invariants.compose.mjs'?: string; 'liveness.mjs'?: string; 'openshell.policies.yaml'?: string; 'types.d.ts'?: string; [workflow: `../workflows/${string}/polyflow.workflow.json`]: string; [channel: `../channels/${string}.json`]: string; [credential: `../credentials/${string}.json`]: string; [source: `../sources/${string}.json`]: string; [flow: `../flow/${string}.json`]: string; [route: `../routes/${string}.json`]: string; [budget: `../budgets/${string}.json`]: string };
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
  // The fault content-row-on-none fires the row only when the first Content parameter is none, which the runtime never marks.
  const onNone = (a: A.Action) => (opts.fault === 'content-row-on-none' ? ` && proposal[${JSON.stringify(a.params.find((p) => tyOfTypeExpr(p.type, env).k === 'content')?.name ?? '')}] === null` : '');
  if ((terminal && opts.fault !== 'skip-terminal') || guards.length || strict.length || claimed.size || contentful.length) {
    const lines = [`    // PS3.2, rows 1 and 2, then the guards of PS2.2. It runs for handled actions only: no other is an intent (S35).`, `    '*': (model) => (proposal, { reject }) => {`, `      const action = proposal.__actionName;`];
    if (terminal && opts.fault !== 'skip-terminal') lines.push(`      if (TERMINAL(model)) return reject('terminal');`);
    for (const s of strict) {
      // PD1.4b: a Conf is explored by its intervals, and at runtime its domain is 0..1000 (PD1.3a).
      const isConf = actions.find((a) => a.name === s.a)?.params.find((p) => p.name === s.p)?.type.kind === 'TConf';
      // S400: every range is strict now, so a long run of consecutive integers is tested by its bounds, not listed.
      const ints = s.values.length > 16 && s.values.every((v, k) => Number.isInteger(v) && (k === 0 || v === (s.values[k - 1] as number) + 1));
      const [lo, hi] = ints ? [s.values[0], s.values[s.values.length - 1]] : isConf ? [0, 1000] : [null, null];
      const test = isConf || ints ? `!(Number.isInteger(proposal[${JSON.stringify(s.p)}]) && proposal[${JSON.stringify(s.p)}] >= ${lo} && proposal[${JSON.stringify(s.p)}] <= ${hi})` : s.values.some((v) => v !== null && typeof v === 'object')
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
    for (const a of contentful) lines.push(`      if (action === ${JSON.stringify(a.name)} && proposal.$content === 'missing'${onNone(a)}) return reject('content-missing');`);
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
    if (carriesContent(a, env) && opts.fault !== 'skip-content') body.unshift(`      if (proposal.$content === 'missing'${onNone(a)}) return reject('content-missing');`);
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
    const schema: Record<string, unknown> = Object.fromEntries(a.params.map((p) => { const ty = tyOfTypeExpr(p.type, env); return [p.name, { type: jsType(ty, env), required: true, ...(p.type.kind === 'TRef' || ty.k === 'principal' || ty.k === 'content' || ty.k === 'key' ? { nullable: true } : {}) }]; }));
    // PS3.2, S180: the runtime's mark of a missing body travels under the reserved key $content.
    if (carriesContent(a, env)) schema.$content = { type: 'string', required: false, nullable: true };
    // PD5.1.2c, S155: the claims travel under the reserved key $claims; their absence is refused by the acceptor, not
    // the schema, so it is the reserved rejection claims-unverified (PS3.2).
    if (claimed.has(a.name)) schema.$claims = { type: ['object', 'string', 'number', 'boolean', 'array'], required: false, nullable: true };
    const claimsTy = claimsOf(a.name);
    const domain = claimsTy ? dataDomainOf(a, env, facts, opts.fault).flatMap((d) => valuesOfTy(claimsTy, env, facts.machine).map((c) => ({ ...d, $claims: c }))) : dataDomainOf(a, env, facts, opts.fault);
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
    dataDomain: Object.fromEntries(lowerable.filter((a) => a.params.length || claimsOf(a.name)).map((a) => [a.name, { ...Object.fromEntries(a.params.map((p) => [p.name, exploreValues(p, env, facts, a.name, opts.fault)])), ...(claimsOf(a.name) ? { $claims: valuesOfTy(claimsOf(a.name)!, env, facts.machine) } : {}) }])),
    invariants: 'invariants.mjs',
    // S190: the AST digest of each module whose enums this machine uses, so that a build is never run against a
    // changed declaration: the certificate records the same digests, and load compares them.
    ...(typeModules(m, facts, opts.program ?? []) ?? {}),
  };
  // The fault foreign-enum-member drops the last member of another module's enum from each parameter's domain.
  if (opts.fault === 'foreign-enum-member') {
    for (const a of lowerable) for (const p of a.params) {
      const t = tyOfTypeExpr(p.type, env);
      const d = (contract.dataDomain as Record<string, Record<string, unknown[]>>)[a.name];
      if (t.k === 'union' && t.name.includes('.') && d?.[p.name]) d[p.name] = d[p.name].slice(0, -1);
    }
  }

  // ── invariants.mjs ───────────────────────────────────────────────────
  // PS5.2, S178: a step property that reads emits, or a never, reads the step's intents through a copy of the effects
  // mapper, generated as effects.cjs is but with no fault, so the property module stands alone.
  const readsIntents = mutated.items.some((i) => i.kind === 'NeverEmit' || (i.kind === 'Property' && i.form === 'step' && JSON.stringify(i.expr).includes('"kind":"Emits"')));
  const mapperCopy = readsIntents ? effectsModule(mutated, lowerable, handlers, { ...base, mode: 'handler', stateVar: 'pre', dataVar: 'data', module: module.name, moduleDecls: module.decls, program: opts.program }, pre) : null;
  const invariants = invariantsModule(mutated, facts, env, layout, pre, actions.filter((a) => !handlers.has(a.name)).map((a) => a.name), opts.fault, mapperCopy);

  const files: Lowered['files'] = { 'contract.json': JSON.stringify(contract, null, 2) + '\n', 'next.cjs': next, 'invariants.mjs': invariants };
  // PT28.1, PT10h: the host's declarations; the broken lowering types-widen-param widens one parameter to unknown.
  files['types.d.ts'] = hostTypes({ module, machine: m, env, layout, version, program: opts.program ?? [], widen: opts.fault === 'types-widen-param' });
  // ── effects (PT6.1, PT5): the mapper and manifest when the machine declares effects, the path properties' module when it has any ──
  // A machine that arms timers needs the mapper too: a timer is an intent (PT6.3).
  // A machine that sends needs it too (S58): a send is an intent.
  if (facts.effects.size || facts.decisions.size || facts.timerKeys.size || facts.children.size || lowerable.some((a) => emitsAny(handlers.get(a.name)!.body))) {
    files['effects.cjs'] = effectsModule(mutated, lowerable, handlers, { ...base, mode: 'handler', stateVar: 'pre', dataVar: 'data', module: module.name, moduleDecls: module.decls, program: opts.program }, pre, opts.fault);
    files['effects.manifest.json'] = JSON.stringify(manifestOf(facts, env, { ...base, mode: 'init', stateVar: 'model', dataVar: 'data', fault: opts.fault }, module, opts.routing), null, 2) + '\n';
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
  // PS15, PT21.2: each channel's descriptor, written with its application, which the runtime reads to route an inbound
  // message: to the conversation's Inbound (the fault channel-inbound-to-app routes it to the application instead).
  for (const p of opts.channels ?? []) {
    if (p.application !== m.name) continue;
    const lib = (opts.program ?? []).find((x) => x.name === p.library);
    const inbound = opts.fault === 'channel-inbound-to-app' ? { to: 'application', action: p.peer.Message ?? Object.values(p.peer)[0] } : { to: 'conversation', action: 'Inbound' };
    // Review A-F1 (M8b): the fault channel-thread writes a thread key that reads one field fewer.
    const thread = opts.fault === 'channel-thread' ? { template: p.thread.fields.length > 1 ? `{${p.thread.fields[0]}}` : 'fixed', fields: p.thread.fields.slice(0, -1) } : p.thread;
    files[`../channels/${p.name}.json`] = JSON.stringify({ v: 1, channel: p.name, kind: p.kind, library: { module: p.library, digest: lib ? digest(lib) : null }, adapter: p.adapter, thread, application: `${module.name}.${m.name}`, conversation: `${p.module}.Conversation`, starts: p.starts, inbound, peer: p.peer, effectKind: p.effectKind, pending: p.pending, ...(p.audience ? { audience: p.audience } : {}), ...(p.principal ? { principal: p.principal } : {}) }, null, 2) + '\n';
  }
  // PT10r: each route a decision of this machine names has its descriptor, and so has the route's budget: what the
  // runtime reads to run the route's tiers, reserve, settle and record (PS18.2 to PS18.4). The broken lowerings change a
  // threshold, drop the last tier, leave a price table's digest stale, and raise a cap.
  const writeBudget = (name: string) => {
    const b = module.decls.find((x): x is A.Budget => x.kind === 'Budget' && x.name === name);
    if (!b) return;
    files[`../budgets/${b.name}.json`] = JSON.stringify({
      v: 1, budget: b.name, module: module.name, machine: `${module.name}.${b.name}.Budget`,
      caps: b.caps.map((c) => ({ currency: c.currency, amount: opts.fault === 'budget-cap-raised' ? c.amount * 2 : c.amount, run: c.run, period: c.period, scope: c.scope })),
      onExhausted: b.onExhausted,
    }, null, 2) + '\n';
  };
  for (const d of facts.decisions.values()) {
    // PS18.4a, S454: an unrouted decision's budget is written as a route's is.
    const own = d.items.find((i) => i.kind === 'DecBudget') as { budget: string | null } | undefined;
    if (own?.budget) writeBudget(own.budget);
    const named = d.items.find((i) => i.kind === 'DecRoute') as { route: string } | undefined;
    const r = named ? module.decls.find((x): x is A.Route => x.kind === 'Route' && x.name === named.route) : undefined;
    if (!r) continue;
    const tiers = r.tiers.map((t) => {
      const p = opts.routing?.prices[t.prices];
      if (!p) throw new Error(`poly-lower: no price table ${t.prices} for tier ${t.name} of route ${r.name}`);
      const table = p.table as PriceTable;
      const mf = t.calibration === null ? null : opts.routing?.maps[t.calibration];
      if (t.calibration !== null && !mf) throw new Error(`poly-lower: no calibration map ${t.calibration} for tier ${t.name} of route ${r.name}`);
      const map = mf ? (mf.map as CalibrationFile) : null;
      return {
        name: t.name, provider: t.provider, model: table.model, maxInputTokens: t.maxInputTokens, maxTokens: t.maxTokens, reservation: reservationOf(t.maxInputTokens, t.maxTokens, table),
        prices: { path: t.prices, digest: opts.fault === 'route-price-stale' ? `sha256:${'0'.repeat(64)}` : p.digest, currency: table.currency, perMillionTokens: table.perMillionTokens },
        calibration: map && mf ? { path: t.calibration, digest: mf.digest, decision: map.decision, version: map.version, fittedFor: map.fittedFor, points: map.points, mapDigest: map.digest } : null,
      };
    });
    const escalate = r.escalate.map((e) => (opts.fault === 'route-threshold-changed' && e.on !== 'failed' ? { ...e, below: e.below + 1 } : e));
    files[`../routes/${r.name}.json`] = JSON.stringify({
      v: 1, route: r.name, module: module.name, machine: `${module.name}.${r.name}.Route`, effectKind: `route.${r.name}.call`,
      decision: { machine: `${module.name}.${m.name}`, name: d.name },
      tiers: opts.fault === 'route-tier-dropped' ? tiers.slice(0, -1) : tiers, escalate, budget: r.budget,
    }, null, 2) + '\n';
    if (r.budget !== null) writeBudget(r.budget);
  }
  // PT10e: each credential an effect of this machine uses has its descriptor, which the vault adapter reads: what to ask
  // the provider for, and the base addresses the credential may be sent to. The broken lowerings add a scope the source
  // does not declare, and widen a base address to plain http.
  const used = new Set([...facts.effects.values()].flatMap((e) => e.items.flatMap((i) => (i.kind === 'EffUses' ? [i.credential] : []))));
  for (const c of module.decls) {
    if (c.kind !== 'Credential' || !used.has(c.name)) continue;
    const entry = opts.providers?.[c.provider];
    if (!entry) throw new Error(`poly-lower: no profile for provider ${c.provider} of credential ${c.name}`);
    const bases = (entry.profile as ProviderProfile).bases;
    files[`../credentials/${c.name}.json`] = JSON.stringify({
      v: 1, credential: c.name, kind: c.credKind, provider: c.provider, profile: entry.digest, grant: c.grant, pkce: c.pkce,
      scopes: opts.fault === 'credential-scope-added' ? [...c.scopes, 'added.by.fault'] : c.scopes,
      holder: c.holder !== null,
      bases: opts.fault === 'credential-base-widened' ? [...bases, ...bases.map((b) => b.replace(/^https:/, 'http:'))] : bases,
    }, null, 2) + '\n';
  }
  // PS17.0, PS17.3 (S303): the module's sources, each the descriptor its adapter is bound by, and the flow descriptor, the
  // audience order and each channel's declared class, which the runtime's flow check reads. The broken lowerings make an
  // owned source unowned and lower a source's class.
  const sources = module.decls.filter((d): d is A.SourceDecl => d.kind === 'Source');
  if (sources.length || module.decls.some((d) => d.kind === 'Audience')) {
    const classes = module.decls.find((d): d is A.AudienceDecl => d.kind === 'Audience')?.classes ?? [];
    const cls = (c: string) => Math.max(0, classes.indexOf(c));
    for (const s of sources) {
      files[`../sources/${s.name}.json`] = JSON.stringify({ v: 1, module: module.name, source: s.name, kind: s.sourceKind, adapter: s.adapter, audience: s.audience, class: cls(s.audience), owned: opts.fault === 'source-unowned' ? false : s.owned, freshnessMs: s.freshness === null ? null : durationMs(s.freshness), stale: s.stale, ...(s.keys ? { keys: s.keys } : {}) }, null, 2) + '\n';
    }
    const lowered = (k: number, first: boolean) => (opts.fault === 'flow-class-lowered' && first ? 0 : k);
    files[`../flow/${module.name}.json`] = JSON.stringify({
      v: 1, module: module.name, audience: classes,
      sources: Object.fromEntries(sources.map((s, i) => [s.name, { class: lowered(cls(s.audience), i === 0), owned: s.owned }])),
      claims: flowClaims(module),
    }, null, 2) + '\n';
  }
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
    const man = JSON.parse(files['effects.manifest.json']) as { effects: Record<string, { targets?: Record<string, A.TargetValue[]> }> };
    const entry = Object.values(man.effects).find((e) => e.targets?.egress?.length);
    if (entry) { const t = entry.targets!.egress[0]; entry.targets!.egress[0] = new URL(typeof t === 'string' ? t : t.exact).origin + '/'; files['effects.manifest.json'] = JSON.stringify(man, null, 2) + '\n'; }
  }
  // S455: an exact egress target written as a prefix, which would admit every path under it (a draft URL that sends).
  if (fault === 'exact-widened' && files['effects.manifest.json']) {
    const man = JSON.parse(files['effects.manifest.json']) as { effects: Record<string, { targets?: Record<string, A.TargetValue[]> }> };
    const entry = Object.values(man.effects).find((e) => e.targets?.egress?.some((t) => typeof t !== 'string'));
    if (entry) { entry.targets!.egress = entry.targets!.egress.map((t) => (typeof t === 'string' ? t : t.exact)); files['effects.manifest.json'] = JSON.stringify(man, null, 2) + '\n'; }
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
function manifestOf(facts: MachineFacts, env: TypeEnv, cx: Cx & { fault?: Fault }, module?: A.Module, routing?: Readonly<RoutingFiles>): { effects: Record<string, unknown>; timerTargets?: string[] } {
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
      // PT10e: the credential the runtime checks the grant of before the policy (S199), the scopes it needs and the
      // payload field that names the holder. The broken lowering credential-holder-dropped loses the holder.
      if (it.kind === 'EffUses') entry.uses = { credential: it.credential, scopes: it.scopes, holder: cx.fault === 'credential-holder-dropped' ? null : it.holder };
      // PS17.2, PS17.5: what the runtime retrieves or remembers, which no handler performs.
      // S451: a key predicate, which the runtime passes to the adapter and checks each item against. The broken lowering
      // source-key-dropped loses it.
      if (it.kind === 'EffRetrieve') entry.retrieve = { source: it.source, owner: it.owner, ...(it.key && cx.fault !== 'source-key-dropped' ? { key: { name: it.key.name, param: it.key.param } } : {}), limit: it.limit };
      if (it.kind === 'EffRemember') entry.remember = { source: it.source, provenance: it.provenance, about: it.about };
    }
    // PS17.2: a retrieval's and a remember's labels are the runtime's.
    if (!entry.labels && module) { const l = effectLabels(e, module); if (l) entry.labels = l; }
    // PS17.3: the payload field naming the recipient and its declared class, which the runtime's flow check reads.
    const to = e.items.find((x) => x.kind === 'EffTo') as { param: string } | undefined;
    const au = e.items.find((x) => x.kind === 'EffAudience') as { cls: string } | undefined;
    if (to || au) entry.recipient = { to: to?.param ?? null, audience: cx.fault === 'flow-recipient-dropped' ? null : au?.cls ?? null };
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
    const cites = d.items.find((i) => i.kind === 'DecCites') as { param: string } | undefined;
    // PS18.2: a routed decision names its route, whose tiers the runtime runs in place of one provider.
    const route = d.items.find((i) => i.kind === 'DecRoute') as { route: string } | undefined;
    entry.decision = { provider: provider?.value ?? null, ...(route ? { route: route.route } : {}), result: resultValues(tyOfTypeExpr(d.result, env), env, facts), ...(band ? { band: [band.lo, band.hi] } : {}), ...(cites ? { cites: cites.param } : {}) };
    // PS18.4a, PT10r, S454: an unrouted decision's budget, its price table as a tier's record and its reservation, which
    // the runtime reads to reserve and price the call. The broken lowering decision-budget-dropped leaves it out.
    const own = d.items.find((i) => i.kind === 'DecBudget') as { budget: string; prices: string; maxInputTokens: number; maxTokens: number } | undefined;
    if (own && cx.fault !== 'decision-budget-dropped') {
      const p = routing?.prices[own.prices];
      if (!p) throw new Error(`poly-lower: no price table ${own.prices} for decision ${d.name}`);
      const table = p.table as PriceTable;
      (entry.decision as Record<string, unknown>).budget = {
        budget: own.budget, prices: { path: own.prices, digest: p.digest, currency: table.currency, perMillionTokens: table.perMillionTokens },
        maxInputTokens: own.maxInputTokens, maxTokens: own.maxTokens, reservation: reservationOf(own.maxInputTokens, own.maxTokens, table),
      };
    }
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

/**
 * PT10k, PS17.3, S324: each action whose claims type has exactly one field of type Audience, with that field and the
 * claims' one field of type Principal (null when it has none or several).
 */
function flowClaims(module: A.Module): Record<string, { class: string; principal: string | null }> {
  const out: [string, { class: string; principal: string | null }][] = [];
  for (const d of module.decls) {
    if (d.kind !== 'Machine') continue;
    for (const it of d.items) {
      if (it.kind !== 'Handler' || !it.by) continue;
      const rec = module.decls.find((x): x is A.RecordDecl => x.kind === 'RecordDecl' && x.name === it.by!.type);
      const fs = (rec?.fields ?? []).filter((f) => f.type.kind === 'TName' && f.type.name === 'Audience');
      const ps = (rec?.fields ?? []).filter((f) => f.type.kind === 'TName' && f.type.name === 'Principal');
      if (fs.length === 1) out.push([`${d.name}.${it.action}`, { class: fs[0].name, principal: ps.length === 1 ? ps[0].name : null }]);
    }
  }
  return Object.fromEntries(out.sort(([a], [b]) => (a < b ? -1 : 1)));
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
  // PS17.2: an answer that is a body has no finite set of values; the manifest says so.
  if (t.k === 'content') return 'content';
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

function invariantsModule(m: A.Machine, facts: MachineFacts, env: TypeEnv, layout: Layout, pre: string, unhandled: string[], fault?: Fault, mapper: string | null = null): string {
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
  // PS5.2a, S178: never n: emit k(f: v) while P is the step property P(pre) implies !emits(k, f: v). The faults
  // drop-never, invert-never-while, drop-never-filter and never-post-state each break one part of it.
  const nevers = m.items.filter((i): i is A.NeverEmit => i.kind === 'NeverEmit');
  for (const [k, n] of nevers.entries()) {
    if (fault === 'drop-never' && k === 0) continue;
    const condCx: Cx = { facts, env, layout, mode: 'state', stateVar: fault === 'never-post-state' ? 'post' : 'pre', dataVar: 'data' };
    const p = n.cond ? expr(n.cond, condCx) : 'true';
    const cond = fault === 'invert-never-while' ? `(!${p})` : p;
    const sends = emitsCall(n.effect, fault === 'drop-never-filter' ? [] : n.fields, stepCx);
    trans.push(`  { name: ${q(n.name)}, pred: (pre, action, data, post, v) => (!!(v && v.rejected)) || UNHANDLED.has(action) || (!${cond} || !${sends}) },`);
  }
  const rejCx: Cx = { facts, env, layout, mode: 'reject', stateVar: 'state', dataVar: 'data' };
  const rej = m.items.filter((p): p is A.Property => p.kind === 'Property' && p.form === 'reject' && p !== dropped)
    .map((p) => `  { name: ${q(p.name)}, pred: (state, action, data, v) => ${expr(p.expr, rejCx)} },`);
  return [
    `// Generated by poly-lower from ${m.name}. Do not edit.`,
    pre,
    `const UNHANDLED = new Set(${q(unhandled)});`,
    `void UNHANDLED;`,
    ...(mapper ? [
      `// PS5.2, S178: the step's intents, from a copy of the effects mapper; a step property reads them through __emits.`,
      `const __EFFECTS = (() => { const module = { exports: {} };`,
      mapper,
      `return module.exports.effects; })();`,
      `const __emits = (pre, action, data, post, kind, filter) => __EFFECTS(pre, action, data, post, 'accepted').some((i) => i.kind === kind && Object.entries(filter).every(([f, x]) => i.payload && i.payload[f] === x));`,
      `void __emits;`,
    ] : []),
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

/**
 * S190: { typeModules: { m: digest } } for the modules whose enums the machine's types or members name, as m.E, or
 * null when it names none.
 */
function typeModules(m: A.Machine, facts: MachineFacts, program: A.Module[]): { typeModules: Record<string, string> } | null {
  const names = new Set<string>();
  const walk = (x: unknown): void => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    const n = x as { kind?: string; name?: string };
    if (n.kind === 'TName' && n.name?.includes('.')) names.add(n.name);
    for (const [k, v] of Object.entries(n)) if (k !== 'span') walk(v);
  };
  walk(m);
  for (const r of facts.resolutions.values()) if (r.k === 'ctor' && r.union.includes('.')) names.add(r.union);
  for (const t of facts.fieldTypes.values()) if (t.k === 'union' && t.name.includes('.')) names.add(t.name);
  const mods = [...new Set([...names].map((n) => n.slice(0, n.lastIndexOf('.'))))].sort();
  const out: Record<string, string> = {};
  for (const mod of mods) { const d = program.find((x) => x.name === mod); if (d) out[mod] = digest(d); }
  return mods.length ? { typeModules: out } : null;
}

function valuesOfTy(t: Ty, env: TypeEnv, m?: A.Machine): unknown[] {
  // PD5.1.3c: the principal representatives p1..pn, n the Principal positions of the state plus one, at least 2.
  if (t.k === 'principal') {
    if (!m) throw new Error('poly-lower: a principal domain needs its machine (PD5.1.3c)');
    const state = m.fields.reduce((k, f) => k + principalPositions(tyOfTypeExpr(f.type, env), env, new Set()), 0);
    // Review A-F3: plus the most principals one label carries (its parameters and its claims), at least one.
    const handlers = m.items.filter((i): i is A.Handler => i.kind === 'Handler');
    const label = Math.max(1, ...m.items.filter((i): i is A.Action => i.kind === 'Action').map((a) => a.params.reduce((k, p) => k + principalPositions(tyOfTypeExpr(p.type, env), env, new Set()), 0) + (handlers.find((h) => h.action === a.name)?.by ? principalPositions({ k: 'record', name: handlers.find((h) => h.action === a.name)!.by!.type }, env, new Set()) : 0)));
    // PS17.4: one more when the module declares an owned source.
    const n = Math.max(2, state + label) + (env.owning ? 1 : 0);
    return Array.from({ length: n }, (_, i) => `p${i + 1}`);
  }
  // PS4.1f, S180: the content representatives c1..cn and none, n by PS4.1c's rule applied to Content apart. Each ci is
  // spelled as a digest (sha256: and i in 64 hex digits) so that every value of the contract's domain is in the type
  // the runtime reads (S140); none of them names a body.
  if (t.k === 'content') {
    if (!m) throw new Error('poly-lower: a content domain needs its machine (PS4.1f)');
    return [null, ...Array.from({ length: contentCount(m, env) }, (_, i) => `sha256:${(i + 1).toString(16).padStart(64, '0')}`)];
  }
  // PS4.1g, S451: the key representatives k1..kn and none, n by PS4.1c's rule applied to Key apart.
  if (t.k === 'key') {
    if (!m) throw new Error('poly-lower: a key domain needs its machine (PS4.1g)');
    return [null, ...Array.from({ length: keyCount(m, env) }, (_, i) => `k${i + 1}`)];
  }
  // PS1.4b: an Items by its count, 0 to the largest limit; the runtime's carries more, which no handler reads.
  if (t.k === 'items') return Array.from({ length: (env.itemsLimit ?? 0) + 1 }, (_, n) => ({ count: n }));
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

/**
 * PS4.1h, PT3.3a (S458): the values a parameter is explored at. A range parameter whose every use is a comparison with
 * an integer constant, or an unchanged argument of an emit or a decide, is explored at the least value of each class
 * its cut points make; the acceptor still tests its whole check domain (paramValues).
 */
function exploreValues(p: A.Param, env: TypeEnv, facts?: MachineFacts, action?: string, fault?: Fault): unknown[] {
  const all = paramValues(p, env, facts, action);
  const ty = tyOfTypeExpr(p.type, env);
  if (!facts || !action || ty.k !== 'int' || !Number.isFinite(ty.lo) || !Number.isFinite(ty.hi) || p.type.kind === 'TConf') return all;
  const reps = cutRepresentatives(facts.machine, action, p.name, all as number[]);
  // The broken lowering range-cut-dropped explores one class fewer, which poly-ref's read-back of dataDomain finds.
  return reps && reps.length < all.length ? (fault === 'range-cut-dropped' ? reps.slice(0, -1) : reps) : all;
}

/**
 * PS4.1h: the least value of each class of `values` that the parameter's cut points make, or null when a use other than
 * a comparison with an integer constant or an unchanged emit or decide argument turns the reduction off.
 */
function cutRepresentatives(m: A.Machine, action: string, param: string, values: number[]): number[] | null {
  if (m.fields.some((x) => x.name === param)) return null;
  const cmp: [string, number, boolean][] = [];
  const passed = new Set<string>();
  let usedOtherwise = false;
  const int = (x: A.Expr): number | null => (x.kind === 'Int' ? x.value : x.kind === 'Unary' && x.op === '-' && x.arg.kind === 'Int' ? -x.arg.value : null);
  const named = (x: A.Expr): boolean => x.kind === 'Name' && x.name === param;
  const declared = (target: string): string[] => {
    const d = m.items.find((x) => (x.kind === 'EffectDecl' || x.kind === 'Decision') && x.name === target) as { params: A.Param[] } | undefined;
    return d ? d.params.map((q) => q.name) : [];
  };
  const walk = (n: unknown): void => {
    if (usedOtherwise || n === null || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    const o = n as Record<string, unknown> & { kind?: string };
    if (o.kind === 'Binary' && ['==', '!=', '<', '<=', '>', '>='].includes(o.op as string)) {
      const l = o.left as A.Expr, r = o.right as A.Expr;
      if (named(l) && int(r) !== null) { cmp.push([o.op as string, int(r)!, false]); return; }
      if (named(r) && int(l) !== null) { cmp.push([o.op as string, int(l)!, true]); return; }
    }
    if (o.kind === 'Intent' && (o.op === 'emit' || o.op === 'decide')) {
      const ps = declared(o.target as string);
      (o.args as A.NamedArg[]).forEach((x, i) => { if (named(x.value)) passed.add(`${o.target as string}.${x.name ?? ps[i] ?? ''}`); else walk(x.value); });
      return;
    }
    if ((o.kind === 'Name' && o.name === param) || (o.kind === 'Let' && o.name === param) || (o.kind === 'For' && Object.values(o).includes(param)) || (o.kind === 'PCtor' && (o.fields as { bind: string | null }[]).some((x) => x.bind === param))) { usedOtherwise = true; return; }
    for (const k of Object.keys(o)) if (k !== 'span' && k !== 'id') walk(o[k]);
  };
  for (const it of m.items) {
    if (it.kind === 'Handler') { if (it.action === action) walk(it); }
    else if (it.kind === 'Guard' || it.kind === 'Property' || it.kind === 'Liveness') walk(it);
    else if (it.kind === 'NeverEmit') walk(it.cond);
  }
  if (usedOtherwise) return null;
  // emits(k, f: v) and never … emit k(f: v) on a payload field the parameter is passed into unchanged: p == v.
  const findEmits = (n: unknown): void => {
    if (n === null || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) findEmits(x); return; }
    const o = n as Record<string, unknown> & { kind?: string };
    if (o.kind === 'Emits' || o.kind === 'NeverEmit') for (const x of o.fields as A.EmitsField[]) { const v = int(x.value); if (v !== null && passed.has(`${o.effect as string}.${x.name}`)) cmp.push(['==', v, false]); }
    for (const k of Object.keys(o)) if (k !== 'span' && k !== 'id') findEmits(o[k]);
  };
  for (const it of m.items) if (it.kind === 'Property' || it.kind === 'NeverEmit') findEmits(it);
  const test = (v: number, [op, c, flip]: [string, number, boolean]) => {
    const a = flip ? c : v, b = flip ? v : c;
    return op === '==' ? a === b : op === '!=' ? a !== b : op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
  };
  const seen = new Set<string>();
  const out: number[] = [];
  for (const v of [...values].sort((a, b) => a - b)) {
    const key = cmp.map((x) => (test(v, x) ? '1' : '0')).join('');
    if (!seen.has(key)) { seen.add(key); out.push(v); }
  }
  return out;
}

/** D(a) as the intent's `domain`: every payload object (PS1.1), each cut parameter at its representatives (S458). */
function dataDomainOf(a: A.Action, env: TypeEnv, facts?: MachineFacts, fault?: Fault): Record<string, unknown>[] {
  let recs: Record<string, unknown>[] = [{}];
  for (const p of a.params) {
    const vs = exploreValues(p, env, facts, a.name, fault);
    recs = recs.flatMap((r) => vs.map((v) => ({ ...r, [p.name]: v })));
  }
  return recs;
}

/**
 * PT6.5, S152: an OpenShell policy for each effect kind, generated from its labels and targets, deterministically
 * (written as JSON, which is YAML). The filesystem is a scratch directory and the system's read-only trees; each
 * declared egress prefix is a REST endpoint by host, port and path (the prefix and below it), and an exact target
 * (S455) by its path alone, bound to each declared secret as a credential provider; a kind with no egress label has
 * no network policy at all. OpenShell has no per-command allowlist, so the declared commands stay enforced in process
 * only (the capability object).
 */
function sandboxPolicies(facts: MachineFacts, fault?: Fault): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const e of facts.effects.values()) {
    const labels = e.items.flatMap((x) => (x.kind === 'EffLabels' ? x.labels : []));
    const targets: Record<string, A.TargetValue[]> = Object.fromEntries(e.items.flatMap((x) => (x.kind === 'EffTargets' ? x.targets.map((t) => [t.key, t.values]) : [])));
    const egress = labels.includes('egress:external') || labels.includes('egress:public') ? (targets.egress ?? []) : [];
    const secrets = labels.includes('read:private') ? (targets.secrets ?? []).filter((s): s is string => typeof s === 'string') : [];
    const endpoints = egress.flatMap((p) => {
      const u = new URL(typeof p === 'string' ? p : p.exact);
      const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
      const paths = fault === 'widen-sandbox' ? ['/**'] : typeof p !== 'string' ? [u.pathname] : u.pathname.endsWith('/') ? [`${u.pathname}**`] : [u.pathname, `${u.pathname}/**`];
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

/** PS4.1g: the Key positions of a type: one for a Key, its fields' for a record or a union, one per key for a map. */
function keyPositions(t: Ty, env: TypeEnv, seen: Set<string>): number {
  if (t.k === 'key') return 1;
  if (t.k === 'record' && !seen.has(t.name)) return env.records.get(t.name)!.fields.reduce((n, f) => n + keyPositions(tyOfTypeExpr(f.type, env), env, new Set([...seen, t.name])), 0);
  if (t.k === 'union' && !seen.has(t.name)) return env.unions.get(t.name)!.ctors.reduce((n, c) => n + c.fields.reduce((k, f) => k + keyPositions(tyOfTypeExpr(f.type, env), env, new Set([...seen, t.name])), 0), 0);
  if (t.k === 'map') return keyPositions(t.value, env, seen) * (t.key.k === 'int' ? t.key.hi - t.key.lo + 1 : t.key.k === 'union' ? env.unions.get(t.key.name)!.ctors.length : 1);
  return 0;
}

/** PS4.1g: the Key positions of the state plus the most keys one label carries (at least one), at least 2. */
export function keyCount(m: A.Machine, env: TypeEnv): number {
  const state = m.fields.reduce((k, f) => k + keyPositions(tyOfTypeExpr(f.type, env), env, new Set()), 0);
  const label = Math.max(1, ...m.items.filter((i): i is A.Action => i.kind === 'Action').map((a) => a.params.reduce((k, p) => k + keyPositions(tyOfTypeExpr(p.type, env), env, new Set()), 0)));
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
  return t.k === 'bool' ? 'boolean' : t.k === 'int' || t.k === 'conf' ? 'number' : t.k === 'record' || t.k === 'items' || isPayloadUnion(env, t) ? 'object' : 'string';
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
    case 'key': return 'key | null';
    case 'items': return 'items';
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
