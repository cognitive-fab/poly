// M7.3 (PS21, PT31): `poly propose`. A first version of this file came from a separate writer; it was replaced by the
// implementer because its stand-in wrote no proposal (so most tests could not reach their assertions), it invented messages
// the spec does not give, and it did not check the temporary home, the environment or the leak paths. This version is the
// implementer's, written from PT31.1 to PT31.9 and the normative example (docs/m7/proposal-example.*), and the audit reads it
// against the spec without the code. Real polyness runs for the shape test (R1), the careless history and the canary; a
// stand-in that replays polyness's real output (test/fixtures/m7/polyness-git-push, captured from the real tool on the
// default transcripts) does the seam, temporary-home and refusal cases, because it can record how it was started.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalize } from '@poly/core';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';
import { writeTranscripts } from './fixtures/m7/make-transcripts.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const POLYNESS = process.env.POLY_POLYNESS_DIR ?? join(ROOT, '..', 'polyness');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'm7', 'polyness-git-push');
const EXAMPLE_POLY = readFileSync(join(ROOT, 'test', 'fixtures', 'm7', 'proposal-example.poly'), 'utf8');
const EXAMPLE_JSON = JSON.parse(readFileSync(join(ROOT, 'docs', 'm7', 'proposal-example.json'), 'utf8'));
const HOME_PREFIX = 'poly-polyness-home-';
const slash = (p) => p.split(String.fromCharCode(92)).join('/');
const NL = String.fromCharCode(10);
const OS_ADDED = process.platform === 'win32' ? ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'USERDOMAIN', 'USERNAME', 'WINDIR'] : [];
const ALLOWED = ['PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'HOME', 'USERPROFILE', ...OS_ADDED];
const LEAKS = ['CANARY-7f3a9c1e', '/home/someone', 'private-shop', 'release-main', 'sess-secret', 'acme/shop.git', 'ship the change'];

const poly = (args, env) => {
  try { return { code: 0, out: execFileSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...args], { encoding: 'utf8', ...(env ? { env } : {}) }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; }
};

let tmp; let transcripts; let realPin; let n = 0;
before(() => {
  assert.ok(existsSync(join(POLYNESS, 'bin', 'polyness.mjs')), `polyness is expected at ${POLYNESS}`);
  assert.ok(existsSync(FIXTURE), 'the captured polyness output is a fixture of this milestone');
  tmp = mkdtempSync(join(tmpdir(), 'poly-propose-'));
  transcripts = writeTranscripts(join(tmp, 'transcripts'), 'default');
  realPin = join(tmp, 'real.pin.json');
  const r = poly(['propose', '--pin-polyness', '--polyness', POLYNESS, '--polyness-pin', realPin]);
  assert.equal(r.code, 0, r.out);
});
after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

const homesLeft = () => readdirSync(tmpdir()).filter((x) => x.startsWith(HOME_PREFIX)).sort();
const fixtureFiles = () => Object.fromEntries(readdirSync(FIXTURE).map((f) => [f, readFileSync(join(FIXTURE, f), 'utf8')]));
const tree = (dir) => readdirSync(dir, { recursive: true }).map(slash).sort();

/** A stand-in polyness. It logs how it was started, then replays real polyness output (or misbehaves, by mode). */
function fake({ mode = 'ok', slug = 'git-push', files = fixtureFiles() } = {}) {
  const dir = join(tmp, `fake-${++n}`);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  const log = join(dir, 'starts.log');
  const lines = [
    "import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';",
    "import { createHash } from 'node:crypto';",
    "import { join } from 'node:path';",
    `const LOG = ${JSON.stringify(log)}; const FILES = ${JSON.stringify(files)}; const SLUG = ${JSON.stringify(slug)}; const MODE = ${JSON.stringify(mode)};`,
    'const home = process.env.HOME; const tree = []; const copied = {};',
    "const walk = (d, p) => { for (const e of readdirSync(d, { withFileTypes: true })) { const rel = p + e.name; tree.push(rel); if (e.isDirectory()) walk(join(d, e.name), rel + '/'); else copied[rel] = createHash('sha256').update(readFileSync(join(d, e.name))).digest('hex'); } };",
    "walk(home, '');",
    'appendFileSync(LOG, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), tree, copied }) + String.fromCharCode(10));',
    "if (MODE === 'hang') { setInterval(() => {}, 1000); await new Promise(() => {}); }",
    "if (MODE === 'fail') { console.error('polyness failed on purpose'); process.exit(3); }",
    "if (MODE === 'flood') { console.log('x'.repeat(200000)); process.exit(0); }",
    "if (MODE === 'nothing') { console.log(\"No step 'git status' with enough history to propose from.\"); process.exit(0); }",
    "const out = join(process.cwd(), '.polyness', 'proposals', SLUG + '-checked'); mkdirSync(out, { recursive: true });",
    "let leak = '';",
    "if (MODE === 'leak') { const d = join(home, '.claude', 'projects', 'project'); const t = readFileSync(join(d, readdirSync(d).sort()[0]), 'utf8'); leak = [t.match(/CANARY-[0-9a-f]+/)[0], '/home/someone/private-shop', 'sess-secret-00', 'release-main', 'acme/shop.git', 'ship the change'].join(' '); }",
    "for (const [name, text] of Object.entries(FILES)) {",
    "  let body = text;",
    "  if (MODE === 'leak' && name.endsWith('.json')) { const o = JSON.parse(text); o.leak = leak; o.description = leak; body = JSON.stringify(o, null, 2); }",
    "  else if (MODE === 'leak') body = text.split('// own evidence:').join('// ' + leak + String.fromCharCode(10) + '    // own evidence:') + String.fromCharCode(10) + '// ' + leak + String.fromCharCode(10);",
    "  writeFileSync(join(out, name), body);",
    '}',
    "console.log('wrote ' + out.length);",
  ];
  writeFileSync(join(dir, 'bin', 'polyness.mjs'), lines.join(NL));
  const starts = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split(NL).filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, starts };
}

