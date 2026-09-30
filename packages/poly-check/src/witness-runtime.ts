// The walker behind every exported witness test (PT12.4, S68, S74).
//
// Until PT15's runtime API exists (M4), a witness is walked through the lowered artefacts the engines run:
// the SAM module (next.cjs), the effects mapper, and the property modules the engines read (invariants.mjs,
// effect-invariants.mjs, liveness.mjs). A configuration's instances are walked by a small harness that
// delivers the witness's messages between the lowered modules, since polyrun has no sendTo yet (S58); its
// properties, which have no engine artefact, are evaluated by poly-ref over the instances' states.
//
// The rules, the same for every kind:
//   - the build must be the build of the source as it is now (its machineVersion is the source's module
//     digest), or the test refuses to run: a stale build cannot make it pass (S68);
//   - a step whose verdict differs from the witness's ends the walk, and the test passes: the program no
//     longer takes that path;
//   - after each step, the violated predicate is asserted; the test fails while the defect is there.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from '@poly/lang';
import { digest, type Configuration, type Machine, type Module } from '@poly/core';
import { alpha, buildConfiguration, buildMachine, detachedAlone, evaluate, flatten, flatValue, globalView, isTerminal, loadLoweredModule, valuesOf, type RMachine, type State } from '@poly/ref';

export interface WitnessStepSpec {
  action: string;
  data: Record<string, unknown>;
  verdict: string;
  global?: { kind: 'input' | 'deliver'; instance: string; text: string };
}

export interface WitnessSpec {
  id: string;
  code: string;
  property: string | null;
  source: string;
  buildRoot: string;
  module: string;
  machine: string | null;
  configuration: string | null;
  member: number | null;
  cycle: number | null;
  steps: WitnessStepSpec[];
}

type Flat = Record<string, unknown>;
interface SamModule {
  instance: (o: object) => { lastStep: () => { classification: string; rejections: { reason?: string }[] } };
  init: () => void;
  setState: (s: object) => void;
  getState: () => Flat;
  actions: Record<string, (d: object) => unknown>;
}
interface Lowered {
  mod: SamModule;
  contract: { machineVersion: string; stateKeys: { name: string }[]; initState: Flat; terminalStates: unknown[]; actions: Record<string, unknown>; dataDomain?: Record<string, Record<string, unknown[]>> };
  mapper: ((pre: Flat, a: string, d: Flat, post: Flat, k: string) => { kind: string; target?: unknown; action?: string; data?: Flat }[]) | null;
  dir: string;
}

