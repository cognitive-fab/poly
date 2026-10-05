// AC5 (M6 step 4): a workflow declared in poly runs through the polyflow MCP tools with no change to those tools.
// conformance/m6/customer-brief.poly is polyflow's own customer-brief workflow written in poly. It is checked CLEAN and
// lowered; the vendored polyflow server, unchanged, loads the lowered directory; and a scripted MCP client drives the
// same script against it and against polyflow's hand-written customer-brief. The two give the same work orders (tool,
// target, arguments, why), the same states and the same ends, step for step, on the approve path, the deny path and
// the empty-brief path. No model is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkFile } from '@poly/check';
import { ROOT } from './helpers.mjs';
import { mcpClient } from './mcp-client.mjs';

const SERVER = join(ROOT, 'vendor', 'polyflow', 'bin', 'polyflow-mcp.mjs');
const HAND_WRITTEN = join(ROOT, 'vendor', 'polyflow', 'workflows');

/**
 * Runs one script through the server over a workflow library. `answer(order)` gives each report's arguments. Returns
 * the catalogue entry and, per step, the work order and the state the run is in.
 */
async function drive(library, date, answer) {
  const dir = mkdtempSync(join(tmpdir(), 'poly-ac5-'));
  const c = mcpClient(process.execPath, [SERVER], {
    cwd: dir,
    env: { ...process.env, POLYFLOW_POLYRUN: join(ROOT, 'vendor', 'polygraph'), POLYFLOW_WORKFLOWS: library, POLYFLOW_DB: join(dir, 'polyflow.sqlite'), POLYFLOW_INSTANCE: 'ac5' },
  });
  try {
    await c.initialize();
    const [entry] = (await c.call('workflow_list')).workflows;
    const steps = [];
    let v = await c.call('workflow_start', { workflow: 'customer-brief', input: { date } });
    for (let k = 0; k < 10; k++) {
      const order = v.next[0] ?? null;
      steps.push({ state: { briefState: v.state.briefState, ticketCount: v.state.ticketCount, reason: v.state.reason }, done: v.done, order: order && { tool: order.tool, target: order.target, args: order.args, why: order.why } });
      if (v.done || !order) break;
      v = await c.call('workflow_report', { order_id: order.order_id, ...answer(order) });
    }
    return { entry: { name: entry.name, admitted: entry.admitted, key: entry.key, tools: entry.tools }, steps };
  } finally {
    await c.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const SCRIPTS = {
  approve: (o) => (o.tool === 'github_search_issues' ? { ok: true, result: { count: 2 } } : { ok: true, result: {} }),
  deny: (o) => (o.tool === 'ask_user' ? { ok: false, permanent: true, error: 'denied by the person' } : o.tool === 'github_search_issues' ? { ok: true, result: { count: 3 } } : { ok: true, result: {} }),
  empty: (o) => (o.tool === 'github_search_issues' ? { ok: true, result: { count: 0 } } : { ok: true, result: {} }),
};

test('AC5: customer-brief written in poly runs through polyflow\'s unchanged tools as the hand-written one does', { timeout: 300_000 }, async (t) => {
  const root = join(ROOT, '.poly', 'test-ac5');
  rmSync(root, { recursive: true, force: true });
  const r = await checkFile(join(ROOT, 'conformance', 'm6', 'customer-brief.poly'), { root });
  assert.equal(r.verdict, 'CLEAN', JSON.stringify(r.machines.flatMap((m) => m.diagnostics.map((d) => d.message))));
  const lowered = join(root, '.poly', 'build', 'workflows');
  for (const [name, answer] of Object.entries(SCRIPTS)) {
    const hand = await drive(HAND_WRITTEN, '2026-10-04', answer);
    const poly = await drive(lowered, '2026-10-04', answer);
    assert.deepEqual(poly.entry, hand.entry, `${name}: the catalogue entry`);
    // One difference, by name: on a failure, the hand-written workflow copies the reporter's free text into `reason`,
    // although its own contract declares DENIED's reason as only "not-ready". poly keeps the declared domain, so its
    // completion carries the declared constant. Everything else of the step is compared as is.
    const declared = ['', 'no-empty-brief', 'api-error', 'not-ready', 'channel-unavailable'];
    const outside = hand.steps.map((s, i) => !declared.includes(s.state.reason) && i);
    for (const i of outside.filter((x) => x !== false)) {
      assert.equal(poly.steps[i].state.reason, 'not-ready', `${name}: step ${i} keeps the declared reason`);
      t.diagnostic(`${name}: step ${i}: the hand-written run writes reason ${JSON.stringify(hand.steps[i].state.reason)}, outside its contract's domain; poly writes "not-ready"`);
    }
    const sameReason = (steps) => steps.map((s, i) => (outside[i] === false ? s : { ...s, state: { ...s.state, reason: '(outside the declared domain)' } }));
    assert.deepEqual(sameReason(poly.steps), sameReason(hand.steps), `${name}: the run, step for step`);
    t.diagnostic(`${name}: ${hand.steps.length} steps, ends ${hand.steps.at(-1).state.briefState}`);
  }
});

// AC5's control: the same workflow with its approval check removed posts before any approval is asked for. poly check
// reports the violated path property in its effects stage (until M8a, polyflow's admission, run as a workflow stage,
// refused it too; S175 retired that stage).
test('AC5, control: customer-brief without its approval check is FINDINGS in poly', { timeout: 120_000 }, async () => {
  const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
  const src = readFileSync(join(ROOT, 'conformance', 'm6', 'customer-brief.poly'), 'utf8');
  const mutant = src.replace('    require briefState == review else reject "nothing-awaiting-approval"\n    briefState\' = posting', '    require briefState == review || briefState == drafting else reject "nothing-awaiting-approval"\n    briefState\' = posting');
  assert.notEqual(mutant, src);
  const dir = join(ROOT, '.poly', 'test-ac5-control');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'customer-brief.poly'), mutant);
  const r = await checkFile(join(dir, 'customer-brief.poly'), { root: dir });
  assert.equal(r.verdict, 'FINDINGS');
  const m = r.machines[0];
  assert.ok(m.diagnostics.some((d) => d.code === 'PL4001' && /no-post-without-prior-approval/.test(d.message)), JSON.stringify(m.diagnostics.map((d) => d.message)));
  // S175: poly's own effects stage finds it; polyflow's admission no longer runs in poly check.
  assert.equal(m.stages.find((s) => s.stage === 'effects').verdict, 'FINDINGS');
});
