// Every artefact the runtime reads is checked (the standing rule after the M1 review, decisions-m1.md).
//
// Translation validation (tv.ts) compares next.cjs, invariants.mjs and the effects mapper by running
// them. The other artefacts are data or predicates the engines read without running the module:
//   - contract.json: the state keys, the initial state, the actions, dataDomain and terminalStates;
//   - effects.manifest.json: each kind with its payload keys, completions and their data, retry,
//     labels and class (PT6.1, S67);
//   - effect-invariants.mjs: each path property as polyrun's check-effects evaluates it (PS5.4);
//   - invariants.compose.mjs: each compose invariant as check-product evaluates it (PS7.3).
// Each is read back here and compared with what 04-semantics gives for the source, computed by
// poly-ref's own model. The timer and child wiring is part of the mapper's intents, which tv.ts compares.
import type * as A from '@poly/core';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importArtefact } from './import-artefact.js';
import { valuesOf, monitorStart, monitorStep, replyPath, type RMachine, type RPathProperty, type RType } from './model.js';
import { initialState, durationMs } from './step.js';
import { evaluate, evaluateAt } from './eval.js';
import { flatten, flatValue } from './alpha.js';
import { checkJoint } from './joint.js';
import type { State, Value } from './values.js';

const stable = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ':' + stable((v as Record<string, unknown>)[k])).join(',') + '}';
};

/** The repository's std/, where the provider profiles of PT10e are, unless the caller names another. */
const STD = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'std');