const stable = (v: unknown): string => (v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(stable).join(',')}]` : `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`);
const clone = <T>(x: T): T => structuredClone(x);

/** Loads one machine's build and refuses it unless it is the build of the source as it is now (S68). */
function load(root: string, module: string, machine: string, moduleDigest: string): Lowered {
  const dir = join(root, '.poly', 'build', `${module}.${machine}`);
  const contractPath = join(dir, 'contract.json');
  if (!existsSync(contractPath)) throw new Error(`no build of ${module}.${machine} under ${root}: run poly check first`);
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  if (contract.machineVersion !== moduleDigest) throw new Error(`stale build of ${module}.${machine}: it was built from ${contract.machineVersion}, and the source is now ${moduleDigest}; run poly check first`);
  const mapperPath = join(dir, 'effects.cjs');
  const mapper = existsSync(mapperPath) ? loadLoweredModule<{ effects: Lowered['mapper'] }>(mapperPath).effects : null;
  return { mod: loadLoweredModule<SamModule>(join(dir, 'next.cjs')), contract, mapper, dir };
}

const esm = async (dir: string, file: string) => (existsSync(join(dir, file)) ? await import(pathToFileURL(join(dir, file)).href + `?v=${Date.now()}-${Math.random()}`) : {});

/** One step of R_L (PS9.1a): the runtime's terminal row, an action outside the module, then the module. */
/** S78: the kernel's commit: every detached child's marker becomes that child's address. */
function commit<T>(v: T, address: (key: string) => string): T {
  if (Array.isArray(v)) return v.map((x) => commit(x, address)) as T;
  if (v === null || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  if (o.$ref === 'child' && typeof o.key === 'string') return address(o.key) as T;
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, commit(x, address)])) as T;
}

function step(l: Lowered, pre: Flat, action: string, data: Flat): { verdict: string; post: Flat } {
  if (l.contract.terminalStates.includes(pre[l.contract.stateKeys[0].name])) return { verdict: 'rejected(terminal)', post: pre };
  if (typeof l.mod.actions[action] !== 'function' || !Object.hasOwn(l.mod.actions, action)) return { verdict: 'unhandled', post: pre };
  l.mod.init();
  l.mod.setState(clone(pre));
  l.mod.actions[action](clone(data));
  const ls = l.mod.instance({}).lastStep();
  const post = l.mod.getState();
  if (ls.classification === 'rejected') return { verdict: `rejected(${ls.rejections[0]?.reason})`, post: pre };
  if (ls.classification === 'unhandled') return { verdict: 'unhandled', post: pre };
  return { verdict: 'accepted', post };
}

/** Every (action, data) of the module's contract: what the environment may offer (PS4.1). */
function offers(l: Lowered): { action: string; data: Flat }[] {
  const out: { action: string; data: Flat }[] = [];
  for (const a of Object.keys(l.contract.actions)) {
    let recs: Flat[] = [{}];
    for (const [p, vs] of Object.entries(l.contract.dataDomain?.[a] ?? {})) recs = recs.flatMap((r) => vs.map((v) => ({ ...r, [p]: v })));
    for (const d of recs) out.push({ action: a, data: d });
  }
  return out;
}

export async function runWitness(spec: WitnessSpec): Promise<void> {
  const parsed = parse(readFileSync(spec.source, 'utf8'));
  if (!parsed.module) throw new Error(`${spec.source} does not parse: ${parsed.diagnostics.map((d) => d.message).join('; ')}`);
  const moduleDigest = digest(parsed.module);
  if (spec.configuration) return walkConfiguration(spec, parsed.module, moduleDigest);
  return walkMachine(spec, parsed.module, moduleDigest);
}

async function walkMachine(spec: WitnessSpec, module: Module, moduleDigest: string): Promise<void> {
  const decl = module.decls.find((d): d is Machine => d.kind === 'Machine' && d.name === spec.machine);
  if (!decl) return; // the machine is gone, and its defect with it
  const l = load(spec.buildRoot, spec.module, spec.machine!, moduleDigest);
  const props = await esm(l.dir, 'invariants.mjs');
  const paths = await esm(l.dir, 'effect-invariants.mjs');
  const live = await esm(l.dir, 'liveness.mjs');
  const named = <T extends { name: string }>(list: T[] | undefined) => list?.find((x) => x.name === spec.property);
  let state: Flat = clone(l.contract.initState);
  // S78: alone, a detached child's address is the key's own symbolic address (PS1.6).
  const R = decl.items.some((i) => i.kind === 'Handler') ? buildMachine(module, decl.name) : null;
  const alone = (key: string) => detachedAlone(R!, key);
  const emitted: { kind: string; payload: unknown }[] = [];
  const visited: Flat[] = [];
  const cycleSteps: { action: string; data: Flat; verdict: string }[] = [];
  let cycleStart: Flat | null = null;
  const liveness = spec.code === 'PL3301' ? named(live.liveness as { name: string; goal: (s: Flat) => boolean; fair: { action: string; perValue: boolean }[][] }[]) : undefined;
  for (const [i, s] of spec.steps.entries()) {
    if (liveness && i === spec.cycle) cycleStart = clone(state);
    if (liveness && cycleStart && liveness.goal(state)) return; // the goal now holds on the cycle
    if (cycleStart) visited.push(clone(state));
    const pre = state;
    const r = step(l, pre, s.action, s.data);
    if (r.verdict !== s.verdict) return; // the program no longer takes this path
    const v = r.verdict.startsWith('rejected') ? { rejected: true, reason: r.verdict.slice(9, -1) } : { rejected: false, reason: null };
    if (spec.code === 'PL3003') {
      const p = named(props.rejectionInvariants as { name: string; pred: (s: Flat, a: string, d: Flat, v: object) => boolean }[]);
      assert.ok(p?.pred(pre, s.action, s.data, v) !== false, `reject property ${spec.property} is violated at step ${i + 1}, ${s.action}`);
    }
    if (cycleStart) cycleSteps.push({ action: s.action, data: s.data, verdict: r.verdict });
    state = commit(r.post, alone);
    if (r.verdict !== 'accepted') continue;
    const intents = commit(l.mapper ? l.mapper(clone(pre), s.action, clone(s.data), clone(r.post), 'accepted') ?? [] : [], alone);
    if (spec.code === 'PL3001') {
      const p = named(props.stateInvariants as { name: string; pred: (s: Flat) => boolean }[]);
      assert.ok(!p || p.pred(state), `invariant ${spec.property} is violated after step ${i + 1}, ${s.action}`);
    }
    if (spec.code === 'PL3102' || spec.code === 'PL3901') {
      for (const inv of (props.stateInvariants ?? []) as { name: string; pred: (s: Flat) => boolean }[]) {
        if (/^(domain|shape|bound):/.test(inv.name)) assert.ok(inv.pred(state), `${inv.name} is violated after step ${i + 1}, ${s.action}`);
      }
    }
    if (spec.code === 'PL3002') {
      const p = named(props.transitionInvariants as { name: string; pred: (pre: Flat, a: string, d: Flat, post: Flat, v: object) => boolean }[]);
      assert.ok(!p || p.pred(pre, s.action, s.data, state, v), `step property ${spec.property} is violated by step ${i + 1}, ${s.action}`);
    }
    if (spec.code === 'PL4001') {
      for (const x of intents) emitted.push({ kind: x.kind, payload: x.data ?? {} });
      const p = named(paths.effectInvariants as { name: string; pred: (p: object) => boolean }[]);
      const path = { emitted, count: (k: string) => emitted.filter((e) => e.kind === k).length };
      assert.ok(!p || p.pred(path), `path property ${spec.property} is violated by step ${i + 1}, ${s.action}`);
    }
    if (spec.code === 'PL4002') {
      // S33, S63: an accepted step that emits an effect, a timer or a child intent and changes nothing.
      assert.ok(!(stable(pre) === stable(state) && intents.some((x) => x.kind !== 'sendTo')), `${s.action} emits and leaves the state unchanged at step ${i + 1}`);
    }
  }
  if (spec.code === 'PL3201') {
    // PS5.6: the state the witness reaches is terminal, or some action accepts there.
    const terminal = l.contract.terminalStates.includes(state[l.contract.stateKeys[0].name]);
    assert.ok(terminal || offers(l).some((o) => step(l, state, o.action, o.data).verdict === 'accepted'), 'the state the witness reaches is a deadlock: not terminal, and no action accepts');
  }
  if (liveness && cycleStart) {
    // S74: the cycle returns to its first state, the goal never holds on it, and every fair group is taken on it
    // or disabled somewhere on it. Anything else and the lasso is no longer a fair counterexample.
    if (stable(state) !== stable(cycleStart)) return;
    const all = offers(l);
    for (const grp of liveness.fair) {
      const plain = grp.filter((m) => !m.perValue).map((m) => m.action);
      const groups: ((a: string, d: Flat) => boolean)[] = grp.some((m) => m.perValue)
        ? grp.filter((m) => m.perValue).flatMap((m) => all.filter((o) => o.action === m.action).map((o) => (a: string, d: Flat) => plain.includes(a) || (a === m.action && stable(d) === stable(o.data))))
        : [(a: string) => plain.includes(a)];
      for (const inGroup of groups) {
        const taken = cycleSteps.some((c) => c.verdict === 'accepted' && inGroup(c.action, c.data));
        const disabled = visited.some((st) => !all.some((o) => inGroup(o.action, o.data) && step(l, st, o.action, o.data).verdict === 'accepted'));
        if (!taken && !disabled) return; // a fair group is enabled throughout and never taken: the cycle is unfair
      }
    }
    assert.fail(`liveness ${spec.property} fails: the fair cycle of the witness still never reaches its goal`);
  }
}

/** A configuration: one lowered module per machine, one flat state per instance, messages as a multiset (PS13.2a). */
async function walkConfiguration(spec: WitnessSpec, module: Module, moduleDigest: string): Promise<void> {
  const decl = module.decls.find((d): d is Configuration => d.kind === 'Configuration' && d.name === spec.configuration);
  if (!decl) return;
  const { instances, groups } = buildConfiguration(module, decl.name);
  const lowered = new Map<string, Lowered>();
  for (const i of instances) if (!lowered.has(i.machine.name)) lowered.set(i.machine.name, load(spec.buildRoot, spec.module, i.machine.name, moduleDigest));
  const byName = new Map(instances.map((x) => [x.name, x]));
  // S60: an instance a detached spawn creates has no state until then.
  let sigma = new Map(instances.filter((x) => !x.spawned).map((x) => [x.name, flatten(x.init, x.machine)]));
  let mu: { target: string; action: string; data: Flat; creation?: boolean }[] = [];
  const machines = new Map<string, RMachine>(instances.map((x) => [x.machine.name, x.machine]));
  const initial = globalView(instances, instances.map((x) => (x.spawned ? null : x.init)), null, groups);
  const view = (sg: Map<string, Flat>) => globalView(instances, instances.map((x) => (sg.has(x.name) ? alpha(sg.get(x.name)!, x.machine) : null)), initial, groups);
  const holds = (e: import('@poly/core').Expr, sg: Map<string, Flat>) => {
    const locals = new Map<string, import('@poly/ref').Value>();
    const p = decl.properties.find((x) => x.name === spec.property);
    if (p?.kind === 'Liveness' && p.quant && spec.member !== null) locals.set(p.quant.var, spec.member);
    return evaluate(e, { M: instances[0].machine, state: {}, data: {}, locals, global: view(sg) }) === true;
  };
  const prop = decl.properties.find((x) => x.name === spec.property);
  const visited: { sigma: Map<string, Flat>; mu: typeof mu }[] = [];
  const cycleSteps: { kind: string; target: string; action: string; data: Flat; verdict: string }[] = [];
  let start: string | null = null;
  const key = (sg: Map<string, Flat>, m: typeof mu) => stable([[...sg].sort(), m.map((x) => stable(x)).sort()]);
  for (const [i, s] of spec.steps.entries()) {
    const g = s.global!;
    if (prop?.kind === 'Liveness' && i === spec.cycle) start = key(sigma, mu);
    if (prop?.kind === 'Liveness' && start !== null) {
      if (holds(prop.expr, sigma)) return;
      visited.push({ sigma: new Map(sigma), mu: [...mu] });
    }
    const inst = byName.get(g.instance)!;
    const l = lowered.get(inst.machine.name)!;
    if (!sigma.has(g.instance)) return; // that instance is no longer created
    if (g.kind === 'deliver') {
      const at = mu.findIndex((m) => m.target === g.instance && m.action === s.action && stable(m.data) === stable(s.data));
      if (at < 0) return; // that message is no longer sent
      // S60: while a child's creation message waits, nothing else is delivered to it.
      if (!mu[at].creation && mu.some((m) => m.creation && m.target === g.instance)) return;
      mu = [...mu.slice(0, at), ...mu.slice(at + 1)];
    }
    const pre = sigma.get(g.instance)!;
    const r = step(l, pre, s.action, s.data);
    if (r.verdict !== s.verdict) return;
    if (start !== null) cycleSteps.push({ kind: g.kind, target: g.instance, action: s.action, data: s.data, verdict: r.verdict });
    let toNone = false;
    if (r.verdict === 'accepted') {
      // S78: the commit resolves a detached child's marker to <sender>/<k>, in the state and in the intents.
      const child = (k: string) => `${g.instance}/${k}`;
      sigma = new Map(sigma).set(g.instance, commit(r.post, child));
      for (const x of commit(l.mapper ? l.mapper(clone(pre), s.action, clone(s.data), clone(r.post), 'accepted') ?? [] : [], child)) {
        if (x.kind === 'createInstance') {
          // S60: the child starts in its machine's initial state, with its creation action as its first message.
          const address = child((x as { childKey?: string }).childKey!);
          const made = byName.get(address);
          if (!made || sigma.has(address)) return; // outside the bound, or a second spawn of the key: the check reported it
          sigma.set(address, flatten(made.init, made.machine));
          const creation = (x as { creation?: { action: string; data: Flat } }).creation;
          if (creation) mu.push({ target: address, action: creation.action, data: creation.data, creation: true });
          continue;
        }
        if (x.kind !== 'sendTo') continue;
        if (x.target === null) { toNone = true; continue; }
        // S58: the kernel's self marker is the sender's address.
        const data = Object.fromEntries(Object.entries(x.data ?? {}).map(([k, v]) => [k, stable(v) === stable({ $ref: 'self' }) ? g.instance : v]));
        mu.push({ target: x.target as string, action: x.action!, data });
      }
    }
    if (spec.code === 'PL5401' && prop?.kind === 'Property') assert.ok(holds(prop.expr, sigma), `configuration invariant ${spec.property} is violated after step ${i + 1}, ${g.text}`);
    if (spec.code === 'PL5404') assert.ok(!toNone, `step ${i + 1}, ${g.text}, sends to none`);
  }
  if (spec.code === 'PL5402' && mu.length === 0) {
    // PS13.6: quiescent (no message, no input accepted) with a non-service instance not terminal.
    const accepted = decl.inputs.some((r) => {
      const names = r.index === null ? [r.instance] : r.index === '*' ? instances.filter((x) => x.group === r.instance).map((x) => x.name) : [`${r.instance}[${r.index}]`];
      return names.filter((n) => sigma.has(n)).some((n) => {
        const inst = byName.get(n)!;
        const a = inst.machine.actions.find((x) => x.name === r.action)!;
        let recs: Flat[] = [{}];
        for (const p of a.params) {
          const vs = p.check ?? (p.type.k === 'ref' ? [null, ...instances.filter((x) => x.machine.name === (p.type as { machine: string }).machine).map((x) => x.name)] : valuesOf(p.type, inst.machine));
          recs = recs.flatMap((rec) => vs.map((v) => ({ ...rec, [p.name]: flatValue(v, p.type, inst.machine) })));
        }
        return recs.some((d) => step(lowered.get(inst.machine.name)!, sigma.get(n)!, r.action, d).verdict === 'accepted');
      });
    });
    const waiting = instances.filter((x) => sigma.has(x.name) && !x.machine.service && !isTerminal(x.machine, alpha(sigma.get(x.name)!, x.machine)));
    assert.ok(accepted || waiting.length === 0, `the configuration is stuck: ${waiting.map((x) => x.name).join(', ')} not terminal, nothing in transit, no input accepted`);
  }
  if (prop?.kind === 'Liveness' && start !== null) {
    if (key(sigma, mu) !== start) return;
    // Delivery is fair per message value (PS13.2b): each value in transit on the cycle is delivered on it, or absent somewhere.
    const plainMsg = (m: typeof mu[number]) => stable({ target: m.target, action: m.action, data: m.data });
    const values = new Set(visited.flatMap((v) => v.mu.map(plainMsg)));
    for (const m of values) {
      const taken = cycleSteps.some((c) => c.kind === 'deliver' && stable({ target: c.target, action: c.action, data: c.data }) === m);
      const absent = visited.some((v) => !v.mu.some((x) => plainMsg(x) === m));
      if (!taken && !absent) return;
    }
    void machines;
    assert.fail(`liveness ${spec.property} fails: the fair cycle of the witness still never reaches its goal`);
  }
}

export type { State };
