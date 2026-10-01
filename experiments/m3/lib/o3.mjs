// O3 and O2 over the host interface (PT13, S91, S92).
//
// O3 is a set of traces of host calls, each step with the result and the observations expected after it. It
// is generated from a version's reference by exploring its host interface through the adapter: breadth first
// from a fresh host, every call of the version's explore.json, every distinct message in transit, and every
// distinct pending effect completed ok and failed (S95), is tried from every observed state, and each tried step becomes one trace, the shortest path to its source followed
// by it. So every observed state is reached by a shortest path, and every step from it is taken. A state is
// what the interface shows (the results of the observing queries, the messages in transit and the effects pending) together with
// the reference's own state, so that hidden state does not merge two states the traces must both reach.
//
// Only what every arm shares is compared: the host calls and their results (a command's { ok } alone, since
// the reason is the arm's wording), the queries' results, messages by sender, receiver, action and data, which
// the brief of a multi-machine task names, and effects by requester, kind and data, which the brief of a task
// with effects names (S94, S95). O2 is a list of predicates over the same observations,
// checked after every step of every trace.
const stable = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(stable).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`);
export { stable };

/** A call's result as O3 compares it: a verdict as { ok } alone, anything else as JSON. */
export function normalize(r) {
  if (r === undefined) return null;
  if (r && typeof r === 'object' && typeof r.ok === 'boolean') return { ok: r.ok };
  return JSON.parse(JSON.stringify(r));
}

/** The observations: each query of the spec with each of its argument lists. */
export async function observe(host, spec) {
  const out = {};
  for (const [q, argLists] of Object.entries(spec.observe)) {
    out[q] = {};
    for (const args of argLists) out[q][stable(args)] = normalize(await host[q](...args));
  }
  return out;
}

/** What is outstanding, as O3 names it, without ids and sorted: the messages in transit, and the effects pending as { effect, from, data }. */
export async function transit(host, spec) {
  const out = [];
  if (spec.network) out.push(...(await host.inFlight()).map((m) => ({ from: m.from, to: m.to, action: m.action, data: m.data })));
  if (spec.effects) out.push(...(await host.pendingEffects()).map((e) => ({ effect: e.kind, from: e.from, data: e.data })));
  return out.sort((a, b) => (stable(a) < stable(b) ? -1 : stable(a) > stable(b) ? 1 : 0));
}

export class Diverged extends Error {}

/** Takes one step: a host call, the delivery of a message in transit, or the completion of a pending effect. */
export async function take(host, step) {
  if (step.call) return normalize(await host[step.call](...step.args));
  if (step.complete) {
    const want = stable(step.complete);
    const e = (await host.pendingEffects()).find((x) => stable({ effect: x.kind, from: x.from, data: x.data }) === want);
    if (!e) throw new Diverged(`no pending effect matches ${want}`);
    await host.completeEffect(e.id, step.outcome);
    return null;
  }
  const want = stable(step.deliver);
  const m = (await host.inFlight()).find((x) => stable({ from: x.from, to: x.to, action: x.action, data: x.data }) === want);
  if (!m) throw new Diverged(`no message in transit matches ${want}`);
  await host.deliver(m.id);
  return null;
}

const describe = (step) => (step.call ? `${step.call}(${step.args.map((a) => JSON.stringify(a)).join(', ')})` : step.complete ? `complete ${step.complete.effect} of ${step.complete.from} ${stable(step.complete.data)} ${step.outcome}` : `deliver ${step.deliver.action} ${step.deliver.from} -> ${step.deliver.to} ${stable(step.deliver.data)}`);

/**
 * Explores a reference through its host (see above). `spec` is explore.json: { calls, observe, network,
 * maxDepth, maxTraces, transitions }. The result says whether the exploration was bounded; it is never cut silently.
 */
export async function explore(createHost, spec) {
  // The reference's own state joins the key where the adapter gives it, so two states the interface shows alike
  // are both explored; the traces still hold only host calls and what the interface shows.
  const keyOf = async (h) => stable([await observe(h, spec), await transit(h, spec), (await h.__state?.()) ?? null]);
  const h = await createHost();
  if (!h.__snapshot || !h.__restore) throw new Error('explore needs a host with __snapshot and __restore (the generated adapter)');
  try {
    const initial = { observe: await observe(h, spec), transit: await transit(h, spec) };
    const seen = new Set([await keyOf(h)]);
    const traces = [];
    // A frontier entry is a state to expand: its snapshot, and the steps (with their expectations) that reach it.
    let frontier = [{ snap: await h.__snapshot(), steps: [] }];
    let depth = 0;
    let bounded = false;
    while (frontier.length) {
      if (depth >= spec.maxDepth) { bounded = true; break; }
      const next = [];
      for (const node of frontier) {
        await h.__restore(node.snap);
        const steps = [
          ...Object.entries(spec.calls).flatMap(([call, argLists]) => argLists.map((args) => ({ call, args }))),
          ...[...new Map((await transit(h, spec)).map((m) => [stable(m), m])).values()].flatMap((m) => ('effect' in m ? [{ complete: m, outcome: 'ok' }, { complete: m, outcome: 'failed' }] : [{ deliver: m }])),
        ];
        for (const step of steps) {
          if (traces.length >= spec.maxTraces) { bounded = true; break; }
          await h.__restore(node.snap);
          const result = await take(h, step);
          const done = { ...step, text: describe(step), result, observe: await observe(h, spec), transit: await transit(h, spec) };
          const key = await keyOf(h);
          // With transitions false (a task whose every transition would be too many traces to score), a trace is
          // kept only for the step that first reaches a state: every state is still reached by a shortest path.
          const fresh = !seen.has(key);
          if (fresh || spec.transitions !== false) traces.push({ initial, steps: [...node.steps, done] });
          if (fresh) { seen.add(key); next.push({ snap: await h.__snapshot(), steps: [...node.steps, done] }); }
        }
        if (traces.length >= spec.maxTraces) break;
      }
      frontier = next;
      depth++;
    }
    return { states: seen.size, traces, bounded };
  } finally {
    h.__dispose?.();
  }
}

/**
 * O3 as written: every trace is a path to an explored state and one step, so the traces share their prefixes.
 * They are stored as a tree of steps, each node with its expected result and the index of its expected
 * observations in a table of observed states, and a trace is the path to one node.
 */
export function pack(traces) {
  const nodes = [];
  const index = new Map();
  const states = [];
  const stateIndex = new Map();
  const stateOf = (observe, transit) => {
    const k = stable([observe, transit]);
    if (!stateIndex.has(k)) { stateIndex.set(k, states.length); states.push({ observe, transit }); }
    return stateIndex.get(k);
  };
  const ends = [];
  for (const t of traces) {
    let parent = -1;
    for (const { observe, transit, ...s } of t.steps) {
      const key = `${parent}|${stable({ call: s.call, args: s.args, deliver: s.deliver, complete: s.complete, outcome: s.outcome })}`;
      if (!index.has(key)) { index.set(key, nodes.length); nodes.push({ parent, ...s, state: stateOf(observe, transit) }); }
      parent = index.get(key);
    }
    ends.push(parent);
  }
  return { initial: traces[0]?.initial ?? null, observed: states, nodes, traces: ends };
}

/** The traces of a packed O3. */
export function unpack(o3) {
  return o3.traces.map((end) => {
    const steps = [];
    for (let k = end; k !== -1; k = o3.nodes[k].parent) { const { parent, state, ...s } = o3.nodes[k]; steps.unshift({ ...s, ...o3.observed[state] }); }
    return { initial: o3.initial, steps };
  });
}

/**
 * Replays O3 on an implementation and checks O2 after every step. Returns every disagreement: a result or an
 * observation that differs, a step that cannot be taken, or an O2 predicate that fails.
 */
export async function replay(createHost, o3, o2, spec) {
  if (o3.nodes) {
    const probe = await createHost();
    const fast = typeof probe.__snapshot === 'function' && typeof probe.__restore === 'function';
    probe.__dispose?.();
    if (fast) return replayTree(createHost, o3, o2, spec);
  }
  return replayEach(createHost, o3, o2, spec);
}

/**
 * The same replay for a host that can snapshot itself (the generated adapter): the trace tree is walked once,
 * each node's step taken from its parent's snapshot, so a shared prefix is replayed once. A failure at a node is
 * the failure of every trace that passes through it, as replaying each trace from a fresh host would find; the
 * controls compare the two on the reference (test/m3-tasks.test.mjs).
 */
async function replayTree(createHost, o3, o2, spec) {
  const failures = [];
  const children = o3.nodes.map(() => []);
  const roots = [];
  o3.nodes.forEach((n, k) => (n.parent === -1 ? roots : children[n.parent]).push(k));
  const endsAt = new Map();
  o3.traces.forEach((end, i) => { if (!endsAt.has(end)) endsAt.set(end, []); endsAt.get(end).push(i); });
  const tracesUnder = (k) => { const out = []; const stack = [k]; while (stack.length) { const x = stack.pop(); out.push(...(endsAt.get(x) ?? [])); stack.push(...children[x]); } return out; };
  const h = await createHost();
  try {
    const obs0 = await observe(h, spec);
    if (stable(obs0) !== stable(o3.initial.observe)) {
      o3.traces.forEach((_, i) => failures.push({ kind: 'o3', trace: i, step: 0, what: 'initial observations', expected: o3.initial.observe, actual: obs0 }));
      return { traces: o3.traces.length, failures };
    }
    const tr0 = await transit(h, spec);
    for (const p of o2) { let ok = false; try { ok = p.holds(obs0, tr0) === true; } catch { ok = false; } if (!ok) o3.traces.forEach((_, i) => failures.push({ kind: 'o2', property: p.name, where: `trace ${i}, initial` })); }
    const fail = (k, f) => { for (const i of tracesUnder(k)) failures.push({ kind: 'o3', trace: i, ...f }); };
    // An O2 failure along a prefix is a failure of every trace through it: record it once per trace below.
    const walk = async (k, snap, depth) => {
      const n = o3.nodes[k];
      const s = { ...n, ...o3.observed[n.state] };
      await h.__restore(snap);
      let result;
      try { result = await take(h, s); } catch (e) { fail(k, { step: depth, what: e instanceof Diverged ? e.message : `threw: ${e.message}` }); return; }
      const obs = await observe(h, spec);
      const tr = await transit(h, spec);
      for (const p of o2) {
        let ok = false;
        try { ok = p.holds(obs, tr) === true; } catch { ok = false; }
        if (!ok) for (const i of tracesUnder(k)) failures.push({ kind: 'o2', property: p.name, where: `trace ${i}, step ${depth} (${s.text})` });
      }
      if (stable(result) !== stable(s.result)) { fail(k, { step: depth, what: `the result of ${s.text}`, expected: s.result, actual: result }); return; }
      if (stable(obs) !== stable(s.observe)) { fail(k, { step: depth, what: `the observations after ${s.text}`, expected: s.observe, actual: obs }); return; }
      if (stable(tr) !== stable(s.transit)) { fail(k, { step: depth, what: `the messages in transit and effects pending after ${s.text}`, expected: s.transit, actual: tr }); return; }
      if (!children[k].length) return;
      const mine = await h.__snapshot();
      for (const c of children[k]) await walk(c, mine, depth + 1);
    };
    const start = await h.__snapshot();
    for (const r of roots) await walk(r, start, 1);
  } finally {
    h.__dispose?.();
  }
  return { traces: o3.traces.length, failures };
}

/** Replays every trace from a fresh host: for an implementation that cannot snapshot itself. */
export async function replayEach(createHost, o3, o2, spec) {
  const failures = [];
  const holdsAll = (obs, transitNow, where) => {
    for (const p of o2) {
      let ok = false;
      try { ok = p.holds(obs, transitNow) === true; } catch (e) { ok = false; }
      if (!ok) failures.push({ kind: 'o2', property: p.name, where });
    }
  };
  const traces = o3.nodes ? unpack(o3) : o3.traces;
  for (const [i, trace] of traces.entries()) {
    let h;
    try {
      h = await createHost();
      let obs = await observe(h, spec);
      if (stable(obs) !== stable(trace.initial.observe)) { failures.push({ kind: 'o3', trace: i, step: 0, what: 'initial observations', expected: trace.initial.observe, actual: obs }); continue; }
      holdsAll(obs, await transit(h, spec), `trace ${i}, initial`);
      for (const [k, s] of trace.steps.entries()) {
        const where = `trace ${i}, step ${k + 1} (${s.text})`;
        const result = await take(h, s);
        obs = await observe(h, spec);
        const tr = await transit(h, spec);
        holdsAll(obs, tr, where);
        if (stable(result) !== stable(s.result)) { failures.push({ kind: 'o3', trace: i, step: k + 1, what: `the result of ${s.text}`, expected: s.result, actual: result }); break; }
        if (stable(obs) !== stable(s.observe)) { failures.push({ kind: 'o3', trace: i, step: k + 1, what: `the observations after ${s.text}`, expected: s.observe, actual: obs }); break; }
        if (stable(tr) !== stable(s.transit)) { failures.push({ kind: 'o3', trace: i, step: k + 1, what: `the messages in transit and effects pending after ${s.text}`, expected: s.transit, actual: tr }); break; }
      }
    } catch (e) {
      failures.push({ kind: 'o3', trace: i, what: e instanceof Diverged ? e.message : `threw: ${e.message}` });
    } finally {
      h?.__dispose?.();
    }
  }
  return { traces: traces.length, failures };
}
