// M8a step 2 (S164, S173, S174): AC5 under the gate. The six workflow tools, with polyflow's names and schemas, are
// served over poly-runtime, and a scripted MCP client drives AC5's three scripts through them and through polyflow's
// hand-written customer-brief on the vendored server. The two give the same work orders and states, step for step,
// with E12's difference named. Every order poly issues has the gate's allow in the ledger before it; a policy that
// denies the post issues no order for it; one that escalates it issues none while the escalation waits. No model runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openJournal, polyaxionPeer } from '@poly/runtime';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';
import { mcpClient } from './mcp-client.mjs';
import { admitted } from './runtime-helpers.mjs';

const POLYFLOW = join(ROOT, 'vendor', 'polyflow', 'bin', 'polyflow-mcp.mjs');
const HAND_WRITTEN = join(ROOT, 'vendor', 'polyflow', 'workflows');
const SERVER = join(ROOT, 'test', 'fixtures', 'workflow-server.mjs');
const BRIEF = 'conformance/m6/customer-brief.poly';
const peer = polyaxionPeer();
const skip = peer.ok ? false : `not run: ${peer.reason}`;

const SCRIPTS = {
  approve: (o) => (o.tool === 'github_search_issues' ? { ok: true, result: { count: 2 } } : { ok: true, result: {} }),
  deny: (o) => (o.tool === 'ask_user' ? { ok: false, permanent: true, error: 'denied by the person' } : o.tool === 'github_search_issues' ? { ok: true, result: { count: 3 } } : { ok: true, result: {} }),
  empty: (o) => (o.tool === 'github_search_issues' ? { ok: true, result: { count: 0 } } : { ok: true, result: {} }),
};

/** polyflow's server over its hand-written library. */
function polyflow() {
  const dir = mkdtempSync(join(tmpdir(), 'poly-m8-flow-'));
  const c = mcpClient(process.execPath, [POLYFLOW], { cwd: dir, env: { ...process.env, POLYFLOW_POLYRUN: join(ROOT, 'vendor', 'polygraph'), POLYFLOW_WORKFLOWS: HAND_WRITTEN, POLYFLOW_DB: join(dir, 'polyflow.sqlite'), POLYFLOW_INSTANCE: 'm8' } });
  return { c, dir, db: null };
}

/** The workflow tools over poly-runtime, on an admitted build and a store file of the test's own. */
function polyRun(a) {
  const dir = mkdtempSync(join(tmpdir(), 'poly-m8-run-'));
  const trust = join(dir, 'admission.pub.pem');
  writeFileSync(trust, a.trust[a.key.id]);
  const db = join(dir, 'store.sqlite');
  const c = mcpClient(process.execPath, [...ACCEPT_TEST_ANCHORS, SERVER, a.build, a.certificate, a.key.id, trust, db], { cwd: dir });
  return { c, dir, db };
}

/** Drives one script; returns the catalogue entry and, per step, the order and the state. */
async function drive(server, date, answer) {
  const { c } = server;
  await c.initialize();
  const [entry] = (await c.call('workflow_list')).workflows;
  const steps = [];
  let v = await c.call('workflow_start', { workflow: 'customer-brief', input: { date } });
  for (let k = 0; k < 10; k++) {
    const order = v.next?.[0] ?? null;
    steps.push({ state: { briefState: v.state.briefState, ticketCount: v.state.ticketCount, reason: v.state.reason }, done: v.done, order: order && { tool: order.tool, target: order.target, args: order.args, why: order.why } });
    if (v.done || !order) break;
    v = await c.call('workflow_report', { order_id: order.order_id, ...answer(order) });
    assert.equal(v.error, undefined, JSON.stringify(v));
  }
  return { entry: { name: entry.name, admitted: entry.admitted, key: entry.key, tools: entry.tools }, steps, instance: v.instance };
}

const done = async (s) => { await s.c.close(); rmSync(s.dir, { recursive: true, force: true }); };