const pinOf = (dir) => { const pin = join(tmp, `pin-${++n}.json`); const r = poly(['propose', '--pin-polyness', '--polyness', dir, '--polyness-pin', pin]); assert.equal(r.code, 0, r.out); return pin; };
const run = (dir, pin, extra = [], env, step = 'git push', from = transcripts) => {
  const out = join(tmp, `out-${++n}`);
  return { dir: out, ...poly(['propose', '--polyness', dir, '--step', step, '--transcripts', from, '--polyness-pin', pin, '--out', out, ...extra], env) };
};
const allText = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(e.parentPath ?? e.path, e.name), 'utf8')).join(NL);

// ── R1, R2: the normative example and determinism ───────────────────────────────────────────────────────────────
test('PT31.5a: real polyness over the default transcripts gives test/fixtures/m7/proposal-example.poly byte for byte, and the evidence of proposal-example.json', () => {
  const r = run(POLYNESS, realPin);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(tree(r.dir), ['proposal.json', 'src', 'src/git_push.poly']);
  assert.equal(readFileSync(join(r.dir, 'src', 'git_push.poly'), 'utf8'), EXAMPLE_POLY);
  const got = JSON.parse(readFileSync(join(r.dir, 'proposal.json'), 'utf8'));
  const pin = JSON.parse(readFileSync(realPin, 'utf8'));
  assert.equal(pin.name, 'polyness');
  assert.deepEqual(Object.keys(pin.files).sort(), ['bin/polyness.mjs', 'src/normalise.mjs', 'src/propose.mjs', 'src/reader.mjs', 'src/rules.mjs']);
  assert.equal(got.tool.version, pin.version);
  assert.equal(got.tool.pin, `sha256:${createHash('sha256').update(canonicalize(pin), 'utf8').digest('hex')}`, 'the digest of the canonical JSON of the pin');
  const want = { ...EXAMPLE_JSON, tool: { ...EXAMPLE_JSON.tool, version: pin.version, pin: got.tool.pin }, corpus: { ...EXAMPLE_JSON.corpus, kind: 'recorded' } };
  assert.deepEqual(got, want);
  // The proposal is a project that checks CLEAN: the machine keeps every path property it was given (PS21.2).
  const proj = join(tmp, `proj-${++n}`);
  mkdirSync(join(proj, 'src'), { recursive: true });
  writeFileSync(join(proj, 'src', 'git_push.poly'), EXAMPLE_POLY);
  writeFileSync(join(proj, 'poly.json'), JSON.stringify({ poly: '1', name: 'proposal', modules: ['src/*.poly'] }));
  const c = poly(['check', proj]);
  assert.equal(c.code, 0, c.out);
  assert.match(c.out, /CLEAN/);
});

