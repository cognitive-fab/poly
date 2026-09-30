// M3-2 (plan-m3 step 1): every multi-machine conformance case runs under polyrun. For each configuration,
// every global step poly-ref explores (PS13.3) is replayed as a polyrun run: the path to its pre-state and the
// step itself, inputs as dispatches and deliveries one message at a time (S89), and after each step polyrun's
// instance states and messages in transit must equal poly-ref's global state (σ, μ). poly-ref is the semantics;
// polyrun, running the lowered artefacts, must agree with it.
//
// detached.poly is not replayed: its Dispatcher spawns a detached child, and polyrun has no createInstance
// intent (M3-2 builds it only when a task needs one, and none does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from '@poly/lang';
import { checkModule } from '@poly/core';
import { lowerMachine } from '@poly/lower';
import { checkConfiguration, flatten, flattenData, pathTo } from '@poly/ref';
import { createRuntime } from '@cognitive-fab/polygraph/polyrun/src/index.mjs';
import { ROOT, BUILD } from './helpers.mjs';

const stable = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(stable).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`);

// sends.poly checks its machines alone; these configurations put them together: two orders racing for one
// item, and two clients contending for one lock. One configuration of all four has 2,200 global states and
// 22,100 steps (measured), too many to replay step by step, so the two pairs are separate.
const SHOP = `
configuration shop {
  inv       : Inventory
  order[2]  : Order { inv: inv }
  inputs    { order[*].Place }
  bounds    { transit 4 }
}

configuration locks {
  lock      : Lock
  client[2] : Client
  inputs    { lock.Acquire, lock.Release }
  bounds    { transit 2 }
}
`;

const CASES = [
  ['conformance/m1/sends.poly', SHOP],
  ['examples/checkout/checkout.poly', ''],
  ['examples/checkout/checkout-optimistic.poly', ''],
  ['conformance/m2/seeded/configuration-invariant/fixed.poly', ''],
  ['conformance/m2/seeded/configuration-invariant/unfixed.poly', ''],
  ['conformance/m2/seeded/stuck/fixed.poly', ''],
  ['conformance/m2/seeded/stuck/unfixed.poly', ''],
];

/** Lowers every machine of the module the configuration uses, where polyrun loads it. */
function lowerAll(module, name) {
  const checked = checkModule(module);
  assert.deepEqual(checked.diagnostics.map((d) => d.code), []);
  const machines = [];
  for (const machine of checked.machines.keys()) {
    const { lowered, diagnostics } = lowerMachine(module, checked, machine);
    assert.ok(lowered, JSON.stringify(diagnostics));
    const dir = join(BUILD, 'config-polyrun', name, `${module.name}.${machine}`);
    mkdirSync(dir, { recursive: true });
    for (const [f, text] of Object.entries(lowered.files)) writeFileSync(join(dir, f), text);
    const effects = lowered.files['effects.cjs'] ? { mapper: join(dir, 'effects.cjs'), manifest: join(dir, 'effects.manifest.json') } : undefined;
    machines.push({ machineId: machine, module: join(dir, 'next.cjs'), contract: join(dir, 'contract.json'), ...(effects ? { effects } : {}) });
  }
  return machines;
}

/** One polyrun run of a configuration: each instance created, then given the configuration's values (PS13.1). */
async function start(machines, instances) {
  const rt = await createRuntime({ store: { sqlite: ':memory:' }, machines });
  for (const x of instances) {
    await rt.create(x.machine.name, x.name);
    // polyrun creates an instance in its machine's initial state; a configuration may give fields other values.
    rt.store.db.prepare('UPDATE pr_instance SET state = ? WHERE instance_id = ?').run(JSON.stringify(flatten(x.init, x.machine)), x.name);
  }
  return rt;
}

/** The global state polyrun holds: each instance's flat state, and the messages in transit as a multiset. */
async function observe(rt, instances) {
  const sigma = {};
  for (const x of instances) sigma[x.name] = (await rt.getState(x.name)).state;
  const mu = (await rt.workers.pendingMessages()).map((m) => stable({ to: m.to, action: m.action, data: m.data })).sort();
  return { sigma, mu };
}

/** poly-ref's global state in the same terms. */
function expected(g, instances) {
  const sigma = Object.fromEntries(instances.map((x, k) => [x.name, flatten(g.sigma[k], x.machine)]));
  const mu = g.mu.map((m) => stable({ to: instances[m.target].name, action: m.action, data: flattenData(m.data, m.action, instances[m.target].machine) })).sort();
  return { sigma, mu };
}

/** Takes one global step under polyrun; returns whether it was accepted. */
async function take(rt, instances, label, n) {
  const inst = instances[label.instance];
  const data = flattenData(label.data, label.action, inst.machine);
  if (label.via === 'input') return (await rt.dispatch(inst.name, label.action, data, `input-${n}`)).stepKind === 'accepted';
  const want = stable({ to: inst.name, action: label.action, data });
  const m = (await rt.workers.pendingMessages()).find((x) => stable({ to: x.to, action: x.action, data: x.data }) === want);
  assert.ok(m, `no message ${want} in transit under polyrun`);
  assert.equal(await rt.workers.deliverMessage(m.id), true);
  const row = (await rt.getJournal(inst.name)).find((r) => r.action_id === m.id);
  return row?.step_kind === 'accepted';
}

for (const [file, extra] of CASES) {
  test(`${file}: every global step poly-ref explores, replayed under polyrun, reaches poly-ref's global state`, async () => {
    const module = parse(readFileSync(join(ROOT, file), 'utf8') + extra).module;
    assert.ok(module);
    const name = file.split('/').join('_').replace(/\.poly$/, '');
    const machines = lowerAll(module, name);
    const configs = module.decls.filter((d) => d.kind === 'Configuration');
    assert.ok(configs.length > 0);
    for (const decl of configs) {
      const r = checkConfiguration(module, decl.name);
      const g = r.graph;
      assert.ok(g.edges.length > 0);
      let steps = 0;
      for (const e of g.edges) {
        const path = [...pathTo(g, e.from), e];
        const rt = await start(machines, r.instances);
        try {
          assert.deepEqual(await observe(rt, r.instances), expected(g.states[0], r.instances), 'initial state');
          for (const [n, step] of path.entries()) {
            const accepted = await take(rt, r.instances, step.label, n);
            assert.equal(accepted, step.label.verdict.kind === 'accepted', `${decl.name}, step ${n + 1} of edge ${g.edges.indexOf(e)}: ${step.label.action}@${r.instances[step.label.instance].name}`);
            const post = step.to !== null ? g.states[step.to] : step.outcome.state;
            assert.deepEqual(await observe(rt, r.instances), expected(post, r.instances), `${decl.name}, after step ${n + 1} of edge ${g.edges.indexOf(e)}`);
          }
          steps += 1;
        } finally {
          rt.close();
        }
      }
      assert.equal(steps, g.edges.length);
    }
  });
}