test('S174: the six tools have polyflow\'s names and input schemas', async () => {
  const a = await admitted('m8-run-tools', [BRIEF]);
  const flow = polyflow();
  const run = polyRun(a);
  try {
    await flow.c.initialize();
    await run.c.initialize();
    const shape = (tools) => tools.map((t) => [t.name, [...(t.inputSchema.required ?? [])].sort(), Object.keys(t.inputSchema.properties ?? {}).sort()]).sort();
    assert.deepEqual(shape((await run.c.request('tools/list')).tools), shape((await flow.c.request('tools/list')).tools));
    assert.ok(!(await run.c.request('tools/list')).tools.some((t) => /approve|accept/.test(t.name)), 'no approve or accept tool (S174)');
  } finally { await done(flow); await done(run); }
});

test('AC5 under the gate: customer-brief runs on poly-runtime as polyflow runs its hand-written one, and every order was allowed before it was issued', { timeout: 300_000 }, async (t) => {
  const a = await admitted('m8-run-ac5', [BRIEF]);
  assert.deepEqual(a.cert.poly.workflows.map((w) => [w.name, w.runtime, w.gated]), [['customer-brief', 'poly-runtime', true]]);
  assert.ok(!a.cert.poly.limits.some((l) => /ungated/.test(l)), 'the certificate no longer lists the workflow as ungated');
  for (const [name, answer] of Object.entries(SCRIPTS)) {
    const flow = polyflow();
    const run = polyRun(a);
    let hand, poly;
    try {
      hand = await drive(flow, '2026-10-04', answer);
      poly = await drive(run, '2026-10-04', answer);
    } finally { await flow.c.close(); await run.c.close(); }
    try {
      assert.deepEqual(poly.entry, hand.entry, `${name}: the catalogue entry`);
      // E12, by name: the hand-written workflow copies the reporter's free text into `reason`, outside its contract's
      // declared domain; poly keeps the declared constant. Everything else is compared as is.
      const declared = ['', 'no-empty-brief', 'api-error', 'not-ready', 'channel-unavailable'];
      const outside = hand.steps.map((s, i) => !declared.includes(s.state.reason) && i);
      for (const i of outside.filter((x) => x !== false)) assert.equal(poly.steps[i].state.reason, 'not-ready', `${name}: step ${i}`);
      const same = (steps) => steps.map((s, i) => (outside[i] === false ? s : { ...s, state: { ...s.state, reason: '(outside the declared domain)' } }));
      assert.deepEqual(same(poly.steps), same(hand.steps), `${name}: the run, step for step`);
      // The ledger: each issued order follows the gate's allow of its intent.
      const j = openJournal(run.db);
      try {
        const chain = await j.chain(poly.instance);
        const issued = chain.map((e, i) => [e, i]).filter(([e]) => e.kind === 'observation' && e.body.stage === 'work-order' && e.body.outcome === 'issued');
        assert.equal(issued.length, poly.steps.filter((s) => s.order).length, `${name}: one issue per order`);
        for (const [e, i] of issued) {
          const allowed = chain.findIndex((x) => x.kind === 'verdict' && x.body.intent === e.body.intent && x.body.outcome === 'allowed');
          assert.ok(allowed >= 0 && allowed < i, `${name}: ${e.body.orderId} was allowed before it was issued`);
        }
      } finally { await j.close?.(); }
      t.diagnostic(`${name}: ${poly.steps.length} steps, ends ${poly.steps.at(-1).state.briefState}`);
    } finally { rmSync(flow.dir, { recursive: true, force: true }); rmSync(run.dir, { recursive: true, force: true }); }
  }
});

test('S164: a policy that denies the post issues no order for it, and the run takes its failure branch', { skip, timeout: 300_000 }, async () => {
  const a = await admitted('m8-run-deny', [BRIEF, 'conformance/m8/brief-deny.policy.poly']);
  const run = polyRun(a);
  try {
    const r = await drive(run, '2026-10-04', SCRIPTS.approve);
    assert.deepEqual(r.steps.filter((s) => s.order).map((s) => s.order.tool), ['github_search_issues', 'ask', 'ask_user']);
    assert.equal(r.steps.at(-1).state.briefState, 'failed');
    assert.equal(r.steps.at(-1).state.reason, 'channel-unavailable');
  } finally { await done(run); }
});