test('PT31.5a: --synthetic labels the corpus synthetic and changes nothing else', () => {
  const f = fake();
  const pin = pinOf(f.dir);
  const a = run(f.dir, pin);
  const b = run(f.dir, pin, ['--synthetic']);
  assert.equal(a.code, 0, a.out);
  assert.equal(b.code, 0, b.out);
  const ja = JSON.parse(readFileSync(join(a.dir, 'proposal.json'), 'utf8'));
  const jb = JSON.parse(readFileSync(join(b.dir, 'proposal.json'), 'utf8'));
  assert.equal(ja.corpus.kind, 'recorded');
  assert.equal(jb.corpus.kind, 'synthetic');
  assert.deepEqual({ ...jb, corpus: { ...jb.corpus, kind: 'recorded' } }, ja);
  assert.equal(readFileSync(join(a.dir, 'src', 'git_push.poly'), 'utf8'), readFileSync(join(b.dir, 'src', 'git_push.poly'), 'utf8'));
});

test('PT31.1: the same transcripts give the same bytes, and a stand-in replaying polyness gives the normative example too', () => {
  const f = fake();
  const pin = pinOf(f.dir);
  const a = run(f.dir, pin);
  const b = run(f.dir, pin);
  assert.equal(a.code, 0, a.out);
  assert.equal(b.code, 0, b.out);
  for (const file of ['src/git_push.poly', 'proposal.json']) assert.equal(readFileSync(join(a.dir, file), 'utf8'), readFileSync(join(b.dir, file), 'utf8'), file);
  assert.equal(readFileSync(join(a.dir, 'src', 'git_push.poly'), 'utf8'), EXAMPLE_POLY);
});

// ── R3: what the derived machine means, through the checker ─────────────────────────────────────────────────────
test('PS21.2: a path property the derived machine contradicts is PL4001 with a witness, and the proposed ones hold', () => {
  const proj = join(tmp, `proj-${++n}`);
  mkdirSync(join(proj, 'src'), { recursive: true });
  writeFileSync(join(proj, 'poly.json'), JSON.stringify({ poly: '1', name: 'proposal', modules: ['src/*.poly'] }));
  writeFileSync(join(proj, 'src', 'git_push.poly'), EXAMPLE_POLY);
  assert.equal(poly(['check', proj]).code, 0, 'the control: the proposal as proposed is clean');
  writeFileSync(join(proj, 'src', 'git_push.poly'), EXAMPLE_POLY.replace('  // proposed: git-push-implies-a-prior-git-add', '  path property bad: before("git-push", "git-add")\n  // proposed: git-push-implies-a-prior-git-add'));
  const c = poly(['check', proj]);
  assert.notEqual(c.code, 0, c.out);
  assert.match(c.out, /PL4001/);
  assert.match(c.out, /bad/);
});

// ── R4: a history with no verification, and a step with no history ──────────────────────────────────────────────
test('PS21.3: the careless history has no verify rule and no verify step; the proposal is still a clean machine', () => {
  const careless = writeTranscripts(join(tmp, `careless-${++n}`), 'careless');
  const r = run(POLYNESS, realPin, [], undefined, 'git push', careless);
  assert.equal(r.code, 0, r.out);
  const j = JSON.parse(readFileSync(join(r.dir, 'proposal.json'), 'utf8'));
  assert.deepEqual(j.steps, ['git-add', 'git-commit', 'git-push']);
  assert.ok(!j.rules.some((x) => x.name === 'no-git-push-without-a-passing-verify'));
  assert.ok(!readFileSync(join(r.dir, 'src', 'git_push.poly'), 'utf8').includes('npm_test'));
  const proj = join(tmp, `proj-${++n}`);
  mkdirSync(join(proj, 'src'), { recursive: true });
  cpSync(join(r.dir, 'src', 'git_push.poly'), join(proj, 'src', 'git_push.poly'));
  writeFileSync(join(proj, 'poly.json'), JSON.stringify({ poly: '1', name: 'proposal', modules: ['src/*.poly'] }));
  const c = poly(['check', proj]);
  assert.equal(c.code, 0, c.out);
});

