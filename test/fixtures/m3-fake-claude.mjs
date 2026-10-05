// A stand-in for the claude CLI in one turn (test/m3-cleanup.test.mjs): it prints the stream-json events of a turn
// and, like a command the CLI moved to the background, leaves a process running in the workspace after it exits.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const out = (e) => process.stdout.write(JSON.stringify(e) + '\n');
out({ type: 'system', subtype: 'init', session_id: 'fake-session', permissionMode: 'dontAsk', mcp_servers: [], plugins: [], skills: [] });
const leftover = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { cwd: process.cwd(), detached: true, stdio: 'ignore' });
leftover.unref();
// The ready signal: the CLI has started and left its process, so a cap from now on has both to end (decisions-m6.md).
if (process.env.M3_FAKE_READY) writeFileSync(process.env.M3_FAKE_READY, String(leftover.pid));
// With M3_FAKE_HANG, the turn never ends, as one a cap stops.
if (process.env.M3_FAKE_HANG) setInterval(() => {}, 1000);
else {
out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
out({ type: 'result', subtype: 'success', is_error: false, session_id: 'fake-session', total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
}
