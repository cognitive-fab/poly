// pii-guard: the real edgepii adapter, skipped with adapterStatus's reason when it is not installed. Written from
// docs/examples/pii-guard.md alone, before any code exists (rule 7a). Covers PG3 (no answer holds a key outside the
// protocol), PG4 (hello matches the pin), PG12 (the live answers equal the recorded ones for every sample, and the
// tests skip with their message when the adapter is absent), and the adapter's start rules (EDGEPII_LOG_TEXT refused
// with status 2, a malformed line answered and the adapter still serving).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';

const EX_DIR = join(ROOT, 'examples', 'pii-guard');
const HOST = join(EX_DIR, 'host');
const SAMPLES = join(EX_DIR, 'samples');
const ADAPTER = join(ROOT, 'adapters', 'edgepii', 'adapter.py');
const PIN_FILE = join(ROOT, 'adapters', 'edgepii', 'PIN.json');

const { adapterStatus, defaultPython, loadPin, startAdapter } = await import(pathToFileURL(join(HOST, 'edgepii.mjs')).href);
const { loadRecorded } = await import(pathToFileURL(join(HOST, 'recorded.mjs')).href);
const { SCAN_TYPES } = await import(pathToFileURL(join(HOST, 'providers.mjs')).href);

const PYTHON = defaultPython();
const PIN = loadPin(PIN_FILE);
const STATUS = await adapterStatus({ python: PYTHON, pin: PIN, preset: 'rules' });
// PG12: a test that needs the adapter skips with the reason adapterStatus gives.
const SKIP = STATUS.ok ? false : STATUS.reason;
if (SKIP) console.log(SKIP);

const fixture = loadRecorded(join(EX_DIR, 'recorded', 'answers.json'));
const sample = (file) => readFileSync(join(SAMPLES, file), 'utf8');
// The request id is a counter of the connection, so a live answer and a recorded one are compared without it.
const noId = (x) => { const { id, ...rest } = x ?? {}; void id; return rest; };

// The protocol's keys (the adapter section). PG3: no answer carries text, raw_label, score, a vault or a quasi row.
const KEYS = {
  hello: ['detectors', 'edgepii', 'id', 'ok', 'preset', 'revision', 'source', 'taxonomy', 'v'],
  locate: ['dropped', 'id', 'ok', 'spans', 'v'],
  span: ['detector', 'detectorId', 'end', 'start', 'type'],
  redact: ['id', 'masked', 'ok', 'recheck', 'redacted', 'v'],
  recheck: ['dropped', 'found'],
  error: ['error', 'id', 'kind', 'ok', 'v'],
};
const within = (obj, allowed, what) => {
  for (const k of Object.keys(obj)) assert.ok(allowed.includes(k), `${what}: the key ${k} is outside the protocol`);
};
function protocolOnly(op, a) {
  if (a.ok !== true) { within(a, KEYS.error, `${op} error`); return; }
  within(a, KEYS[op], op);
  if (op === 'locate') for (const s of a.spans) assert.deepEqual(Object.keys(s).sort(), KEYS.span, 'a span carries exactly the five keys');
  if (op === 'redact') within(a.recheck, KEYS.recheck, 'recheck');
}