test('PT31.9: a step with too little history is "polyness proposed nothing" with its reason, exit 2, nothing written', () => {
  const r = run(POLYNESS, realPin, [], undefined, 'git status');
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /poly: polyness proposed nothing: /);
  assert.ok(!existsSync(r.dir));
  const f = fake({ mode: 'nothing' });
  const s = run(f.dir, pinOf(f.dir));
  assert.equal(s.code, 2, s.out);
  assert.match(s.out, /poly: polyness proposed nothing: No step 'git status' with enough history/);
  assert.ok(!existsSync(s.dir));
});

// ── R5, R9: screening and the canary ────────────────────────────────────────────────────────────────────────────
test('PS21.5, C4: a token planted in a transcript reaches neither the source nor the evidence (real polyness)', () => {
  const canary = writeTranscripts(join(tmp, `canary-${++n}`), 'canary');
  assert.ok(readdirSync(canary).some((f) => readFileSync(join(canary, f), 'utf8').includes('CANARY-7f3a9c1e')), 'the control: the token is in the copies polyness reads');
  const r = run(POLYNESS, realPin, [], undefined, 'git push', canary);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(tree(r.dir), ['proposal.json', 'src', 'src/git_push.poly']);
  const text = allText(r.dir);
  for (const leak of LEAKS) assert.ok(!text.includes(leak), `${leak} reached the proposal`);
});

test('PS21.5, C4: a polyness that copies the transcripts into every file it writes still leaks nothing into the proposal', () => {
  const canary = writeTranscripts(join(tmp, `canary-${++n}`), 'canary');
  const f = fake({ mode: 'leak' });
  const r = run(f.dir, pinOf(f.dir), [], undefined, 'git push', canary);
  assert.equal(r.code, 0, r.out);
  const written = f.starts();
  assert.equal(written.length, 1);
  const text = allText(r.dir);
  for (const leak of LEAKS) assert.ok(!text.includes(leak), `${leak} reached the proposal`);
  assert.equal(readFileSync(join(r.dir, 'src', 'git_push.poly'), 'utf8'), EXAMPLE_POLY, 'what polyness added outside the templates is not read');
});

test('PS21.5, PT31.9: a step name that is not one to four lower-case words of letters and digits is refused by its position, never by its text', () => {
  const bad = ['Git Push', 'src/main', 'a'.repeat(40), 'one-two-three-four-five'];
  const ok = fixtureFiles();
  const flow = JSON.parse(ok['polyflow.workflow.json']);
  for (const name of bad) {
    const tools = {};
    let k = 0;
    for (const [key, value] of Object.entries(flow.tools)) tools[k++ === 1 ? name : key] = value;
    const f = fake({ files: { ...ok, 'polyflow.workflow.json': JSON.stringify({ ...flow, tools }) } });
    const r = run(f.dir, pinOf(f.dir));
    assert.equal(r.code, 2, `${name}: ${r.out}`);
    assert.match(r.out, /poly: polyness named a step that is not one to four words of lower-case letters and digits \(step 2 of the workflow\)/);
    assert.ok(!r.out.includes(name), `${name} is repeated in the message`);
    assert.ok(!existsSync(r.dir));
  }
  const f = fake();
  assert.equal(run(f.dir, pinOf(f.dir)).code, 0, 'the control: the unchanged workflow is accepted');
  for (const step of ['Git Push', 'git/push', 'a'.repeat(33), 'a-b-c-d-e']) {
    const r = run(f.dir, pinOf(f.dir), [], undefined, step);
    assert.equal(r.code, 64, r.out);
    assert.match(r.out, /poly: --step is one to four words of lower-case letters and digits, at most 32 characters/);
    assert.ok(!r.out.includes(step), `${step} is repeated in the message`);
  }
});

