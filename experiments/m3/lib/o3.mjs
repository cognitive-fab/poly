// O3 and O2 over the host interface (PT13, S91, S92).
//
// O3 is a set of traces of host calls, each step with the result and the observations expected after it. It
// is generated from a version's reference by exploring its host interface through the adapter: breadth first
// from a fresh host, every call of the version's explore.json and every distinct message in transit is tried
// from every observed state, and each tried step becomes one trace, the shortest path to its source followed
// by it. So every observed state is reached by a shortest path, and every step from it is taken. A state is
// what the interface shows: the results of the observing queries, and the messages in transit.
//
// Only what every arm shares is compared: the host calls and their results (a command's { ok } alone, since
// the reason is the arm's wording), the queries' results, and messages by sender, receiver, action and data,
// which the brief of a multi-machine task names. O2 is a list of predicates over the same observations,
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

/** The messages in transit as O3 names them: without ids, sorted. */
export async function transit(host, spec) {
  if (!spec.network) return [];
  return (await host.inFlight()).map((m) => ({ from: m.from, to: m.to, action: m.action, data: m.data })).sort((a, b) => (stable(a) < stable(b) ? -1 : stable(a) > stable(b) ? 1 : 0));
}

export class Diverged extends Error {}

/** Takes one step: a host call, or the delivery of a message in transit that matches it. */
export async function take(host, step) {
  if (step.call) return normalize(await host[step.call](...step.args));
  const want = stable(step.deliver);
  const m = (await host.inFlight()).find((x) => stable({ from: x.from, to: x.to, action: x.action, data: x.data }) === want);
  if (!m) throw new Diverged(`no message in transit matches ${want}`);
  await host.deliver(m.id);
  return null;
}

const describe = (step) => (step.call ? `${step.call}(${step.args.map((a) => JSON.stringify(a)).join(', ')})` : `deliver ${step.deliver.action} ${step.deliver.from} -> ${step.deliver.to} ${stable(step.deliver.data)}`);

/**
 * Explores a reference through its host (see above). `spec` is explore.json: { calls, observe, network,
 * maxDepth, maxTraces }. The result says whether the exploration was bounded; it is never cut silently.
 */
export async function explore(createHost, spec) {
  const run = async (path) => {
    const h = await createHost();
    try {
      for (const s of path) await take(h, s);
      return h;
    } catch (e) { h.close?.(); throw e; }
  };
  const keyOf = async (h) => stable([await observe(h, spec), await transit(h, spec)]);
  const seen = new Set();
  const traces = [];
  let frontier = [[]];
  { const h = await run([]); seen.add(await keyOf(h)); h.close?.(); }
  let depth = 0;
  let bounded = false;
  while (frontier.length) {
    if (depth >= spec.maxDepth) { bounded = true; break; }
    const next = [];
    for (const path of frontier) {
      const h = await run(path);
      const steps = [
        ...Object.entries(spec.calls).flatMap(([call, argLists]) => argLists.map((args) => ({ call, args }))),
        ...[...new Map((await transit(h, spec)).map((m) => [stable(m), m])).values()].map((m) => ({ deliver: m })),
      ];
      h.close?.();
      for (const step of steps) {
        if (traces.length >= spec.maxTraces) { bounded = true; break; }
        const t = await run([]);
        const trace = { steps: [], initial: { observe: await observe(t, spec), transit: await transit(t, spec) } };
        for (const s of [...path, step]) {
          const result = await take(t, s);
          trace.steps.push({ ...s, text: describe(s), result, observe: await observe(t, spec), transit: await transit(t, spec) });
        }
        const key = await keyOf(t);
        t.close?.();
        traces.push(trace);
        if (!seen.has(key)) { seen.add(key); next.push([...path, step]); }
      }
      if (traces.length >= spec.maxTraces) break;
    }
    frontier = next;
    depth++;
  }
  return { states: seen.size, traces, bounded };
}

/**
 * O3 as written: every trace is a path to an explored state and one step, so the traces share their prefixes.
 * They are stored as a tree of steps, each node with its expectations, and a trace is the path to one node.
 */
export function pack(traces) {
  const nodes = [];
  const index = new Map();
  const ends = [];
  for (const t of traces) {
    let parent = -1;
    for (const s of t.steps) {
      const key = `${parent}|${stable({ call: s.call, args: s.args, deliver: s.deliver })}`;
      if (!index.has(key)) { index.set(key, nodes.length); nodes.push({ parent, ...s }); }
      parent = index.get(key);
    }
    ends.push(parent);
  }
  return { initial: traces[0]?.initial ?? null, nodes, traces: ends };
}

/** The traces of a packed O3. */
export function unpack(o3) {
  return o3.traces.map((end) => {
    const steps = [];
    for (let k = end; k !== -1; k = o3.nodes[k].parent) { const { parent, ...s } = o3.nodes[k]; steps.unshift(s); }
    return { initial: o3.initial, steps };
  });
}

/**
 * Replays O3 on an implementation and checks O2 after every step. Returns every disagreement: a result or an
 * observation that differs, a step that cannot be taken, or an O2 predicate that fails.
 */
export async function replay(createHost, o3, o2, spec) {
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
        if (stable(tr) !== stable(s.transit)) { failures.push({ kind: 'o3', trace: i, step: k + 1, what: `the messages in transit after ${s.text}`, expected: s.transit, actual: tr }); break; }
      }
    } catch (e) {
      failures.push({ kind: 'o3', trace: i, what: e instanceof Diverged ? e.message : `threw: ${e.message}` });
    } finally {
      h?.close?.();
    }
  }
  return { traces: traces.length, failures };
}
