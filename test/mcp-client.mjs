// A scripted MCP client for tests: newline-delimited JSON-RPC 2.0 over a child process's stdio, as an MCP host speaks
// it. No model is involved; the test decides every call.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function mcpClient(command, args, opts = {}) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts });
  const pending = new Map();
  let next = 1;
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b; });
  // A server that exits answers nothing more: every pending call fails, with what it wrote to stderr.
  child.on('exit', (code) => {
    for (const p of pending.values()) p.reject(new Error(`the server exited (${code}): ${stderr.slice(-2000)}`));
    pending.clear();
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
    else p.resolve(msg.result);
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    if (child.exitCode !== null) return reject(new Error(`the server has exited: ${stderr.slice(-2000)}`));
    const id = next++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return {
    request,
    stderr: () => stderr,
    async initialize() {
      const r = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'poly-test', version: '0' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      return r;
    },
    /** Calls a tool and returns its structured content (or the parsed text when there is none). */
    async call(name, args = {}) {
      const r = await request('tools/call', { name, arguments: args });
      if (r.isError) throw new Error(`${name}: ${r.content?.map((c) => c.text).join(' ')}`);
      return r.structuredContent ?? JSON.parse(r.content[0].text);
    },
    close() {
      return new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.stdin.end();
        child.kill();
      });
    },
  };
}