// ── R6: the four templates, and nothing else ────────────────────────────────────────────────────────────────────
test('C1, PT31.4: a predicate matching none of the four templates, and an entry without its evidence, are listed with a reason and give no path property; no JavaScript is run', () => {
  const sentinel = join(tmp, `ran-${++n}.txt`);
  const files = fixtureFiles();
  let inv = files['effect-invariants.mjs'];
  const swap = (a, b) => { assert.ok(inv.includes(a), a); inv = inv.replace(a, b); };
  swap("pred: (path) => path.count('git-push') <= 1,", "pred: (path) => path.count('git-push') === 7,");
  swap("    // own evidence: 16 of 16 per run.\n    // git add came first every time it mattered\n", '    // git add came first every time it mattered\n');
  swap("name: 'git-push-implies-a-prior-git-commit',\n    pred: (path) => path.emitted.every((e) => e.kind !== 'git-push' || path.emitted.some((s) => s.kind === 'git-commit' && s.step < e.step)),", `name: 'git-push-implies-a-prior-git-commit',\n    pred: (path) => { process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'x'); return true; },`);
  const f = fake({ files: { ...files, 'effect-invariants.mjs': inv } });
  const r = run(f.dir, pinOf(f.dir));
  assert.equal(r.code, 0, r.out);
  const j = JSON.parse(readFileSync(join(r.dir, 'proposal.json'), 'utf8'));
  const names = j.notTranslatable.map((x) => x.name);
  for (const name of ['at-most-one-git-push-per-run', 'git-push-implies-a-prior-git-add', 'git-push-implies-a-prior-git-commit']) assert.ok(names.includes(name), `${name} is listed`);
  const reason = (name) => j.notTranslatable.find((x) => x.name === name).reason;
  assert.match(reason('at-most-one-git-push-per-run'), /at-most-one-git-push-per-run.*matches no template/);
  assert.match(reason('git-push-implies-a-prior-git-commit'), /git-push-implies-a-prior-git-commit.*matches no template/);
  assert.match(reason('git-push-implies-a-prior-git-add'), /own evidence/);
  assert.deepEqual(j.rules.map((x) => x.name), ['no-git-push-without-a-passing-verify']);
  const src = readFileSync(join(r.dir, 'src', 'git_push.poly'), 'utf8');
  assert.equal((src.match(/path property /g) ?? []).length, 1);
  for (const text of [src, JSON.stringify(j)]) for (const js of ['===', 'getBuiltinModule', 'writeFileSync', '=>']) assert.ok(!text.includes(js), `${js} reached the proposal`);
  assert.ok(!existsSync(sentinel), 'the JavaScript of the predicate was run');
});

// ── R7: the seam ────────────────────────────────────────────────────────────────────────────────────────────────
test('PT31.3: the argument vector is fixed, the environment is the allowlist with HOME and USERPROFILE set to the working directory, and nothing of the parent reaches the child', () => {
  const f = fake();
  const pin = pinOf(f.dir);
  const planted = { POLY_PLANTED_TOKEN: 'PLANTED-ONE', ANTHROPIC_API_KEY: 'PLANTED-TWO', GITHUB_TOKEN: 'PLANTED-THREE', SSH_AUTH_SOCK: 'PLANTED-FOUR', POLYNESS_MODEL: 'PLANTED-FIVE' };
  const r = run(f.dir, pin, [], { ...process.env, ...planted });
  assert.equal(r.code, 0, r.out);
  const [s] = f.starts();
  assert.deepEqual(s.argv, ['propose', 'git push', 'project']);
  for (const k of Object.keys(s.env)) assert.ok(ALLOWED.includes(k.toUpperCase()), `${k} reached the child`);
  assert.ok(Object.keys(s.env).some((k) => k.toUpperCase() === 'PATH'));
  assert.ok(!JSON.stringify(s.env).includes('PLANTED'));
  assert.equal(s.env.HOME, s.env.USERPROFILE);
  assert.equal(s.env.HOME, s.cwd);
});