/** The mismatches between the artefacts in `dir` and the source, one message each (PL2501 in tv.ts). */
export async function readBack(module: A.Module, M: RMachine, dir: string, states: State[] = [], std: string = STD): Promise<string[]> {
  const out: string[] = [];
  const decl = module.decls.find((d): d is A.Machine => d.kind === 'Machine' && d.name === M.name)!;
  const differ = (what: string, got: unknown, want: unknown) => { if (stable(got) !== stable(want)) out.push(`${what}: the artefact has ${stable(got)}, the source gives ${stable(want)}`); };

  // ── contract.json ──
  const contract = JSON.parse(readFileSync(join(dir, 'contract.json'), 'utf8')) as { stateKeys: { name: string }[]; initState: unknown; actions: Record<string, { dataFields: Record<string, unknown> }>; dataDomain?: Record<string, Record<string, unknown[]>> };
  const init = flatten(initialState(M), M);
  differ('contract.json stateKeys', contract.stateKeys.map((k) => k.name), Object.keys(init));
  differ('contract.json initState', contract.initState, init);
  // S35: only handled actions are in the lowered module and its contract, in declaration order.
  const handled = M.actions.filter((a) => M.handlers.has(a.name));
  differ('contract.json actions', Object.keys(contract.actions), handled.map((a) => a.name));
  for (const a of handled) {
    differ(`contract.json actions.${a.name}.dataFields`, Object.keys(contract.actions[a.name]?.dataFields ?? {}), [...a.params.map((p) => p.name), ...(a.claims ? ['$claims'] : [])]);
    if (!a.params.length && !a.claims) continue;
    // D(a) per parameter (PS1.1): its check domain, or every value of its type, encoded as the runtime sees it; and
    // the claims over the principal representatives (PD5.1.3c, S155).
    const want: Record<string, unknown[]> = Object.fromEntries(a.params.map((p) => [p.name, (p.check ?? valuesOf(p.type, M)).map((v) => flatValue(v, p.type, M))]));
    if (a.claims) want.$claims = valuesOf(a.claims.type, M).map((v) => flatValue(v, a.claims!.type, M));
    differ(`contract.json dataDomain.${a.name}`, contract.dataDomain?.[a.name], want);
  }
  // S190: the modules whose enums the machine uses are recorded with their digests, which load compares with the
  // certificate's. Each module of an enum in a field or parameter is listed, and nothing poly-ref knows no enum of.
  const tm = Object.keys((contract as { typeModules?: Record<string, string> }).typeModules ?? {}).sort();
  const modOf = (t: RType): string[] => (t.k === 'union' && t.name.includes('.') ? [t.name.slice(0, t.name.lastIndexOf('.'))] : t.k === 'map' ? [...modOf(t.key), ...modOf(t.value)] : []);
  const needed = [...new Set([...M.fields.map((f) => f.type), ...M.actions.flatMap((x) => x.params.map((p) => p.type))].flatMap(modOf))].sort();
  const known = new Set([...M.unions.keys()].filter((n) => n.includes('.')).map((n) => n.slice(0, n.lastIndexOf('.'))));
  for (const mod of needed) if (!tm.includes(mod)) out.push(`contract.json typeModules: ${mod} is missing, and ${M.name} has a field or parameter of its enums (S190)`);
  for (const mod of tm) if (!known.has(mod)) out.push(`contract.json typeModules: ${mod} is listed, and ${M.name} uses no enum of it (S190)`);

  // ── types.d.ts (PT28.1, PT10h, S311): the declarations PT10h gives for this machine, written here from poly-ref's own
  // model, compared line for line; the first line's digest is the contract's machineVersion ──
  const typesFile = join(dir, 'types.d.ts');
  if (!existsSync(typesFile)) out.push('types.d.ts is missing (PT28.1)');
  else {
    const got = readFileSync(typesFile, 'utf8').split('\n');
    const want = hostDeclarations(M, decl).split('\n');
    const version = (contract as { machineVersion?: string }).machineVersion;
    const head = `// Generated by poly-lower from ${M.id}, module digest ${version} (PT28.1). Do not edit: change the poly source and rebuild.`;
    if (got[0] !== head) out.push(`types.d.ts line 1: the artefact has ${JSON.stringify(got[0])}, and the contract gives ${JSON.stringify(head)}`);
    const n = Math.max(got.length - 1, want.length);
    for (let i = 0; i < n; i++) {
      if (got[i + 1] !== want[i]) { out.push(`types.d.ts line ${i + 2}: the artefact has ${JSON.stringify(got[i + 1] ?? null)}, the source gives ${JSON.stringify(want[i] ?? null)}`); break; }
    }
  }

  // ── effects.manifest.json ──
  const effects = decl.items.filter((i): i is A.EffectDecl => i.kind === 'EffectDecl');
  const decisions = decl.items.filter((i): i is A.Decision => i.kind === 'Decision');
  const manifestPath = join(dir, 'effects.manifest.json');
  // A completion: its constant data (S67), and the reply's paths it binds as `map` (PD1.7, S79).
  const outcome = (it: A.EffOutcomeItem): unknown => {
    const target = M.actions.find((x) => x.name === it.action);
    const data: [string, unknown][] = [];
    const map: [string, string][] = [];
    for (const arg of it.args) {
      const path = it.bind !== undefined ? replyPath(arg.value, it.bind) : null;
      if (path) { map.push([arg.name!, ['$.result', ...path].join('.')]); continue; }
      const p = target?.params.find((x) => x.name === arg.name)!;
      // PD1.3a: an int constant given as a Conf is in [0, 1], so 1 is 1000 thousandths.
      const v: Value = p.type.k === 'conf' && arg.value.kind === 'Int' ? arg.value.value * 1000 : evaluateAt(arg.value, { M, state: {}, data: {}, locals: new Map() }, p.type);
      data.push([arg.name!, flatValue(v, p.type, M)]);
    }
    return { action: it.action, ...(data.length ? { data: Object.fromEntries(data) } : {}), ...(map.length ? { map: Object.fromEntries(map) } : {}) };
  };
  if (effects.length || decisions.length || existsSync(manifestPath)) {
    if (!existsSync(manifestPath)) out.push('effects.manifest.json is missing, and the machine declares effects');
    else {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { effects: Record<string, Record<string, unknown>> };
      const byKind = new Map(effects.map((e) => [M.effects.get(e.name)!.kind, e]));
      // PD2.4, S129: an adjudicated decision's outcome kind, read from the handlers here, not from the lowering.
      const judged = new Set<string>();
      const walk = (body: A.Stmt[]): void => { for (const s of body) { if (s.kind === 'Intent' && s.op === 'adjudicate') judged.add(s.target); if (s.kind === 'If') { walk(s.then); walk(s.else ?? []); } if (s.kind === 'Match') for (const a of s.arms) walk(a.body); if (s.kind === 'For') walk(s.body); } };
      for (const h of M.handlers.values()) walk(h.body);
      // S162: the actions timers start, read from the handlers here, not from the lowering.
      const timed = new Set<string>();
      const walkTimers = (body: A.Stmt[]): void => { for (const s of body) { if (s.kind === 'Intent' && s.op === 'after') timed.add(s.target); if (s.kind === 'If') { walkTimers(s.then); walkTimers(s.else ?? []); } if (s.kind === 'Match') for (const a of s.arms) walkTimers(a.body); if (s.kind === 'For') walkTimers(s.body); } };
      for (const h of M.handlers.values()) walkTimers(h.body);
      differ('effects.manifest.json timerTargets', (manifest as { timerTargets?: string[] }).timerTargets ?? [], [...timed].sort());
      differ('effects.manifest.json kinds', Object.keys(manifest.effects).sort(), [...byKind.keys(), ...decisions.map((d) => M.decisions.get(d.name)!.kind), ...[...judged].map((d) => `outcome.${d}`)].sort());
      for (const d of judged) {
        differ(`effects.manifest.json outcome.${d}`, manifest.effects[`outcome.${d}`] ?? null, { payloadSchema: { outcome: { type: 'string', required: true } }, retry: { maxAttempts: 1, baseMs: 500, timeoutMs: 30000 }, class: 'none', outcome: { decision: d } });
      }
      for (const [kind, e] of byKind) {
        const entry = manifest.effects[kind];
        if (!entry) continue;
        differ(`effects.manifest.json ${kind}.payloadSchema`, Object.keys((entry.payloadSchema as object) ?? {}), e.params.map((p) => p.name));
        const hooks = { ok: 'onSuccess', failed: 'onFailure', exhausted: 'onExhausted' } as const;
        for (const [which, hook] of Object.entries(hooks)) {
          const it = e.items.find((x): x is A.EffOutcomeItem => x.kind === 'EffOutcome' && x.outcome === which);
          if (!it) { differ(`effects.manifest.json ${kind}.${hook}`, entry[hook] ?? null, null); continue; }
          differ(`effects.manifest.json ${kind}.${hook}`, entry[hook], outcome(it));
        }
        const retry = e.items.find((x): x is A.EffectItem & { kind: 'EffRetry' } => x.kind === 'EffRetry');
        differ(`effects.manifest.json ${kind}.retry`, entry.retry ?? null, retry ? { maxAttempts: retry.attempts, baseMs: durationMs(retry.base), timeoutMs: durationMs(retry.timeout) } : { maxAttempts: 5, baseMs: 500, timeoutMs: 30000 }); // PT6.1, S137
        const labels = e.items.find((x): x is A.EffectItem & { kind: 'EffLabels' } => x.kind === 'EffLabels');
        differ(`effects.manifest.json ${kind}.labels`, entry.labels ?? null, labels ? labels.labels : null);
        // S151: the capability bounds, read back exactly: a wider prefix in the manifest is a wider capability at run time.
        const targets = e.items.find((x): x is A.EffTargets => x.kind === 'EffTargets');
        differ(`effects.manifest.json ${kind}.targets`, entry.targets ?? null, targets ? Object.fromEntries(targets.targets.map((t) => [t.key, t.values])) : null);
        differ(`effects.manifest.json ${kind}.class`, entry.class, M.effects.get(e.name)!.cls);
        // PT10e: the credential the runtime checks the grant of, its scopes, and the parameter naming its holder.
        const uses = e.items.find((x): x is A.EffUses => x.kind === 'EffUses');
        differ(`effects.manifest.json ${kind}.uses`, entry.uses ?? null, uses ? { credential: uses.credential, scopes: uses.scopes, holder: uses.holder } : null);
      }
      // PD1.7: a decision, tried once within its timeout, class none; a timeout is its failure.
      for (const d of decisions) {
        const kind = M.decisions.get(d.name)!.kind;
        const entry = manifest.effects[kind];
        if (!entry) continue;
        differ(`effects.manifest.json ${kind}.payloadSchema`, Object.keys((entry.payloadSchema as object) ?? {}), d.params.map((p) => p.name));
        const timeout = d.items.find((x) => x.kind === 'DecTimeout') as { value: string } | undefined;
        differ(`effects.manifest.json ${kind}.retry`, entry.retry ?? null, { maxAttempts: 1, timeoutMs: timeout ? durationMs(timeout.value) : 0 });
        const ok = d.items.find((x): x is A.EffOutcomeItem => x.kind === 'EffOutcome' && x.outcome === 'ok');
        const failed = d.items.find((x): x is A.EffOutcomeItem => x.kind === 'EffOutcome' && x.outcome === 'failed');
        differ(`effects.manifest.json ${kind}.onSuccess`, entry.onSuccess ?? null, ok ? outcome(ok) : null);
        differ(`effects.manifest.json ${kind}.onFailure`, entry.onFailure ?? null, failed ? outcome(failed) : null);
        differ(`effects.manifest.json ${kind}.onExhausted`, entry.onExhausted ?? null, failed ? outcome(failed) : null);
        const labels = d.items.find((x) => x.kind === 'EffLabels') as { labels: string[] } | undefined;
        differ(`effects.manifest.json ${kind}.labels`, entry.labels ?? null, labels ? labels.labels : null);
        differ(`effects.manifest.json ${kind}.class`, entry.class, 'none');
        const provider = d.items.find((x) => x.kind === 'DecProvider') as { value: string } | undefined;
        const band = d.items.find((x) => x.kind === 'DecBand') as { lo: number; hi: number } | undefined;
        const answers = (t: RType): unknown => (t.k === 'record' ? Object.fromEntries(M.records.get(t.name)!.fields.map((f) => [f.name, answers(f.type)])) : valuesOf(t, M).map((v) => flatValue(v, t, M)));
        differ(`effects.manifest.json ${kind}.decision`, entry.decision, { provider: provider?.value ?? null, result: answers(resultType(d.result, M)), ...(band ? { band: [band.lo, band.hi] } : {}) });
      }
    }
  }

  // ── openshell.policies.yaml (PT6.5, S152): present only when isolation is asked for; then exactly the source's ──
  const sandboxFile = join(dir, 'openshell.policies.yaml');
  if (existsSync(sandboxFile)) {
    let got: unknown = null;
    try { got = JSON.parse(readFileSync(sandboxFile, 'utf8')); } catch { out.push('openshell.policies.yaml is not readable'); }
    const want: Record<string, unknown> = {};
    const m = module.decls.find((d): d is A.Machine => d.kind === 'Machine' && d.name === M.name)!;
    for (const e of [...m.items.filter((x): x is A.EffectDecl => x.kind === 'EffectDecl')].sort((x, y) => (M.effects.get(x.name)!.kind < M.effects.get(y.name)!.kind ? -1 : 1))) {
      const labels = new Set(e.items.flatMap((x) => (x.kind === 'EffLabels' ? x.labels : [])));
      const t = e.items.find((x): x is A.EffTargets => x.kind === 'EffTargets');
      const of = (k: string) => t?.targets.find((x) => x.key === k)?.values ?? [];
      const prefixes = labels.has('egress:external') || labels.has('egress:public') ? of('egress') : [];
      const secrets = labels.has('read:private') ? of('secrets') : [];
      const endpoints: unknown[] = [];
      for (const p of prefixes) {
        const u = new URL(p);
        const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
        const globs = u.pathname.endsWith('/') ? [u.pathname + '**'] : [u.pathname, u.pathname + '/**'];
        for (const g of globs) for (const s of secrets.length ? secrets : [null]) endpoints.push({ host: u.hostname, port, path: g, protocol: 'rest', access: 'full', ...(s ? { credential_binding: { provider: s } } : {}) });
      }
      want[M.effects.get(e.name)!.kind] = {
        version: 1,
        filesystem_policy: { include_workdir: false, read_only: ['/usr', '/lib', '/etc/ssl'], read_write: ['/sandbox/scratch'] },
        landlock: { compatibility: 'hard_requirement' },
        process: { run_as_user: 'sandbox', run_as_group: 'sandbox' },
        network_policies: endpoints.length ? { egress: { endpoints, binaries: [{ path: '**/node' }] } } : {},
      };
    }
    if (got !== null) differ('openshell.policies.yaml', got, want);
  }

  // ── effect-invariants.mjs (PS5.4) ──
  const pathFile = join(dir, 'effect-invariants.mjs');
  if (M.pathProperties.length) {
    if (!existsSync(pathFile)) out.push('effect-invariants.mjs is missing, and the machine has path properties');
    else {
      const lowered = ((await importArtefact(pathFile)) as { effectInvariants?: { name: string; pred: (p: unknown) => boolean }[] }).effectInvariants ?? [];
      for (const p of M.pathProperties) {
        const l = lowered.find((x) => x.name === p.name);
        if (!l) { out.push(`effect-invariants.mjs has no predicate ${p.name}`); continue; }
        const bad = pathDisagreement(p, l.pred, [...[...M.effects.values()].map((e) => e.kind), ...[...M.decisions.values()].map((d) => d.kind), 'timer', 'cancelTimer', 'spawnChild', 'signalChild', 'sendTo', 'createInstance']);
        if (bad) out.push(`effect-invariants.mjs ${p.name} is ${bad.lowered} on the emissions ${stable(bad.kinds)}, and PS5.4 gives ${!bad.lowered}`);
      }
    }
  }

  // ── credentials/<c>.json (PT10e): each credential an effect of this machine uses, against its source and the
  // provider profile it names, read here from the profile's file ──
  for (const name of new Set(effects.flatMap((e) => e.items.flatMap((i) => (i.kind === 'EffUses' ? [i.credential] : []))))) {
    const c = module.decls.find((d): d is A.Credential => d.kind === 'Credential' && d.name === name);
    if (!c) { out.push(`an effect uses credential ${name}, which the source does not declare`); continue; }
    const file = join(dir, '..', 'credentials', `${name}.json`);
    if (!existsSync(file)) { out.push(`credentials/${name}.json is missing, and an effect of ${M.name} uses ${name} (PT10e)`); continue; }
    let got: unknown;
    try { got = JSON.parse(readFileSync(file, 'utf8')); } catch { out.push(`credentials/${name}.json is not JSON`); continue; }
    const profileFile = join(std, 'credentials', 'providers', `${c.provider}.json`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(c.provider) || !existsSync(profileFile)) { out.push(`credentials/${name}.json: provider ${c.provider} has no profile to read back against`); continue; }
    const bytes = readFileSync(profileFile);
    let bases: unknown = null;
    try { bases = (JSON.parse(bytes.toString('utf8')) as { bases?: unknown }).bases ?? null; } catch { bases = null; }
    differ(`credentials/${name}.json`, got, { v: 1, credential: c.name, kind: c.credKind, provider: c.provider, profile: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), grant: c.grant, pkce: c.pkce, scopes: c.scopes, holder: c.holder !== null, bases });
  }

  // ── polyflow.workflow.json (PT10, S165): each workflow that runs this machine, read back against its source ──
  for (const w of module.decls.filter((d): d is A.Workflow => d.kind === 'Workflow' && d.machine === decl.name)) {
    const file = join(dir, '..', 'workflows', w.name, 'polyflow.workflow.json');
    if (!existsSync(file)) { out.push(`the descriptor of workflow ${w.name} is missing`); continue; }
    let got: Record<string, unknown>;
    try { got = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { out.push(`the descriptor of workflow ${w.name} is not JSON`); continue; }
    const rel = (f: string) => `../../${module.name}.${decl.name}/${f}`;
    differ(`polyflow.workflow.json of ${w.name}`, got, {
      name: w.name,
      inputAction: w.input,
      tools: Object.fromEntries(w.tools.map((t) => [t.effect, { tool: t.tool, ...(t.target === null ? {} : { target: t.target }), why: t.why }])),
      ...(w.key ? { key: { template: w.key.template, fields: Object.fromEntries(w.key.fields.map((f) => [f.name, { pattern: f.pattern }])) } } : {}),
      contract: rel('contract.json'), machine: rel('next.cjs'), effects: rel('effects.cjs'), manifest: rel('effects.manifest.json'), effectInvariants: rel('effect-invariants.mjs'), invariants: rel('invariants.mjs'),
    });
  }

  // ── invariants.compose.mjs (PS7.3) ──
  const compose = decl.items.filter((i): i is A.Property => i.kind === 'Property' && i.form === 'compose');
  const composeFile = join(dir, 'invariants.compose.mjs');
  if (compose.length) {
    if (!existsSync(composeFile)) out.push('invariants.compose.mjs is missing, and the machine has compose invariants');
    else {
      const lowered = ((await importArtefact(composeFile)) as { stateInvariants?: { name: string; pred: (j: unknown) => boolean }[] }).stateInvariants ?? [];
      const joint = checkJoint(module, M.name);
      for (const p of compose) {
        const l = lowered.find((x) => x.name === p.name);
        if (!l) { out.push(`invariants.compose.mjs has no predicate ${p.name}`); continue; }
        for (const j of joint.graph.states) {
          const children = new Map(j.children.map(([k, c]) => [k, c.state]));
          const want = evaluate(p.expr, { M: j.parent.machine, state: j.parent.state, data: {}, locals: new Map(), joint: { parent: j.parent.state, children } }) === true;
          // check-product's joint state: each instance's flat state (PS9.1b), by child key.
          const view = { parent: { state: flatten(j.parent.state, j.parent.machine) }, children: Object.fromEntries(j.children.map(([k, c]) => [k, { state: flatten(c.state, c.machine) }])) };
          let got: boolean | string;
          try { got = l.pred(view) === true; } catch (e) { got = `a throw (${(e as Error).message})`; }
          if (got !== want) { out.push(`invariants.compose.mjs ${p.name} is ${got} on a reachable joint state, and PS7.3 gives ${want}`); break; }
        }
      }
    }
  }
  // ── liveness.mjs (S74) ──
  const live = M.liveness.filter((p) => !p.quant);
  const liveFile = join(dir, 'liveness.mjs');
  if (live.length) {
    if (!existsSync(liveFile)) out.push('liveness.mjs is missing, and the machine has liveness properties');
    else {
      const lowered = ((await importArtefact(liveFile)) as { liveness?: { name: string; goal: (s: unknown) => boolean; from: ((s: unknown) => boolean) | null; fair: unknown }[] }).liveness ?? [];
      for (const p of live) {
        const l = lowered.find((x) => x.name === p.name);
        if (!l) { out.push(`liveness.mjs has no predicate ${p.name}`); continue; }
        differ(`liveness.mjs ${p.name}.fair`, l.fair, (p.fair ?? []).map((g) => g.members.map((x) => ({ action: x.action, perValue: x.perValue }))));
        if ((l.from === null) !== (p.from === null)) out.push(`liveness.mjs ${p.name} has ${l.from ? 'a' : 'no'} start predicate, and the source ${p.from ? 'has' : 'has none'}`);
        for (const s of states) {
          const flat = flatten(s, M);
          const env = { M, state: s, data: {}, locals: new Map() };
          const pairs: [string, ((x: unknown) => boolean) | null, A.Expr | null][] = [['goal', l.goal, p.expr], ['from', l.from, p.from]];
          for (const [what, fn, e] of pairs) {
            if (!fn || !e) continue;
            let got: boolean | string;
            try { got = fn(flat) === true; } catch (err) { got = `a throw (${(err as Error).message})`; }
            const want = evaluate(e, env) === true;
            if (got !== want) { out.push(`liveness.mjs ${p.name}.${what} is ${got} on a reachable state, and PS5.5 gives ${want}`); break; }
          }
        }
      }
    }
  }
  return out;
}