test('S164: a policy that escalates the post issues no order while the escalation waits for a person', { skip, timeout: 300_000 }, async () => {
  const a = await admitted('m8-run-escalate', [BRIEF, 'conformance/m8/brief-escalate.policy.poly']);
  const run = polyRun(a);
  try {
    const r = await drive(run, '2026-10-04', SCRIPTS.approve);
    assert.deepEqual(r.steps.filter((s) => s.order).map((s) => s.order.tool), ['github_search_issues', 'ask', 'ask_user']);
    const last = r.steps.at(-1);
    assert.equal(last.state.briefState, 'posting');
    assert.equal(last.done, false);
    const v = await run.c.call('workflow_state', { instance: r.instance });
    assert.deepEqual(v.next ?? [], []);
  } finally { await done(run); }
});

test('S175: a certificate from before M8a, listing a workflow as run by polyflow outside the gate, is refused at load', async () => {
  const { readFileSync } = await import('node:fs');
  const { certificateDigest, signDigest } = await import('@poly/core');
  const { load, LoadError } = await import('@poly/runtime');
  const a = await admitted('m8-run-old-cert', [BRIEF]);
  const cert = JSON.parse(readFileSync(a.certificate, 'utf8'));
  cert.poly.workflows = cert.poly.workflows.map((w) => ({ ...w, runtime: 'polyflow', gated: false }));
  delete cert.digest; delete cert.signatures;
  const digest = certificateDigest(cert);
  const old = { ...cert, digest, signatures: [signDigest(digest, a.key.id, readFileSync(a.key.file, 'utf8'))] };
  const path = join(a.dir, '.poly', 'old-certificate.json');
  writeFileSync(path, JSON.stringify(old));
  await assert.rejects(load(a.build, { certificate: path, trust: a.trust }), (e) => e instanceof LoadError && /predates S175/.test(e.message));
});

test('polywatch on step 2: a certificate whose workflow entry names the descriptor of another workflow is refused at load', async () => {
  const { readFileSync } = await import('node:fs');
  const { certificateDigest, signDigest } = await import('@poly/core');
  const { load, LoadError } = await import('@poly/runtime');
  const a = await admitted('m8-run-name', [BRIEF]);
  const cert = JSON.parse(readFileSync(a.certificate, 'utf8'));
  cert.poly.workflows = cert.poly.workflows.map((w) => ({ ...w, name: 'another-brief' }));
  delete cert.digest; delete cert.signatures;
  const digest = certificateDigest(cert);
  const path = join(a.dir, '.poly', 'renamed-certificate.json');
  writeFileSync(path, JSON.stringify({ ...cert, digest, signatures: [signDigest(digest, a.key.id, readFileSync(a.key.file, 'utf8'))] }));
  await assert.rejects(load(a.build, { certificate: path, trust: a.trust }), (e) => e instanceof LoadError && /has the descriptor of workflow customer-brief/.test(e.message));
});

test('S173, K9 over MCP: a report of an order not open, and a signal of a work order\'s completion, are refused and change nothing', async () => {
  const a = await admitted('m8-run-refusals', [BRIEF]);
  const run = polyRun(a);
  try {
    await run.c.initialize();
    const v = await run.c.call('workflow_start', { workflow: 'customer-brief', input: { date: '2026-10-05' } });
    const [o] = v.next;
    const wrong = await run.c.call('workflow_report', { order_id: `${o.order_id.slice(0, o.order_id.lastIndexOf('#'))}#2`, ok: true, result: { count: 2 } });
    assert.match(wrong.error, /issued/);
    // A refused signal throws in the runtime, so the tool answers with isError, as polyflow's server does (polywatch).
    const sig = await run.c.request('tools/call', { name: 'workflow_signal', arguments: { instance: v.instance, action: 'TICKETS_READY', data: { count: 2 } } });
    assert.equal(sig.isError, true);
    assert.match(sig.content[0].text, /K9/);
    const steps = (await run.c.call('workflow_journal', { instance: v.instance })).journal.length;
    const again = await run.c.call('workflow_start', { workflow: 'customer-brief', input: { date: '2026-10-05' }, key: 'another' });
    assert.equal((await run.c.call('workflow_journal', { instance: v.instance })).journal.length, steps, 'attaching takes no step');
    assert.equal(again.instance, v.instance, 'the run is attached, not started again');
    assert.match(again.key_note, /ignored/);
    assert.equal(again.state.briefState, 'gathering');
    assert.equal(again.next[0].order_id, o.order_id);
  } finally { await done(run); }
});