test('PT31.3, PT31.9: no pin is a usage error that starts nothing; a changed file is refused, naming it, before any start; a pin of another polyness needs --repin-polyness', () => {
  const f = fake();
  const missing = join(tmp, 'no-such.pin.json');
  const r = run(f.dir, missing);
  assert.equal(r.code, 64, r.out);
  assert.ok(r.out.includes(`poly: no polyness pin at ${missing}: run poly propose --pin-polyness first`) || r.out.includes(`poly: no polyness pin at ${slash(missing)}: run poly propose --pin-polyness first`), r.out);
  assert.equal(f.starts().length, 0);

  const pin = pinOf(f.dir);
  assert.equal(run(f.dir, pin).code, 0, 'the control: with the pin it starts');
  assert.equal(f.starts().length, 1);
  appendFileSync(join(f.dir, 'bin', 'polyness.mjs'), NL + '// changed' + NL);
  const t = run(f.dir, pin);
  assert.equal(t.code, 2, t.out);
  assert.match(t.out, /poly: the polyness at .* is not the pinned one: bin\/polyness\.mjs differs from the pin \(PT31\.3\)/);
  assert.equal(f.starts().length, 1, 'nothing was started');
  assert.ok(!existsSync(t.dir));

  const again = join(tmp, `again-${++n}.json`);
  assert.equal(poly(['propose', '--pin-polyness', '--polyness', f.dir, '--polyness-pin', again]).code, 0);
  const before = readFileSync(again, 'utf8');
  assert.equal(poly(['propose', '--pin-polyness', '--polyness', f.dir, '--polyness-pin', again]).code, 0, 'pinning twice is the same');
  assert.equal(readFileSync(again, 'utf8'), before);
  const other = fake();
  const w = poly(['propose', '--pin-polyness', '--polyness', other.dir, '--polyness-pin', again]);
  assert.equal(w.code, 64, w.out);
  assert.match(w.out, /pins another polyness than the one at .*: use --repin-polyness to replace it/);
  assert.equal(readFileSync(again, 'utf8'), before, 'the pin is untouched');
  assert.equal(poly(['propose', '--repin-polyness', '--polyness', other.dir, '--polyness-pin', again]).code, 0);
  assert.notEqual(readFileSync(again, 'utf8'), before);
  assert.equal(f.starts().length, 1, 'pinning starts nothing');
  assert.equal(other.starts().length, 0);
});

test('PT31.3: every one of the five files poly depends on is pinned: a change to any of them is refused, naming it (a copy of the real polyness)', () => {
  const copy = join(tmp, `polyness-copy-${++n}`);
  cpSync(POLYNESS, copy, { recursive: true, filter: (p) => !/(^|[\\/])(\.git|node_modules|\.polyness)([\\/]|$)/.test(relative(POLYNESS, p)) });
  const pin = pinOf(copy);
  assert.equal(run(copy, pin).code, 0, 'the control: the unchanged copy runs');
  for (const file of ['src/propose.mjs', 'src/rules.mjs', 'src/reader.mjs', 'src/normalise.mjs', 'bin/polyness.mjs']) {
    const path = join(copy, ...file.split('/'));
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, original + NL + '// changed' + NL);
    const r = run(copy, pin);
    writeFileSync(path, original);
    assert.equal(r.code, 2, `${file}: ${r.out}`);
    assert.ok(r.out.includes(`${file} differs from the pin`), `${file}: ${r.out}`);
  }
  assert.equal(run(copy, pin).code, 0, 'restored, it runs again');
});

test('PT31.3: a child that never answers is stopped at --timeout; output past --max-output is refused; a failing child is reported; each leaves no output and no temporary home', () => {
  const before = homesLeft();
  const hang = fake({ mode: 'hang' });
  const t = run(hang.dir, pinOf(hang.dir), ['--timeout', '2']);
  assert.equal(t.code, 2, t.out);
  assert.match(t.out, /poly: polyness did not finish within 2 s and was stopped/);
  assert.ok(!existsSync(t.dir));
  const flood = fake({ mode: 'flood' });
  const c = run(flood.dir, pinOf(flood.dir), ['--max-output', '1000']);
  assert.equal(c.code, 2, c.out);
  assert.match(c.out, /poly: polyness wrote more than 1000 bytes, the cap on its output, and was stopped/);
  assert.ok(!existsSync(c.dir));
  const fail = fake({ mode: 'fail' });
  const e = run(fail.dir, pinOf(fail.dir));
  assert.equal(e.code, 2, e.out);
  assert.match(e.out, /poly: polyness failed: polyness failed on purpose/);
  assert.ok(!existsSync(e.dir));
  assert.ok(hang.starts().length <= 1, 'the hang was started at most once (under load it may be stopped before its script logs)');
  assert.equal(flood.starts().length, 1, 'the flood was started once');
  assert.equal(fail.starts().length, 1, 'the failure was started once');
  assert.deepEqual(homesLeft(), before, 'no temporary home is left, after a timeout, an overrun or a failure');
});