/**
 * A sequence of emissions on which the lowered path property and PS5.4 disagree, or null. Every sequence of
 * up to four emissions over the property's kinds and one other kind is tried, which decides an order of two
 * kinds; each counted kind is repeated up to two past its bound, alone and beside each kind the machine can
 * emit; and every kind the machine can emit is tried alone and in pairs.
 */
function pathDisagreement(p: RPathProperty, pred: (path: unknown) => boolean, machineKinds: string[]): { kinds: string[]; lowered: boolean } | null {
  const kinds = [...new Set(p.clauses.flatMap((c) => (c.k === 'count' ? [c.kind] : [c.first, c.then]))), '__other'];
  const sequences: string[][] = [];
  let frontier: string[][] = [[]];
  for (let n = 0; n <= 4; n++) {
    sequences.push(...frontier);
    frontier = frontier.flatMap((s) => kinds.map((k) => [...s, k]));
  }
  for (const c of p.clauses) if (c.k === 'count') for (let n = 0; n <= c.max + 2; n++) sequences.push(Array(n).fill(c.kind));
  // Every kind the machine can emit, not one anonymous other kind, so a predicate that counts another real kind
  // or every emission is told apart (review C5): each alone and in pairs, and beside each counted run.
  const all = [...new Set([...kinds, ...machineKinds])];
  for (const a of all) { sequences.push([a]); for (const b of all) sequences.push([a, b]); }
  for (const c of p.clauses) {
    if (c.k !== 'count') continue;
    for (const o of all) for (let n = 0; n <= c.max + 2; n++) { sequences.push([o, ...Array(n).fill(c.kind)]); sequences.push([...Array(n).fill(c.kind), o]); }
  }
  {
    for (const seq of sequences) {
      let m = monitorStart(p);
      let holds = true;
      for (const k of seq) {
        const r = monitorStep(p, m, [k]);
        if (r.broken >= 0) holds = false;
        m = r.next;
      }
      const path = { emitted: seq.map((kind) => ({ kind, payload: {} })), count: (kind: string) => seq.filter((k) => k === kind).length };
      let lowered: boolean;
      try { lowered = pred(path) === true; } catch { lowered = false; }
      if (lowered !== holds) return { kinds: seq, lowered };
    }
  }
  return null;
}

