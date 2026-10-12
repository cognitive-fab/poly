// M7.2 (PT30.10, S507): the seam to polyx, tested by running it. A recording stand-in for polyx logs how it was started
// (its argument vector, the names in its environment) and answers with an empty report; the tests start it through
// `poly mine` and read the log. The ruling's conditions, each one: a fixed argument vector with no shell, a fresh
// allowlisted environment, a pin checked before each start, only the command mine, a timeout and a cap on output, and
// imports that reach no network. Written by the implementer; the separate audit reads it against PT30.10 without the code.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';
import { admitted } from './runtime-helpers.mjs';
import { shop } from './fixtures/m7/make-shop-traces.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const poly = (...args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...args], { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; }
};
const slash = (p) => p.split(String.fromCharCode(92)).join('/');
// On Windows the operating system gives every process its own system variables (found by starting node with only PATH).
const OS_ADDED = process.platform === 'win32' ? ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'] : [];
const ALLOWED = ['PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', ...OS_ADDED];

let tmp; let a; let traces;
before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'poly-seam-'));
  a = await admitted('polyx-seam', ['test/fixtures/m7/shop/orders.poly', 'test/fixtures/m7/shop/orders.policy.poly']);
  traces = join(tmp, 'corpus.ndjson');
  writeFileSync(traces, shop());
});
after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