// ── R8: the temporary home ──────────────────────────────────────────────────────────────────────────────────────
test('PT31.8: the temporary home is fresh, holds only the copied transcripts the run selected, is the working directory, and is gone afterwards', () => {
  const from = join(tmp, `selected-${++n}`);
  writeTranscripts(from, 'default');
  writeFileSync(join(from, 'notes.txt'), 'not a transcript');
  mkdirSync(join(from, 'nested'));
  writeFileSync(join(from, 'nested', 'deep.jsonl'), '{}' + NL);
  const wanted = readdirSync(from).filter((x) => x.endsWith('.jsonl')).sort();
  const f = fake();
  const pin = pinOf(f.dir);
  const before = homesLeft();
  const a = run(f.dir, pin, [], undefined, 'git push', from);
  const b = run(f.dir, pin, [], undefined, 'git push', from);
  assert.equal(a.code, 0, a.out);
  assert.equal(b.code, 0, b.out);
  const [s1, s2] = f.starts();
  assert.notEqual(s1.cwd, s2.cwd, 'a fresh home for each run');
  for (const s of [s1, s2]) {
    const home = realpathSync.native(dirname(s.cwd));
    assert.equal(home.toLowerCase(), realpathSync.native(tmpdir()).toLowerCase(), 'a folder of the temporary directory');
    assert.ok(basename(s.cwd).startsWith(HOME_PREFIX));
    assert.notEqual(slash(s.cwd).toLowerCase(), slash(userInfo().homedir).toLowerCase(), 'not the real home');
    for (const dir of [from, a.dir, b.dir, f.dir]) assert.ok(relative(dir, s.cwd).startsWith('..'), `inside ${dir}`);
    const files = Object.keys(s.copied).sort();
    assert.deepEqual(files, wanted.map((x) => `.claude/projects/project/${x}`), 'only the selected transcripts, nothing else');
    for (const x of wanted) assert.equal(s.copied[`.claude/projects/project/${x}`], createHash('sha256').update(readFileSync(join(from, x))).digest('hex'), `${x} is a copy`);
    assert.deepEqual(s.tree.filter((x) => !x.endsWith('.jsonl')).sort(), ['.claude', '.claude/projects', '.claude/projects/project'], 'no configuration, credentials, .ssh, .git or other .claude entry');
  }
  assert.ok(!existsSync(s1.cwd) && !existsSync(s2.cwd), 'the homes are gone after a successful run');
  assert.deepEqual(homesLeft(), before);
});

test('PT31.8: a file in the real home is never read or copied, whatever the real home is', () => {
  const real = join(tmp, `real-home-${++n}`);
  mkdirSync(join(real, '.claude', 'projects', 'other'), { recursive: true });
  mkdirSync(join(real, '.ssh'), { recursive: true });
  writeFileSync(join(real, '.claude', 'projects', 'other', 'secret.jsonl'), 'SENTINEL-TRANSCRIPT-TOKEN' + NL);
  writeFileSync(join(real, '.ssh', 'id_sentinel'), 'SENTINEL-KEY-TOKEN');
  writeFileSync(join(real, 'sentinel.txt'), 'SENTINEL-FILE-TOKEN');
  const snapshot = () => JSON.stringify(readdirSync(real, { recursive: true }).map(slash).sort());
  const was = snapshot();
  const f = fake();
  const r = run(f.dir, pinOf(f.dir), [], { ...process.env, HOME: real, USERPROFILE: real });
  assert.equal(r.code, 0, r.out);
  const [s] = f.starts();
  const seen = JSON.stringify(s);
  assert.ok(!seen.includes('SENTINEL') && !seen.includes('secret.jsonl') && !seen.includes('id_sentinel') && !seen.includes('other'), 'the child saw nothing of the real home');
  assert.ok(!slash(s.cwd).startsWith(slash(real)), 'its home is not under the real one');
  assert.ok(!allText(r.dir).includes('SENTINEL'));
  assert.equal(snapshot(), was, 'the real home is as it was');
  assert.equal(readFileSync(join(real, 'sentinel.txt'), 'utf8'), 'SENTINEL-FILE-TOKEN');
});

test('PT31.8: when the pin refuses, no temporary home is made or left', () => {
  const f = fake();
  const pin = pinOf(f.dir);
  appendFileSync(join(f.dir, 'bin', 'polyness.mjs'), NL + '// changed' + NL);
  const before = homesLeft();
  assert.equal(run(f.dir, pin).code, 2);
  assert.deepEqual(homesLeft(), before);
  assert.equal(f.starts().length, 0);
});