/** The environment the client passes (host/edgepii.mjs): nothing else of the parent's. */
function adapterEnv(extra = {}) {
  const env = { PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', HF_HUB_OFFLINE: '1', ...extra };
  if (process.platform === 'win32' && process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  if (process.env.HF_HOME) env.HF_HOME = process.env.HF_HOME;
  return env;
}

/**
 * The adapter process spoken to directly, line by line: the client has no hello and never writes a malformed line, so
 * the protocol's own answers are read here.
 */
function rawAdapter(extraEnv = {}) {
  const child = spawn(PYTHON, [ADAPTER, '--preset', 'rules'], { env: adapterEnv(extraEnv), stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  child.stdin.on('error', () => {});
  let out = '';
  let err = '';
  const lines = [];
  const waiters = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    out += d;
    let i;
    while ((i = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, i);
      out = out.slice(i + 1);
      if (waiters.length) waiters.shift()(line); else lines.push(line);
    }
  });
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  const next = (ms = 20_000) => (lines.length ? Promise.resolve(lines.shift()) : new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no answer in ${ms} ms; stderr: ${err}`)), ms);
    waiters.push((l) => { clearTimeout(t); resolve(l); });
  }));
  return {
    child, exited, stderr: () => err, lines,
    write: (s) => child.stdin.write(s),
    ask: async (req) => { child.stdin.write(`${JSON.stringify(req)}\n`); return JSON.parse(await next()); },
    next,
    close: () => { child.stdin.end(); return exited; },
  };
}

test('PG4: hello matches the pin and the recorded hello', { skip: SKIP, timeout: 120_000 }, async () => {
  const a = rawAdapter();
  try {
    const hello = await a.ask({ v: 1, id: 1, op: 'hello' });
    protocolOnly('hello', hello);
    assert.equal(hello.v, 1);
    assert.equal(hello.id, 1);
    assert.equal(hello.ok, true);
    assert.equal(hello.edgepii, PIN.edgepii);
    assert.equal(hello.source, PIN.source);
    assert.equal(hello.taxonomy, PIN.taxonomy);
    assert.equal(hello.preset, 'rules');
    assert.equal(hello.revision, PIN.presets.rules.revision);
    assert.deepEqual(hello.detectors, PIN.presets.rules.detectors);
    assert.deepEqual(noId(hello), noId(fixture.hello), 'the recorded hello is the live one');
  } finally {
    await a.close();
  }
});

test('PG12, PG3: for each sample, the live locate and redact answers equal the recorded ones, and hold only protocol keys', { skip: SKIP, timeout: 300_000 }, async () => {
  const client = await startAdapter({ python: PYTHON, script: ADAPTER, pin: PIN, preset: 'rules' });
  try {
    assert.equal(client.preset, 'rules');
    assert.ok(fixture.documents.length >= 6, 'the fixture records the samples');
    for (const d of fixture.documents) {
      const text = sample(d.file);
      if (d.locate.ok === true) {
        const live = await client.locate(text, SCAN_TYPES);
        protocolOnly('locate', live);
        assert.deepEqual(noId(live), noId(d.locate), `${d.file}: locate`);
      } else {
        assert.equal((await client.locate(text, SCAN_TYPES).catch((e) => e)).code, 'not-ok', `${d.file}: locate refused as recorded`);
      }
      for (const r of d.redact) {
        if (r.answer.ok === true) {
          const live = await client.redact(text, r.types);
          protocolOnly('redact', live);
          assert.deepEqual(noId(live), noId(r.answer), `${d.file}: redact ${r.types.join(',')}`);
        } else {
          assert.equal((await client.redact(text, r.types).catch((e) => e)).code, 'not-ok', `${d.file}: redact refused as recorded`);
        }
      }
    }
  } finally {
    await client.close();
  }
});

test('the adapter started with EDGEPII_LOG_TEXT=1 exits with status 2 and answers nothing', { skip: SKIP, timeout: 120_000 }, async () => {
  const a = rawAdapter({ EDGEPII_LOG_TEXT: '1' });
  a.write(`${JSON.stringify({ v: 1, id: 1, op: 'hello' })}\n`);
  const code = await a.exited;
  assert.equal(code, 2);
  assert.deepEqual(a.lines, [], 'no answer was written');
  assert.ok(a.stderr().includes('EDGEPII_LOG_TEXT is set; the adapter does not log values'), a.stderr());
});

test('a malformed line answers malformed-request and the adapter keeps serving', { skip: SKIP, timeout: 120_000 }, async () => {
  const a = rawAdapter();
  try {
    a.write('this is not json\n');
    const bad = JSON.parse(await a.next());
    protocolOnly('hello', bad);
    assert.deepEqual(bad, { v: 1, id: null, ok: false, error: 'malformed-request' });
    const hello = await a.ask({ v: 1, id: 2, op: 'hello' });
    assert.equal(hello.ok, true, 'the adapter still serves');
    assert.equal(hello.id, 2);
    // A locate after it answers too, in types and offsets only.
    const live = await a.ask({ v: 1, id: 3, op: 'locate', text: sample('clean.txt'), types: SCAN_TYPES });
    protocolOnly('locate', live);
    assert.equal(live.id, 3);
  } finally {
    await a.close();
  }
});
