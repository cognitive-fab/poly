// plan-e3.md E3.3 (HAC4, S553, S554, S559, HF3.3, S561): the certified handlers of the harness, their property tests, the
// four seeded mutant verifiers, the canary over the sinks a tool output reaches, and the lint that refuses ambient
// authority. The handlers are deterministic code (no model call), so every test here is light and runs on recordings.
// stageCheck needs the tasks (E3.7) and saveWork needs the sandbox (E3.4); they are not here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commandNamed } from '@poly/check';
import { ROOT } from './helpers.mjs';

const H = join(ROOT, 'examples', 'harness', 'host', 'handlers');
const url = (f) => pathToFileURL(join(H, f)).href;
const OUT = join(ROOT, '.poly', 'test-build', 'e3-handlers');
mkdirSync(OUT, { recursive: true });

const { verifyReceipt, hashOf, parseReceipt, verify } = await import(url('verify.mjs'));
const { scanText, redact, encodings, scan } = await import(url('scan.mjs'));
const { classifyCalls, classify } = await import(url('classify.mjs'));
const { ArchiveStore, handleText, handlesIn } = await import(url('archive.mjs'));
const { applyCompaction } = await import(url('compact.mjs'));
const { intake } = await import(url('intake.mjs'));

/** A deterministic generator, so that a failure can be replayed. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rewrites the one line of a handler source that carries `// @tag`, and imports the result. */
async function mutant(file, tag, rewrite) {
  const src = readFileSync(join(H, file), 'utf8').split('\n');
  const at = src.map((l, i) => (l.includes(`@${tag}`) ? i : -1)).filter((i) => i >= 0);
  assert.equal(at.length, 1, `@${tag} must mark exactly one line`);
  src[at[0]] = rewrite(src[at[0]]);
  const copy = join(OUT, `${tag}-${file}`);
  const dir = join(OUT, `m-${tag}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(H, dir, { recursive: true });
  writeFileSync(join(dir, file), src.join('\n'));
  void copy;
  return import(pathToFileURL(join(dir, file)).href + `?m=${tag}`);
}

// ---------------------------------------------------------------- the verifier (HT3, S553, HAC4)

const LOG = ['> build', 'src/a.ts(3,5): error TS2322: Type string is not assignable to type number.', 'src/b.ts(9,1): error TS1005: ; expected.', 'Found 2 errors.', 'x'.repeat(400)].join('\n');
const receiptOf = (over = {}) => JSON.stringify({ sourceHash: hashOf(Buffer.from(LOG)), status: 'fail', quotes: ['error TS2322: Type string is not assignable to type number.', 'Found 2 errors.'], ...over });

/** The cases a verifier must get right. Returns the names of the cases it got wrong. */
function verifierSuite(fn) {
  const wrong = [];
  const expect = (name, got, want) => { if (got.ok !== want) wrong.push(name); };
  const run = (receiptText, log = LOG, exitStatus = 1) => fn({ receiptText, log: Buffer.from(log), exitStatus });
  expect('good receipt', run(receiptOf()), true);
  expect('good receipt of a passing run', run(JSON.stringify({ sourceHash: hashOf(Buffer.from('ok\n' + 'y'.repeat(300))), status: 'pass', quotes: ['ok'] }), 'ok\n' + 'y'.repeat(300), 0), true);
  expect('hash of another log', run(receiptOf({ sourceHash: hashOf(Buffer.from('another log')) })), false);
  expect('hash differs in one digit', run(receiptOf({ sourceHash: hashOf(Buffer.from(LOG)).replace(/.$/, (c) => (c === '0' ? '1' : '0')) })), false);
  expect('quote with another case', run(receiptOf({ quotes: ['FOUND 2 ERRORS.'] })), false);
  expect('quote with other whitespace', run(receiptOf({ quotes: ['Found  2 errors.'] })), false);
  expect('quote not in the log', run(receiptOf({ quotes: ['Found 3 errors.'] })), false);
  expect('quote of one wrong byte', run(receiptOf({ quotes: ['Found 2 errorz.'] })), false);
  expect('status pass on a failing run', run(receiptOf({ status: 'pass' })), false);
  expect('status fail on a passing run', run(receiptOf({ status: 'fail' }), LOG, 0), false);
  expect('receipt larger than a tiny log', run(JSON.stringify({ sourceHash: hashOf(Buffer.from('tiny')), status: 'fail', quotes: ['tiny'] }), 'tiny', 1), false);
  expect('receipt not JSON', run('Found 2 errors.'), false);
  expect('receipt with no hash', run(JSON.stringify({ status: 'fail', quotes: [] })), false);
  expect('receipt with an empty quote', run(receiptOf({ quotes: [''] })), false);
  return wrong;
}

test('S553: the verifier gets every case right, and says which checks failed', () => {
  assert.deepEqual(verifierSuite(verifyReceipt), []);
  const r = verifyReceipt({ receiptText: receiptOf({ status: 'pass', quotes: ['nowhere'] }), log: Buffer.from(LOG), exitStatus: 1 });
  assert.deepEqual(r.reasons.sort(), ['quote-not-in-log', 'status-mismatch']);
});

test('S553: the verifier agrees with an independent oracle on 300 generated logs and receipts, quotes altered or not', () => {
  const rnd = prng(20261011);
  const words = ['error', 'warning', 'TS2322', 'passed', 'failed', 'café', '日本語', 'line', '12', 'at', 'src/a.ts', 'FAIL', 'ok'];
  for (let i = 0; i < 300; i++) {
    const log = Array.from({ length: 20 + Math.floor(rnd() * 40) }, () => words[Math.floor(rnd() * words.length)]).join(rnd() < 0.5 ? ' ' : '\n');
    const bytes = Buffer.from(log);
    const a = Math.floor(rnd() * (bytes.length - 8));
    const quote = bytes.subarray(a, a + 3 + Math.floor(rnd() * 6)).toString('utf8');
    if (quote.length === 0 || quote.includes('�')) continue; // a cut inside a multi-byte character is not a quote
    const altered = rnd() < 0.5 ? quote : quote.slice(0, -1) + (quote.endsWith('~') ? '!' : '~');
    const exitStatus = rnd() < 0.5 ? 0 : 2;
    const text = JSON.stringify({ sourceHash: hashOf(bytes), status: exitStatus === 0 ? 'pass' : 'fail', quotes: [altered] });
    const oracle = bytes.includes(Buffer.from(altered)) && Buffer.byteLength(text) < bytes.length;
    assert.equal(verifyReceipt({ receiptText: text, log: bytes, exitStatus }).ok, oracle, JSON.stringify({ i, altered }));
  }
});

const MUTANTS = [
  ['V-hash', 'skips the hash check', (l) => l.replace(/if \(.*\) reasons/, 'if (false) reasons')],
  ['V-quote', 'accepts a quote that is in the log only up to case and spacing', (l) => l.replace(/if \(.*\) reasons/, "if (bytes.toString('utf8').toLowerCase().replace(/\\s+/g, ' ').indexOf(q.toLowerCase().replace(/\\s+/g, ' ')) === -1) reasons")],
  ['V-status', 'ignores the exit status', (l) => l.replace(/if \(.*\) reasons/, 'if (false) reasons')],
  ['V-size', 'accepts a receipt longer than the log', (l) => l.replace(/if \(.*\) reasons/, 'if (false) reasons')],
];

for (const [tag, what, rewrite] of MUTANTS) {
  test(`S553, HAC4: the mutant verifier that ${what} is caught by the suite`, async () => {
    const m = await mutant('verify.mjs', tag, rewrite);
    const wrong = verifierSuite(m.verifyReceipt);
    assert.ok(wrong.length > 0, `the suite did not notice that the verifier ${what}`);
  });
}

test('HAC4: a receipt whose quote is not in the original log is rejected by the handler, as a permanent failure, with no retry', async () => {
  const caps = {
    content: { read: async (h) => h },
    store: { read: async (table, key) => { assert.deepEqual([table, key], ['archive', 'receipt:t:1']); return { log: Buffer.from(LOG).toString('base64'), exitStatus: 1 }; } },
  };
  await verify({ receipt: receiptOf() }, caps, { instanceId: 'receipt:t:1' });
  await assert.rejects(verify({ receipt: receiptOf({ quotes: ['invented'] }) }, caps, { instanceId: 'receipt:t:1' }), (e) => e.permanent === true && /quote-not-in-log/.test(e.message));
});

test('S553: parseReceipt accepts the receipt shape and nothing looser', () => {
  assert.ok(parseReceipt(receiptOf()));
  for (const bad of ['', '[]', 'null', '{"sourceHash":"sha256:ab","status":"pass","quotes":[]}', receiptOf({ status: 'maybe' }), receiptOf({ quotes: 'x' }), receiptOf({ quotes: Array(65).fill('a') })]) assert.equal(parseReceipt(bad), null, bad.slice(0, 40));
});

// ---------------------------------------------------------------- the scan and the redaction (HF3.5, S554)

const CANARY = () => `canary-${randomBytes(12).toString('hex')}`;

test('S554: the scan finds each credential shape, and the known secrets of the vault in four encodings', () => {
  const samples = {
    'aws-access-key': 'key AKIAIOSFODNN7EXAMPLE used',
    'private-key': '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
    bearer: 'Authorization: Bearer abcdefghijklmnopqrstuvwx0123',
    'sk-key': 'OPENAI=sk-abcdefghijklmnopqrstuvwx',
    'github-token': 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r',
    assignment: 'password = hunter2hunter2',
  };
  for (const [kind, text] of Object.entries(samples)) {
    const r = scanText(`before ${text} after`, []);
    assert.equal(r.clean, false, kind);
    assert.ok(r.matches.some((m) => m.kind === kind || m.kind === 'multiple'), `${kind}: ${JSON.stringify(r.matches)}`);
  }
  const token = CANARY();
  for (const e of encodings(token)) assert.equal(scanText(`log line ${e} end`, [token]).clean, false, e);
  assert.equal(scanText('nothing here', [token]).clean, true);
  assert.throws(() => scanText('x', ['short']), /at least 12/);
});

test('S554: ordinary build and test output is not flagged', () => {
  const benign = [
    'Found 2 errors in 1 file.',
    'commit 3f9c2a1b7d4e5f60718293a4b5c6d7e8f9012345 Author: kizo-core',
    'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    'tokenizer loaded, 1024 tokens in the window',
    'the token budget is spent; password policy documented in README',
    'ok 12 - parses the config (4.2ms)',
    'image: ghcr.io/org/app:1.2.3@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'node_modules/.bin/tsc --noEmit -p tsconfig.json',
  ];
  for (const t of benign) assert.equal(scanText(t, []).clean, true, t);
});

test('S554: a redacted text holds nothing of a flagged span and scans clean, on 200 generated outputs', () => {
  const rnd = prng(1011);
  for (let i = 0; i < 200; i++) {
    const token = CANARY();
    const enc = encodings(token)[Math.floor(rnd() * 4)];
    const parts = ['build step', 'AKIAIOSFODNN7EXAMPLE', enc, 'Bearer abcdefghijklmnopqrstuvwx0123', 'done', 'api_key=abcdefgh12345678'];
    const text = parts.filter(() => rnd() < 0.6).concat([enc]).sort(() => rnd() - 0.5).join(rnd() < 0.5 ? ' ' : '\n');
    const r = scanText(text, [token]);
    assert.equal(r.clean, false);
    const red = redact(text, r.matches);
    for (const e of encodings(token)) assert.ok(!red.includes(e), `a ${e.length}-char encoding survived`);
    assert.ok(!red.includes('AKIAIOSFODNN7EXAMPLE') && !red.includes('abcdefgh12345678'));
    assert.equal(scanText(red, [token]).clean, true, 'the redaction itself is clean');
  }
});

test('S554: the scan handler writes the redacted copy only, and a flagged output is a permanent failure', async () => {
  const token = CANARY();
  const written = {};
  const caps = {
    store: {
      read: async (table, key) => { assert.deepEqual([table, key], ['output', 'turn:t:1']); return { text: `ran ok\nTOKEN ${token} leaked\n` }; },
      write: async (table, key, v) => { written[`${table}/${key}`] = v; },
    },
    secrets: { get: async (name) => { assert.equal(name, 'known-secrets'); return JSON.stringify([token]); } },
  };
  await assert.rejects(scan({}, caps, { instanceId: 'turn:t:1' }), (e) => e.permanent === true && /known-secret/.test(e.message));
  assert.deepEqual(Object.keys(written), ['redacted/turn:t:1']);
  assert.ok(!JSON.stringify(written).includes(token));
  const clean = { ...caps, store: { ...caps.store, read: async () => ({ text: 'all good' }) } };
  assert.deepEqual(await scan({}, clean, { instanceId: 'turn:t:2' }), { ok: true });
});

// ---------------------------------------------------------------- the canary over the sinks (S554)

/** Every text the intake of one output left, in the sinks the plan names: the context, the archive, the reader's input, the journal. */
function sinksOf(result, archive) {
  const sinks = { context: result.context, handleForm: result.handleForm ?? '', archivedCopy: result.archived, reader: result.reader ?? '', journal: JSON.stringify(result.journal) };
  sinks.archiveStore = archive.get(result.journal.handle).toString('utf8');
  return sinks;
}
const leaks = (sinks, tokens) => Object.entries(sinks).filter(([, text]) => tokens.some((t) => encodings(t).some((e) => text.includes(e)) || /AKIA[0-9A-Z]{16}/.test(text))).map(([where]) => where);

test('S554: a canary in a tool output, in four encodings, reaches no sink of the intake', () => {
  const token = CANARY();
  const output = ['> npm test', 'plain ' + token, 'b64 ' + Buffer.from(token).toString('base64'), 'b64url ' + Buffer.from(token).toString('base64url'), 'url ' + encodeURIComponent(token), 'aws AKIAIOSFODNN7EXAMPLE', 'z'.repeat(12000)].join('\n');
  const archive = new ArchiveStore();
  const r = intake({ output, secrets: [token], archive });
  assert.equal(r.flagged, true);
  assert.equal(r.reader, null, 'the cheaper reader never sees a flagged output');
  assert.ok(r.handleForm, 'a large output has a handle form');
  assert.deepEqual(leaks(sinksOf(r, archive), [token]), []);
  assert.equal(r.journal.flagged, true);
  assert.ok(r.journal.kinds.length > 0 && !('text' in r.journal), 'the journal records kinds and sizes, never bytes');
});

test('S554: a clean output passes through unchanged, is archived as it is, and goes to the reader over the log threshold', () => {
  const archive = new ArchiveStore();
  const output = 'PASS a\nPASS b\n'.repeat(400);
  const r = intake({ output, secrets: [CANARY()], archive });
  assert.equal(r.flagged, false);
  assert.equal(r.context, output);
  assert.equal(r.archived, output);
  assert.equal(r.reader, output);
  assert.equal(archive.get(r.journal.handle).toString('utf8'), output);
  assert.equal(intake({ output: 'short', secrets: [], archive }).reader, null, 'under the log threshold nothing goes to the reader');
});

test('S554, seeded control: an intake that archives the unredacted output is found by the same canary scan', async () => {
  const m = await mutant('intake.mjs', 'I-archive', (l) => l.replace(/const archived = .*; \/\/ @I-archive/, 'const archived = output; // @I-archive'));
  const token = CANARY();
  const archive = new ArchiveStore();
  const r = m.intake({ output: `run\n${token}\n`, secrets: [token], archive });
  const found = leaks(sinksOf(r, archive), [token]);
  assert.ok(found.includes('archivedCopy') && found.includes('archiveStore'), `the control was not found: ${found.join(',')}`);
});

// ---------------------------------------------------------------- the classifier (HF3.4, S559)

test('S559: an edit then a declared runner is fusable; every other shape stays separate', () => {
  const edit = { tool: 'edit', path: 'src/a.ts' };
  const yes = ['npm test', 'npm run test', 'pnpm build', 'yarn lint', 'node --test test/a.test.mjs', 'pytest -q tests/test_a.py', 'python -m pytest', 'go test ./pkg', 'cargo test --lib', 'make', 'make test', 'tsc --noEmit'];
  for (const command of yes) assert.equal(classifyCalls(JSON.stringify([edit, { tool: 'bash', command }])).fusable, true, command);
  const no = ['cat src/a.ts', 'git diff', 'grep -rn foo .', 'node script.js', 'make deploy', 'npm test && cat out.txt', 'npm test | tee out', 'npm test > out.txt', 'npm test; rm -rf x', 'echo $(npm test)', 'npm install', 'npm test\ncat x'];
  for (const command of no) assert.equal(classifyCalls(JSON.stringify([edit, { tool: 'bash', command }])).fusable, false, command);
  const test1 = { tool: 'bash', command: 'npm test' };
  assert.equal(classifyCalls(JSON.stringify([test1, edit])).fusable, false, 'a command then an edit');
  assert.equal(classifyCalls(JSON.stringify([edit, test1, test1])).fusable, false, 'three calls');
  assert.equal(classifyCalls(JSON.stringify([edit])).fusable, false, 'one call');
  assert.equal(classifyCalls('not json').fusable, false);
});

test('S559: the classify handler completes ok for a fusable call and as a permanent failure for the rest', async () => {
  const kept = [];
  let mech;
  const caps = (text) => ({ content: { read: async () => text }, store: { read: async (t, k) => (t === 'mechanisms' ? mech : undefined), write: async (t, k, v) => { kept.push([t, k, v]); } } });
  await classify({ calls: 'c' }, caps(JSON.stringify([{ tool: 'edit' }, { tool: 'bash', command: 'npm test' }])), { instanceId: 'turn:t:1' });
  await assert.rejects(classify({ calls: 'c' }, caps(JSON.stringify([{ tool: 'edit' }, { tool: 'bash', command: 'cat x' }])), { instanceId: 'turn:t:2' }), (e) => e.permanent === true);
  assert.deepEqual(kept.map(([t, k]) => [t, k]), [['calls', 'turn:t:1'], ['calls', 'turn:t:2']], 'the calls are kept for the act effect either way');
});

// ---------------------------------------------------------------- the archive and the compaction (HF3.3, S561)

test('HF3.3: a handle resolves to the exact bytes of any range while it has a reference, and to nothing after the last is released', () => {
  const a = new ArchiveStore();
  const rnd = prng(7);
  for (let i = 0; i < 100; i++) {
    const buf = randomBytes(1 + Math.floor(rnd() * 3000));
    const id = a.put(buf);
    const s = Math.floor(rnd() * buf.length);
    const e = s + Math.floor(rnd() * (buf.length - s + 1));
    assert.ok(a.get(id, s, e).equals(buf.subarray(s, e)));
    assert.ok(a.get(id).equals(buf));
    assert.throws(() => a.get(id, 0, buf.length + 1), /outside/);
    a.retain(id);
    assert.equal(a.refs(id), 2);
    a.release(id);
    assert.ok(a.get(id).equals(buf), 'one reference left');
    a.release(id);
    assert.throws(() => a.get(id), /resolves to nothing/);
    assert.throws(() => a.release(id), /released more often/);
    assert.throws(() => a.retain(id), /gone/);
  }
});

test('HF2.4: the handle text carries the handle, the size and a head-and-tail excerpt, and names the omission', () => {
  const buf = Buffer.from('HEAD' + 'm'.repeat(5000) + 'TAIL');
  const id = new ArchiveStore().put(buf);
  const t = handleText(id, buf, 16);
  assert.deepEqual(handlesIn(t), [id]);
  assert.match(t, /size=5008 bytes/);
  assert.ok(t.includes('HEAD') && t.includes('TAIL') && /4976 bytes omitted/.test(t));
  assert.ok(t.length < 400);
});

test('S561, HF3.3: a compaction shrinks the transcript, keeps what is pinned, and releases only the handles nothing refers to', () => {
  const a = new ArchiveStore();
  const keepId = a.put(Buffer.from('kept output'.repeat(50)));
  const dropId = a.put(Buffer.from('dropped output'.repeat(50)));
  const sumId = a.put(Buffer.from('summarised output'.repeat(50)));
  const transcript = [
    { role: 'system', text: 'You are a coding agent.', pinned: true },
    { role: 'user', text: 'Fix the failing test.', pinned: true },
    { role: 'tool', text: `[output archived: handle=${dropId} size=700 bytes]` + 'x'.repeat(2000) },
    { role: 'tool', text: `[output archived: handle=${sumId} size=850 bytes]` + 'y'.repeat(2000) },
    { role: 'assistant', text: 'thinking '.repeat(300) },
    { role: 'tool', text: `[output archived: handle=${keepId} size=550 bytes]` },
    { role: 'assistant', text: 'now editing' },
  ];
  const r = applyCompaction({ transcript, summary: `Read the failing build (handle=${sumId}), then...`, keepLast: 2, archive: a });
  assert.ok(r.after < r.before);
  assert.deepEqual(r.transcript.map((m) => m.role), ['system', 'user', 'summary', 'tool', 'assistant']);
  assert.deepEqual(r.released, [dropId]);
  assert.throws(() => a.get(dropId), /resolves to nothing/);
  assert.ok(a.get(sumId).length > 0 && a.get(keepId).length > 0, 'a handle the new transcript mentions still resolves');
});

test('S561: a compaction that does not shrink the transcript is refused, and releases nothing', () => {
  const a = new ArchiveStore();
  const id = a.put(Buffer.from('out'));
  const transcript = [{ role: 'system', text: 's', pinned: true }, { role: 'tool', text: `handle=${id}` }];
  assert.throws(() => applyCompaction({ transcript, summary: 'a summary that is longer than what it replaces', keepLast: 0, archive: a }), (e) => e.permanent === true && /does not shrink/.test(e.message));
  assert.ok(a.get(id).length > 0);
});

// ---------------------------------------------------------------- the lint (PT6.5)

test('PT6.5: the handler files pass `poly lint handlers`, which refuses ambient authority', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'poly-e3-lint-'));
  try {
    mkdirSync(join(dir, 'src', 'handlers'), { recursive: true });
    cpSync(H, join(dir, 'src', 'handlers'), { recursive: true });
    cpSync(join(ROOT, 'examples', 'hello', 'hello.poly'), join(dir, 'src', 'hello.poly'));
    const names = ['verify', 'scan', 'classify', 'tools', 'archive', 'compact', 'intake'].map((n) => `src/handlers/${n}.mjs`);
    writeFileSync(join(dir, 'poly.json'), JSON.stringify({ poly: '1', name: 'harness-handlers', modules: ['src/*.poly'], handlers: names }));
    const r = await commandNamed('lint').run({ project: dir });
    assert.equal(r.result.verdict, 'CLEAN', JSON.stringify(r.result.diagnostics));
    // the control: a handler that reads the file system is refused
    writeFileSync(join(dir, 'src', 'handlers', 'bad.mjs'), "import { readFileSync } from 'node:fs';\nexport const x = readFileSync;\n");
    writeFileSync(join(dir, 'poly.json'), JSON.stringify({ poly: '1', name: 'harness-handlers', modules: ['src/*.poly'], handlers: [...names, 'src/handlers/bad.mjs'] }));
    const bad = await commandNamed('lint').run({ project: dir });
    assert.notEqual(bad.result.verdict, 'CLEAN');
    assert.ok(bad.result.diagnostics.some((d) => d.code === 'PL6401'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void createHash;

test('Q-E3-2: with action fusion switched off the classifier says separate for a call it would otherwise fuse', async () => {
  const calls = JSON.stringify([{ tool: 'edit' }, { tool: 'bash', command: 'npm test' }]);
  const caps = (cfg) => ({ content: { read: async () => calls }, store: { read: async (t) => (t === 'mechanisms' ? cfg : undefined), write: async () => {} } });
  assert.deepEqual(await classify({ calls: 'c' }, caps({ fusion: true }), { instanceId: 'turn:t:1' }), { ok: true });
  await assert.rejects(classify({ calls: 'c' }, caps({ fusion: false }), { instanceId: 'turn:t:1' }), (e) => e.permanent === true && /switched off/.test(e.message));
});
