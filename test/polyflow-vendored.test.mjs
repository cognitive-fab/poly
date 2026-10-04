// M6 step 0: polyflow's server and library are vendored unchanged (vendor/polyflow/PROVENANCE.md), and run on the
// vendored polygraph. A scripted MCP client drives polyflow's own customer-brief workflow through the vendored server
// from workflow_start to a terminal state, on the approve path and on the deny path. No model is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ROOT } from './helpers.mjs';
import { mcpClient } from './mcp-client.mjs';

const SERVER = join(ROOT, 'vendor', 'polyflow', 'bin', 'polyflow-mcp.mjs');

/** Runs customer-brief for one date; `approve` decides the approval order. Returns the final view and the tools seen. */
async function run(date, approve) {
  const dir = mkdtempSync(join(tmpdir(), 'poly-polyflow-'));
  const c = mcpClient(process.execPath, [SERVER], {
    cwd: dir,
    env: { ...process.env, POLYFLOW_POLYRUN: join(ROOT, 'vendor', 'polygraph'), POLYFLOW_WORKFLOWS: join(ROOT, 'vendor', 'polyflow', 'workflows'), POLYFLOW_DB: join(dir, 'polyflow.sqlite'), POLYFLOW_INSTANCE: 'poly-test' },
  });
  try {
    const init = await c.initialize();
    assert.equal(init.serverInfo.name, 'polyflow');
    const tools = (await c.request('tools/list')).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ['workflow_journal', 'workflow_list', 'workflow_report', 'workflow_signal', 'workflow_start', 'workflow_state']);
    const listed = (await c.call('workflow_list')).workflows;
    assert.deepEqual(listed.map((w) => [w.name, w.admitted]), [['customer-brief', true]], c.stderr());
    let v = await c.call('workflow_start', { workflow: 'customer-brief', input: { date } });
    const seen = [];
    for (let k = 0; k < 10 && !v.done; k++) {
      assert.equal(v.next.length, 1, JSON.stringify(v));
      const order = v.next[0];
      seen.push(order.tool);
      if (order.tool === 'ask_user' && !approve) v = await c.call('workflow_report', { order_id: order.order_id, ok: false, permanent: true, error: 'denied by the person' });
      else v = await c.call('workflow_report', { order_id: order.order_id, ok: true, result: order.tool === 'github_search_issues' ? { count: 2 } : {} });
    }
    return { v, seen };
  } finally {
    await c.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('M6 step 0: the vendored polyflow server runs its own customer-brief to posted, and to denied', { timeout: 120_000 }, async () => {
  const approved = await run('2026-10-04', true);
  assert.equal(approved.v.done, true);
  assert.equal(approved.v.state.briefState, 'posted');
  assert.deepEqual(approved.seen, ['github_search_issues', 'ask', 'ask_user', 'slack_send']);
  const denied = await run('2026-10-05', false);
  assert.equal(denied.v.done, true);
  assert.equal(denied.v.state.briefState, 'denied');
  assert.deepEqual(denied.seen, ['github_search_issues', 'ask', 'ask_user']);
});
