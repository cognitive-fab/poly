// plan-ex.md E2, "Run it yourself", step 1 (examples/inbox/host/setup.mjs): the scaffold of the owner's project. Light:
// nothing is checked or admitted here. It holds that setup prints no key material, puts none in a project file, refuses a
// key directory inside the project or inside this repository, overwrites nothing, tailors the program only in the places
// the README names, writes maps and price tables the checker accepts the shape of, and scaffolds a handler file that
// passes `poly lint handlers`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commandNamed } from '@poly/check';
import { calibrate } from '@poly/runtime';
import { mapProblem, parseManifest } from '@poly/core';
import { parse } from '@poly/lang';
import { ROOT } from './helpers.mjs';

const { main, tailor, reservations } = await import(pathToFileURL(join(ROOT, 'examples', 'inbox', 'host', 'setup.mjs')).href);
const EXAMPLE = readFileSync(join(ROOT, 'examples', 'inbox', 'inbox.poly'), 'utf8');

const ARGS = (project, keys, extra = []) => ['--project', project, '--keys', keys, '--account', 'work:me-work', '--account', 'home:me-home',
  '--small-model', 'small-model-id', '--small-price', '1,5', '--large-model', 'large-model-id', '--large-price', '3,15',
  '--prices-source', 'https://example.com/prices', '--prices-read-on', '2026-10-11', ...extra];
const sink = () => { const t = { out: '', err: '' }; return { t, io: { out: (s) => { t.out += s; }, err: (s) => { t.err += s; } } }; };
const files = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
const tmp = () => mkdtempSync(join(tmpdir(), 'poly-inbox-setup-'));

test('setup scaffolds a project and keys, prints paths and no key, and leaves no key or token in the project', async () => {
  const base = tmp();
  const project = join(base, 'project');
  const keys = join(base, 'keys');
  try {
    const { t, io } = sink();
    assert.equal(await main(ARGS(project, keys), io), 0, t.err);
    // Not a line of any private key, nor the vault key, is printed.
    const secrets = ['admission.pem', 'person.pem', 'ledger.pem', 'vault.key'].flatMap((f) => readFileSync(join(keys, f), 'utf8').split('\n').filter((l) => l.length > 20 && !l.startsWith('-----')));
    assert.ok(secrets.length >= 4);
    for (const s of secrets) assert.ok(!t.out.includes(s) && !t.err.includes(s), 'a key line was printed');
    // The project holds no private key or token-shaped string: only public keys, and names and paths.
    for (const f of files(project)) {
      const text = readFileSync(f, 'utf8');
      assert.ok(!/PRIVATE KEY|sk-ant-|sk_live_|sk_test_|xox[bp]-|AIza[0-9A-Za-z_-]{20}|ya29\.|(?<!sha256:)[0-9a-f]{64}/.test(text), `${f} holds something key-shaped`);
    }
    // poly.json is a manifest poly accepts, names the keys by file and the credentials' vaults, and holds the people ring's public key.
    const manifest = parseManifest(readFileSync(join(project, 'poly.json'), 'utf8'));
    assert.deepEqual([manifest.keys.admission.location.startsWith('file:'), manifest.run.ledger.signer.startsWith('file:'), manifest.credentials], [true, true, { gmail_read: { store: 'dev-keychain' }, gmail_draft: { store: 'dev-keychain' } }]);
    assert.match(manifest.people[0].publicKey, /BEGIN PUBLIC KEY/);
    // The host's config names the environment variables and holds no value.
    const config = JSON.parse(readFileSync(join(project, 'inbox.host.json'), 'utf8'));
    assert.deepEqual(config.accounts, [{ label: 'work', owner: 'me-work' }, { label: 'home', owner: 'me-home' }]);
    assert.deepEqual([config.google.clientIdEnv, config.google.clientSecretEnv, config.model.keyEnv, config.model.samples], ['INBOX_GOOGLE_CLIENT_ID', 'INBOX_GOOGLE_CLIENT_SECRET', 'ANTHROPIC_API_KEY', 5]);
    // The private keys are the owner's alone, where the platform has modes.
    if (process.platform !== 'win32') for (const f of ['admission.pem', 'person.pem', 'ledger.pem', 'vault.key']) assert.equal(statSync(join(keys, f)).mode & 0o077, 0, f);
    // The maps are the shape `poly journal fit` writes, for the owner's models; the tables name the owner's source and date.
    for (const [f, model] of [['triage-small', 'small-model-id'], ['triage-large', 'large-model-id'], ['kind-small', 'small-model-id'], ['kind-large', 'large-model-id']]) {
      const m = JSON.parse(readFileSync(join(project, 'src', 'maps', `${f}.json`), 'utf8'));
      assert.equal(mapProblem(m), null, f);
      assert.equal(m.fittedFor, model);
      // The map is the identity as the runtime reads it: a step function, so a raw probability maps to itself at every thousandth.
      for (const p of [0, 0.001, 0.2, 0.4, 0.6, 0.8, 0.9, 0.97, 0.999, 1]) assert.equal(calibrate(m, p), Math.round(p * 1000), `${f} at ${p}`);
    }
    assert.deepEqual(JSON.parse(readFileSync(join(project, 'src', 'prices', 'small.json'), 'utf8')), { v: 1, provider: 'small', model: 'small-model-id', currency: 'usd', perMillionTokens: { input: 1000000, output: 5000000 }, source: 'https://example.com/prices', readOn: '2026-10-11' });
    // The handler file is the host's drafts handler, and it passes the lint that refuses ambient authority.
    assert.equal(readFileSync(join(project, 'src', 'handlers.ts'), 'utf8'), readFileSync(join(ROOT, 'examples', 'inbox', 'host', 'drafts.mjs'), 'utf8'));
    const lint = await commandNamed('lint').run({ project });
    assert.equal(lint.result.verdict, 'CLEAN', JSON.stringify(lint.result.diagnostics));
    // A second project on the same keys keeps them, byte for byte.
    const before = readFileSync(join(keys, 'person.pem'), 'utf8');
    const again = sink();
    assert.equal(await main(ARGS(join(base, 'project2'), keys), again.io), 0, again.t.err);
    assert.equal(readFileSync(join(keys, 'person.pem'), 'utf8'), before);
  } finally { rmSync(base, { recursive: true, force: true, maxRetries: 10 }); }
});