let n = 0;
/** A stand-in polyx that logs every start to <dir>/starts.log, one JSON line each; `behaviour` runs after the report is built. */
function fakePolyx({ name = 'fake-polyx', body = '' } = {}) {
  const dir = join(tmp, `${name}-${++n}`);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  const log = slash(join(dir, 'starts.log'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  writeFileSync(join(dir, 'bin', 'polyx.mjs'), [
    "import { appendFileSync } from 'node:fs';",
    `appendFileSync('${log}', JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env).sort(), values: process.env, cwd: process.cwd() }) + String.fromCharCode(10));`,
    body,
    "console.log(JSON.stringify({ manifest: { alphabetVersion: 1, thresholds: { minInstances: 5 }, seed: 1, codeCommit: 'c'.repeat(40), segmenter: 'null', corpusRevision: 'r' }, rules: [] }));",
  ].join('\n'));
  return { dir, starts: () => (existsSync(join(dir, 'starts.log')) ? readFileSync(join(dir, 'starts.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []) };
}
const pinFile = () => join(tmp, `pin-${++n}.json`);
const pinned = (fake) => { const pin = pinFile(); const r = poly('mine', '--pin-polyx', '--project', a.dir, '--polyx', fake.dir, '--polyx-pin', pin); assert.equal(r.code, 0, r.out); return pin; };
const mine = (fake, pin, ...extra) => { const out = join(tmp, `out-${++n}.json`); return { out, ...poly('mine', '--traces', traces, '--project', a.dir, '--polyx', fake.dir, '--polyx-pin', pin, '--out', out, ...extra) }; };

test('PT30.10: without a pin polyx is not started: a usage error that names the pin', () => {
  const f = fakePolyx();
  const r = mine(f, join(tmp, 'no-such-pin.json'));
  assert.equal(r.code, 64);
  assert.match(r.out, /poly: no polyx pin at .*no-such-pin\.json: record the polyx you trust with poly mine --pin-polyx/);
  assert.equal(f.starts().length, 0);
  assert.ok(!existsSync(r.out));
  // The control: with the pin, the same call mines.
  const ok = mine(f, pinned(f));
  assert.equal(ok.code, 0, ok.out);
  assert.equal(f.starts().length, 1);
});

test('PT30.10: --pin-polyx records the version and the digest of the entry point, changes nothing when repeated, and a different polyx needs --repin-polyx', () => {
  const f = fakePolyx();
  const pin = pinFile();
  const r = poly('mine', '--pin-polyx', '--project', a.dir, '--polyx', f.dir, '--polyx-pin', pin);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(JSON.parse(readFileSync(pin, 'utf8')), { v: 1, name: 'polyx', version: '9.9.9', entry: `sha256:${createHash('sha256').update(readFileSync(join(f.dir, 'bin', 'polyx.mjs'))).digest('hex')}` });
  assert.equal(f.starts().length, 0, 'pinning starts nothing');
  const before = readFileSync(pin, 'utf8');
  assert.equal(poly('mine', '--pin-polyx', '--project', a.dir, '--polyx', f.dir, '--polyx-pin', pin).code, 0);
  assert.equal(readFileSync(pin, 'utf8'), before);
  appendFileSync(join(f.dir, 'bin', 'polyx.mjs'), '// changed' + String.fromCharCode(10));
  const again = poly('mine', '--pin-polyx', '--project', a.dir, '--polyx', f.dir, '--polyx-pin', pin);
  assert.equal(again.code, 64);
  assert.match(again.out, /pins another polyx/);
  assert.equal(readFileSync(pin, 'utf8'), before);
  assert.equal(poly('mine', '--repin-polyx', '--project', a.dir, '--polyx', f.dir, '--polyx-pin', pin).code, 0);
  assert.notEqual(readFileSync(pin, 'utf8'), before);
});

test('PT30.10: a polyx whose entry point or version is not the pinned one is refused before it is started', () => {
  for (const change of ['entry', 'version']) {
    const f = fakePolyx();
    const pin = pinned(f);
    const control = mine(f, pin);
    assert.equal(control.code, 0, control.out);
    assert.equal(f.starts().length, 1);
    if (change === 'entry') appendFileSync(join(f.dir, 'bin', 'polyx.mjs'), '// tampered' + String.fromCharCode(10));
    else writeFileSync(join(f.dir, 'package.json'), JSON.stringify({ version: '9.9.10' }));
    const r = mine(f, pin);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, change === 'entry' ? /poly: the polyx at .* is not the pinned one: its entry point digests to sha256:[0-9a-f]{64}, and the pin records sha256:[0-9a-f]{64}/ : /poly: the polyx at .* is version 9\.9\.10, and the pin records 9\.9\.9/);
    assert.equal(f.starts().length, 1, 'the second call started nothing');
    assert.ok(!existsSync(r.out), 'no candidates were written');
  }
});

test('PT30.10: the argument vector is fixed, and the only polyx command is mine', () => {
  const f = fakePolyx();
  const pin = pinned(f);
  assert.equal(mine(f, pin).code, 0);
  assert.equal(mine(f, pin, '--all').code, 0);
  const [one, two] = f.starts();
  assert.equal(one.argv.length, 5);
  assert.deepEqual(one.argv.slice(0, 4), ['mine', 'poly-traces', '--json', '--config']);
  assert.match(one.argv[4], /polyx\.config\.json$/);
  assert.deepEqual(two.argv.slice(0, 4), ['mine', 'poly-traces', '--json', '--config']);
  assert.equal(two.argv[5], '--all');
  assert.equal(two.argv.length, 6);
  for (const s of f.starts()) assert.ok(!s.argv.some((x) => /annotate|serve|review|calibrate/.test(x)));
});

test('PT30.10: the child gets a fresh environment from an allowlist: no key, token or secret, and nothing else the parent had', () => {
  const f = fakePolyx();
  const pin = pinned(f);
  const planted = { POLYX_JEV_KEY: 'k-1', MY_SECRET_TOKEN: 't-1', ANTHROPIC_API_KEY: 'a-1', AWS_SECRET_ACCESS_KEY: 's-1', GITHUB_TOKEN: 'g-1', OPENAI_API_KEY: 'o-1', SOME_OTHER_THING: 'x-1', HTTPS_PROXY: 'http://proxy.invalid' };
  Object.assign(process.env, planted);
  let r;
  try { r = mine(f, pin); } finally { for (const k of Object.keys(planted)) delete process.env[k]; }
  assert.equal(r.code, 0, r.out);
  const [s] = f.starts();
  for (const k of s.env) assert.ok(ALLOWED.includes(k.toUpperCase()), `the child sees ${k}`);
  for (const [k, v] of Object.entries(planted)) { assert.ok(!s.env.includes(k), k); assert.ok(!Object.values(s.values).includes(v), `${k}'s value reached the child`); }
  assert.ok(s.env.some((k) => k.toUpperCase() === 'PATH'), 'the allowlisted names it needs are given');
});

test('PT30.10: no shell: a polyx path made of shell metacharacters is run as it is', () => {
  const f = fakePolyx({ name: 'fake & polyx (1) $HOME;' });
  const pin = pinned(f);
  const r = mine(f, pin);
  assert.equal(r.code, 0, r.out);
  assert.equal(f.starts().length, 1);
  assert.ok(!existsSync(join(tmp, ' polyx')), 'nothing was split at the ampersand');
});

test('PT30.10: a polyx that never answers is stopped when the timeout passes, and writes no candidates', { timeout: 120000 }, () => {
  // The stand-in never answers and never exits, so the outcome does not depend on how fast the machine starts it: whatever
  // the load, only the timeout ends it.
  const f = fakePolyx({ body: "setInterval(() => {}, 1000); await new Promise(() => {});" });
  const pin = pinned(f);
  const r = mine(f, pin, '--timeout', '2');
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /poly: polyx did not finish within 2 s and was stopped/);
  assert.ok(!existsSync(r.out));
});

test('PT30.10: a polyx whose output passes the cap is stopped, and writes no candidates', () => {
  const f = fakePolyx({ body: "console.log('x'.repeat(100000));" });
  const pin = pinned(f);
  const r = mine(f, pin, '--max-output', '1000');
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /poly: polyx wrote more than 1000 bytes, the cap on its output, and was stopped/);
  assert.ok(!existsSync(r.out));
});

test('PT30.10: a failing polyx is reported with its own message, no candidates written', () => {
  const f = fakePolyx({ body: "console.error('polyx says no'); process.exit(3);" });
  const pin = pinned(f);
  const r = mine(f, pin);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /polyx failed: .*polyx says no/);
  assert.ok(!existsSync(r.out));
});

test('PT30.10: poly-mine imports node:child_process, node:crypto, node:fs, node:os and node:path only (node:os since M7.3, for polyness's temporary home); no other package of poly starts a process but poly-new', () => {
  const imports = (dir) => readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.ts')).flatMap((f) => [...readFileSync(join(dir, String(f)), 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]));
  const mineImports = imports(join(ROOT, 'packages', 'poly-mine', 'src'));
  assert.ok(mineImports.length >= 3);
  for (const spec of mineImports) assert.ok(['node:child_process', 'node:crypto', 'node:fs', 'node:os', 'node:path'].includes(spec), spec);
  for (const pkg of readdirSync(join(ROOT, 'packages'))) {
    if (pkg === 'poly-mine' || pkg === 'poly-new') continue;
    assert.ok(!imports(join(ROOT, 'packages', pkg, 'src')).some((s) => /child_process|worker_threads/.test(s)), `${pkg} starts a process`);
  }
});
