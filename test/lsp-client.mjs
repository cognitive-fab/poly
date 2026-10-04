// A scripted language-server client for tests: JSON-RPC 2.0 with Content-Length framing over a child process's stdio,
// as an editor speaks it. It records every notification the server sends, so a test can wait for diagnostics.
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const uriOf = (path) => pathToFileURL(path).href;

export function lspClient(command, args, opts = {}) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts });
  const pending = new Map();
  const notes = [];
  const waiters = [];
  let next = 1;
  let buf = Buffer.alloc(0);
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b; });
  child.on('exit', (code) => {
    for (const p of pending.values()) p.reject(new Error(`the server exited (${code}): ${stderr.slice(-2000)}`));
    pending.clear();
  });
  child.stdout.on('data', (b) => {
    buf = Buffer.concat([buf, b]);
    for (;;) {
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, end).toString('ascii'))?.[1]);
      if (buf.length < end + 4 + len) return;
      const msg = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString('utf8'));
      buf = buf.subarray(end + 4 + len);
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = pending.get(msg.id);
        if (!p) continue;
        pending.delete(msg.id);
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
        else p.resolve(msg.result);
      } else if (msg.method) {
        notes.push(msg);
        for (const w of [...waiters]) if (w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
      }
    }
  });
  const send = (m) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...m }), 'utf8');
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  };
  return {
    stderr: () => stderr,
    request(method, params = {}) {
      return new Promise((resolve, reject) => {
        if (child.exitCode !== null) return reject(new Error(`the server has exited: ${stderr.slice(-2000)}`));
        const id = next++;
        pending.set(id, { resolve, reject });
        send({ id, method, params });
      });
    },
    notify(method, params = {}) { send({ method, params }); },
    /** The next notification that `match` accepts, among those still to come or already received and not taken. */
    wait(match, ms = 120_000) {
      const i = notes.findIndex(match);
      if (i >= 0) return Promise.resolve(notes.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        waiters.push(w);
        setTimeout(() => { if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`no notification in ${ms} ms; stderr: ${stderr.slice(-1000)}`)); } }, ms).unref?.();
      });
    },
    async close() {
      try { await this.request('shutdown'); this.notify('exit'); } catch { /* already gone */ }
      await new Promise((resolve) => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); setTimeout(() => { child.kill(); resolve(); }, 5000).unref?.(); });
    },
  };
}