/**
 * PT10h, S311: the declarations of types.d.ts after its first line, from poly-ref's model of the machine: the two
 * branded strings, the flat state of PS9.1b, every action with its parameters' declared types, each effect's and
 * decision's payload, and each kind's completions.
 */
export function hostDeclarations(M: RMachine, decl: A.Machine): string {
  const q = (s: string) => JSON.stringify(s);
  const names = (n: string) => M.unions.get(n)!.ctors.map((c) => q(c.name)).join(' | ');
  const ts = (t: RType): string => {
    switch (t.k) {
      case 'bool': return 'boolean';
      // S311: at most 64 values are written as literals.
      case 'int': return Number.isFinite(t.lo) && Number.isFinite(t.hi) && t.hi - t.lo < 64 ? Array.from({ length: t.hi - t.lo + 1 }, (_, i) => String(t.lo + i)).join(' | ') : 'number';
      case 'conf': return 'number';
      case 'string': return 'string';
      case 'ref': return 'string | null';
      case 'principal': return 'Principal | null';
      case 'content': return 'Content | null';
      case 'record': return `{ ${M.records.get(t.name)!.fields.map((f) => `${q(f.name)}: ${ts(f.type)}`).join('; ')} }`;
      case 'map': return t.key.k === 'int' ? `(${ts(t.value)})[]` : `{ ${M.unions.get((t.key as { name: string }).name)!.ctors.map((c) => `${q(c.name)}: ${ts(t.value)}`).join('; ')} }`;
      case 'union': {
        const u = M.unions.get(t.name)!;
        if (u.ctors.every((c) => !c.fields.length)) return names(t.name);
        return u.ctors.map((c) => `{ "$": ${q(c.name)}${c.fields.map((f) => `; ${q(f.name)}: ${ts(f.type)}`).join('')} }`).join(' | ');
      }
    }
  };
  const rec = (ps: { name: string; type: RType }[]) => (ps.length ? `{ ${ps.map((p) => `${q(p.name)}: ${ts(p.type)}`).join('; ')} }` : '{}');
  const lines = ['export type Content = string & { readonly __poly: "Content" };', 'export type Principal = string & { readonly __poly: "Principal" };', 'export interface State {'];
  for (const f of M.fields) {
    const u = f.type.k === 'union' ? M.unions.get(f.type.name)! : null;
    if (u && u.ctors.some((c) => c.fields.length)) {
      lines.push(`  ${q(f.name)}: ${names(u.name)};`);
      const seen = new Set<string>();
      for (const p of u.ctors.flatMap((c) => c.fields)) if (!seen.has(p.name)) { seen.add(p.name); lines.push(`  ${q(`${f.name}_${p.name}`)}: ${ts(p.type)} | null;`); }
      continue;
    }
    lines.push(`  ${q(f.name)}: ${ts(f.type)};`);
  }
  lines.push('}', 'export type Action =');
  if (!M.actions.length) lines.push('  never;');
  M.actions.forEach((a, i) => lines.push(`  | { action: ${q(a.name)}; data: ${rec(a.params)} }${i === M.actions.length - 1 ? ';' : ''}`));
  const outcomes = (items: unknown[]) => (items as A.EffOutcomeItem[]).filter((x) => x.kind === 'EffOutcome');
  const kinds: [string, { name: string; type: RType }[], A.EffOutcomeItem[]][] = [
    ...decl.items.filter((i): i is A.EffectDecl => i.kind === 'EffectDecl').map((e): [string, { name: string; type: RType }[], A.EffOutcomeItem[]] => [M.effects.get(e.name)!.kind, M.effects.get(e.name)!.params, outcomes(e.items)]),
    ...decl.items.filter((i): i is A.Decision => i.kind === 'Decision').map((d): [string, { name: string; type: RType }[], A.EffOutcomeItem[]] => [M.decisions.get(d.name)!.kind, M.decisions.get(d.name)!.params, outcomes(d.items)]),
  ];
  lines.push('export interface Effects {');
  for (const [k, ps] of kinds) lines.push(`  ${q(k)}: ${rec(ps)};`);
  lines.push('}', 'export interface Completions {');
  for (const [k, , outs] of kinds) {
    const order = ['ok', 'failed', 'exhausted'];
    const listed = order.flatMap((o) => outs.filter((x) => x.outcome === o)).map((x) => `${q(x.outcome)}: Extract<Action, { action: ${q(x.action)} }>["data"]`);
    lines.push(`  ${q(k)}: ${listed.length ? `{ ${listed.join('; ')} }` : '{}'};`);
  }
  lines.push('}', '');
  return lines.join('\n');
}

/** A decision's result type as poly-ref reads types (PD1.2a). */
function resultType(t: A.TypeExpr, M: RMachine): RType {
  switch (t.kind) {
    case 'TRange': return { k: 'int', lo: t.lo, hi: t.hi };
    case 'TBool': return { k: 'bool' };
    case 'TName': return M.records.has(t.name) ? { k: 'record', name: t.name } : { k: 'union', name: t.name };
    default: throw new Error(`poly-ref: a decision's result is finite, not ${t.kind} (PD1.2a)`);
  }
}
