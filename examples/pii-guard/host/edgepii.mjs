// The client of the edgepii adapter (docs/examples/pii-guard.md, "The adapter client", S587). It starts the pinned
// adapter with no shell and almost no environment, checks it against examples/pii-guard/adapter/PIN.json before and after it starts
// (PG4), and speaks one JSON line per request. Any answer it cannot match to its request is malformed; a process that
// stops answering is killed, and every later call is missing.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { FactError } from './facts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', 'adapter', 'adapter.py');
const VENV = 'edgepii-0.3.1';

/** The venv's python (Q7), or POLY_EDGEPII_PYTHON when set. */
export function defaultPython() {
  if (process.env.POLY_EDGEPII_PYTHON) return process.env.POLY_EDGEPII_PYTHON;
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return join(base, 'poly', 'venvs', VENV, 'Scripts', 'python.exe');
  }
  return join(homedir(), '.local', 'share', 'poly', 'venvs', VENV, 'bin', 'python');
}

const PIN_FIELDS = ['edgepii', 'wheel', 'source', 'taxonomy', 'adapter', 'presets'];

export function loadPin(file) {
  const pin = JSON.parse(readFileSync(file, 'utf8'));
  for (const f of PIN_FIELDS) if (pin?.[f] === undefined) throw new Error(`${file}: the pin has no ${f}`);
  return pin;
}

const digestOf = (file) => `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;

const mismatch = (field) => Object.assign(new FactError('pin-mismatch', `the adapter does not match the pin (${field})`), { field });

/** Only what Python needs and what keeps it offline (PG2): nothing else of the parent's environment. */
function environment() {
  const env = { PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', HF_HUB_OFFLINE: '1' };
  if (process.platform === 'win32' && process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  if (process.env.HF_HOME) env.HF_HOME = process.env.HF_HOME;
  return env;
}

/** The fields of hello the pin fixes, in the order they are compared. */
function helloMismatch(hello, pin, preset) {
  const row = pin.presets?.[preset];
  if (hello.edgepii !== pin.edgepii) return 'edgepii';
  if (hello.source !== pin.source) return 'source';
  if (hello.taxonomy !== pin.taxonomy) return 'taxonomy';
  if (!row || hello.revision !== row.revision) return 'revision';
  if (JSON.stringify(hello.detectors) !== JSON.stringify(row.detectors)) return 'detectors';
  return null;
}

export async function startAdapter({ python, script = SCRIPT, pin, preset = 'rules', timeoutMs = 10000 }) {
  if (digestOf(script) !== pin.adapter) throw mismatch('adapter');
  if (!python || !existsSync(python)) throw new FactError('missing', `no python at ${python}`);

  let child;
  try {
    child = spawn(python, [script, '--preset', preset], { env: environment(), shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch {
    throw new FactError('missing', `the adapter did not start`);
  }
  let dead = false;
  let nextId = 1;
  const queue = [];
  const fail = (code) => {
    dead = true;
    while (queue.length) {
      const p = queue.shift();
      clearTimeout(p.timer);
      p.reject(new FactError(code));
    }
  };
  child.on('error', () => fail('missing'));
  child.on('exit', () => fail('missing'));
  child.stdin.on('error', () => {});
  // Stderr is the adapter's log and carries no value; it is drained so the process never blocks on it.
  child.stderr.resume();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const p = queue.shift();
    if (!p) return;
    clearTimeout(p.timer);
    let answer;
    try {
      answer = JSON.parse(line);
    } catch {
      return p.reject(new FactError('malformed'));
    }
    if (answer === null || typeof answer !== 'object' || answer.v !== 1 || answer.id !== p.id) return p.reject(new FactError('malformed'));
    if (answer.ok !== true) return p.reject(new FactError('not-ok'));
    p.resolve(answer);
  });

  const call = (request) => new Promise((resolveCall, rejectCall) => {
    if (dead) return rejectCall(new FactError('missing'));
    const id = nextId++;
    const timer = setTimeout(() => {
      const at = queue.findIndex((p) => p.id === id);
      if (at >= 0) queue.splice(at, 1);
      dead = true;
      child.kill();
      rejectCall(new FactError('timeout'));
    }, timeoutMs);
    queue.push({ id, resolve: resolveCall, reject: rejectCall, timer });
    child.stdin.write(`${JSON.stringify({ v: 1, id, ...request })}\n`);
  });

  const close = () => {
    dead = true;
    child.stdin.end();
    child.kill();
  };

  const hello = await call({ op: 'hello' });
  const field = helloMismatch(hello, pin, preset);
  if (field) {
    close();
    throw mismatch(field);
  }
  return {
    preset,
    // The hello answer, for host/record.mjs to keep beside the recorded answers.
    hello,
    locate: (text, types) => call({ op: 'locate', text, types }),
    redact: (text, types) => call({ op: 'redact', text, types }),
    close,
  };
}

/** Whether the adapter can run, and if not the exact message a test skips with (PG13's lanes). */
export async function adapterStatus({ python = defaultPython(), pin, preset = 'rules', script } = {}) {
  if (!existsSync(python)) return { ok: false, reason: `not run: edgepii 0.3.1 is not installed at ${python}; run node examples/pii-guard/adapter/setup.mjs` };
  try {
    const client = await startAdapter({ python, pin, preset, ...(script ? { script } : {}) });
    client.close();
    return { ok: true };
  } catch (e) {
    if (e?.code === 'pin-mismatch') return { ok: false, reason: `not run: the adapter at ${python} does not match examples/pii-guard/adapter/PIN.json (${e.field})` };
    if (preset === 'multi-open') return { ok: false, reason: 'not run: the multi-open lane is not installed; run node examples/pii-guard/adapter/setup.mjs --model' };
    return { ok: false, reason: `not run: edgepii 0.3.1 is not installed at ${python}; run node examples/pii-guard/adapter/setup.mjs` };
  }
}