// ── R10, R11, R12 ───────────────────────────────────────────────────────────────────────────────────────────────
test('PT31.1, PT31.9: each missing option is a usage error naming it; --out that exists is not overwritten; a folder with no transcripts and one with no entry point are refused', () => {
  const f = fake();
  const pin = pinOf(f.dir);
  const make = (omit) => {
    const o = { '--polyness': f.dir, '--step': 'git push', '--transcripts': transcripts, '--polyness-pin': pin, '--out': join(tmp, `o-${++n}`) };
    delete o[omit];
    return ['propose', ...Object.entries(o).flat()];
  };
  assert.equal(poly(make(null)).code, 0, 'the control: the whole command succeeds');
  for (const flag of ['--polyness', '--step', '--transcripts', '--out']) {
    const r = poly(make(flag));
    assert.equal(r.code, 64, `${flag}: ${r.out}`);
    assert.ok(r.out.includes(flag), `${flag}: ${r.out}`);
  }
  const exists = join(tmp, `exists-${++n}`);
  mkdirSync(exists);
  const e = poly(['propose', '--polyness', f.dir, '--step', 'git push', '--transcripts', transcripts, '--polyness-pin', pin, '--out', exists]);
  assert.equal(e.code, 64, e.out);
  assert.match(e.out, /poly: propose does not overwrite a file or folder: .* exists/);
  assert.deepEqual(readdirSync(exists), []);
  const empty = join(tmp, `empty-${++n}`);
  mkdirSync(empty);
  const t = run(f.dir, pin, [], undefined, 'git push', empty);
  assert.equal(t.code, 64, t.out);
  assert.match(t.out, /--transcripts/);
  const bare = join(tmp, `bare-${++n}`);
  mkdirSync(bare);
  const b = run(bare, pin);
  assert.equal(b.code, 2, b.out);
  assert.match(b.out, /poly: .* has no bin\/polyness\.mjs: it is the directory of a polyness checkout/);
});

test('PS21.2, PT31.5a: a two-step workflow gets the machine derived from the same rules by analogy (exact text), and it checks CLEAN', () => {
  const lint = {
    'contract.json': JSON.stringify({ lang: 'javascript' }),
    'polyflow.workflow.json': JSON.stringify({ name: 'deploy-checked', tools: { lint: { tool: 'Bash' }, deploy: { tool: 'Bash' } } }),
    'effect-invariants.mjs': ["export const effectInvariants = [", "  {", "    // own evidence: 10 of 10 per run.", "    // a second deploy in one run is a duplicate", "    name: 'at-most-one-deploy-per-run',", "    pred: (path) => path.count('deploy') <= 1,", "  },", "];", ''].join(NL),
    'NOTES.md': 'notes',
  };
  const f = fake({ slug: 'deploy', files: lint });
  const r = run(f.dir, pinOf(f.dir), [], undefined, 'deploy');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(tree(r.dir), ['proposal.json', 'src', 'src/deploy.poly']);
  const header = '// Proposed by poly propose from 10 instances of deploy (PS21). Every effect is declared with the label exec and no class: a person declares each consequence (S503).' + NL;
  const want = header + readFileSync(join(ROOT, 'test', 'proposal-admission.test.mjs'), 'utf8').split('const SECOND_SOURCE = `')[1].split('`;')[0];
  assert.equal(readFileSync(join(r.dir, 'src', 'deploy.poly'), 'utf8'), want);
  const proj = join(tmp, `proj-${++n}`);
  mkdirSync(join(proj, 'src'), { recursive: true });
  writeFileSync(join(proj, 'src', 'deploy.poly'), want);
  writeFileSync(join(proj, 'poly.json'), JSON.stringify({ poly: '1', name: 'proposal', modules: ['src/*.poly'] }));
  const c = poly(['check', proj]);
  assert.equal(c.code, 0, c.out);
});

test('PT31.7: propose is in the command registry, is not served over MCP, and is built', async () => {
  const { commandNamed, NOT_BUILT } = await import('@poly/check');
  const c = commandNamed('propose');
  assert.ok(c, 'commandNamed("propose")');
  assert.equal(c.mcp, null);
  assert.ok(!NOT_BUILT.some((x) => x.name === 'propose' || x === 'propose'));
  const agent = await import('@poly/agent');
  const names = agent.mcpTools().map((t) => t.name);
  assert.ok(!names.some((x) => /propose/.test(x)), names.join(', '));
});