test('setup refuses a key directory inside the project, a project or keys inside this repository, a project with files, and writes nothing', async () => {
  const base = tmp();
  try {
    for (const [project, keys, why] of [
      [join(base, 'p1'), join(base, 'p1', 'keys'), /inside the project/],
      [join(base, 'keys2', 'p2'), join(base, 'keys2'), /inside the project/],
      [join(base, 'p3'), join(ROOT, '.poly', 'inbox-keys-refused'), /outside this repository/],
      [join(ROOT, '.poly', 'inbox-project-refused'), join(base, 'keys4'), /outside this repository/],
    ]) {
      const { t, io } = sink();
      assert.equal(await main(ARGS(project, keys), io), 64, why.source);
      assert.match(t.err, why);
      assert.ok(!existsSync(project) || !readdirSync(project).length, `${project} was written`);
      assert.ok(!existsSync(keys), `${keys} was written`);
    }
    const taken = join(base, 'taken');
    mkdirSync(taken);
    writeFileSync(join(taken, 'mine.txt'), 'x');
    const { t, io } = sink();
    assert.equal(await main(ARGS(taken, join(base, 'keys5')), io), 64);
    assert.match(t.err, /already has files/);
    assert.deepEqual(readdirSync(taken), ['mine.txt']);
  } finally { rmSync(base, { recursive: true, force: true, maxRetries: 10 }); }
});

test('setup asks for what it cannot know: accounts, models, prices read on a dated https page; and refuses a cap below the largest reservation', async () => {
  const base = tmp();
  try {
    const cases = [
      [['--project', join(base, 'a'), '--keys', join(base, 'ka')], /at least one --account/],
      [ARGS(join(base, 'b'), join(base, 'kb')).filter((a, i, all) => !(a === '--small-model' || all[i - 1] === '--small-model')), /name the models/],
      [ARGS(join(base, 'c'), join(base, 'kc')).map((a) => (a === '1,5' ? 'cheap' : a)), /--small-price is/],
      [ARGS(join(base, 'd'), join(base, 'kd')).map((a) => (a === 'https://example.com/prices' ? 'http://example.com' : a)), /--prices-source is the https page/],
      [ARGS(join(base, 'e'), join(base, 'ke'), ['--samples', '2']), /from 3 to 9/],
      [ARGS(join(base, 'f'), join(base, 'kf'), ['--threshold', '1.5']), /--threshold is a decimal/],
      [ARGS(join(base, 'g'), join(base, 'kg'), ['--cap', '0.05']), /below the largest reservation/],
      [ARGS(join(base, 'h'), join(base, 'kh')).map((a) => (a === 'work:me-work' ? 'Work:me' : a)), /--account is <label>:<owner>/],
    ];
    for (const [args, why] of cases) {
      const { t, io } = sink();
      assert.equal(await main(args, io), 64, why.source);
      assert.match(t.err, why);
    }
  } finally { rmSync(base, { recursive: true, force: true, maxRetries: 10 }); }
});

test('the program is tailored in the places the README names and no others, each found exactly once', () => {
  const t = tailor(EXAMPLE, { samples: 5, threshold: '0.9', cap: 20 });
  const count = (re) => [...t.matchAll(re)].length;
  assert.deepEqual([count(/escalate when conf < 0\.9 or failed/g), count(/if conf >= 0\.9 \{/g), count(/max input tokens 20000 max tokens 100/g), count(/timeout 30s/g), count(/timeout 60s/g), count(/cap usd 20 per month/g)], [2, 1, 5, 4, 1, 1]);
  // Every other line is the example's: the lines that differ are those, and the two comment lines that replace the expected line.
  const was = EXAMPLE.replace(/\r\n/g, '\n').split('\n');
  const now = t.split('\n');
  assert.equal(now.length, was.length + 1);
  const changed = now.slice(2).flatMap((l, k) => (l !== was[k + 1] ? [l] : []));
  assert.equal(changed.length, 2 + 1 + 5 + 4 + 1, changed.join('\n'));
  assert.ok(changed.every((l) => /escalate when conf < 0\.9 or failed|if conf >= 0\.9 \{|max input tokens 20000 max tokens 100|timeout (30|60)s/.test(l)), changed.join('\n'));
  assert.match(now[0], /^\/\/ Tailored by examples\/inbox\/host\/setup\.mjs/);
  assert.ok(parse(t).module, 'the tailored program parses');
  // A different example is refused rather than tailored by guesswork.
  assert.throws(() => tailor(EXAMPLE.replace('escalate when conf < 0.8 or failed', 'escalate when conf < 0.7 or failed'), { samples: 5, threshold: '0.9', cap: 20 }), /found 1 time\(s\), and setup expects 2/);
  // The reservations at n = 5 and the illustrative prices of the README: the largest is the large tier's triage.
  const r = reservations({ samples: 5, small: { input: 1e6, output: 5e6 }, large: { input: 3e6, output: 15e6 } });
  assert.deepEqual(r.rows.map(([, v]) => v), [20500, 61500, 20500, 61500, 20500, 5000, 39000]);
  assert.equal(r.largest, 61500);
});
