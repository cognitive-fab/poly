// The smoke test of a workspace (DB10 item 4): a throwaway workspace of the arm is built, installed with no network, and used the way the
// agent uses it. If it cannot be, the arm is not started. It costs nothing and calls no model. It is synchronous.
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, makeWorkspace } from './arms.mjs';

const CLEAN = 'tools/poly/examples/hello/hello-empty.poly';
const FINDING = 'tools/poly/examples/hello/hello.poly';

/**
 * The host script of the runtime step (DB16 item 3): the entry points the reference gives. It loads the build that `poly admit` certified, creates the
 * machine of the clean example and dispatches one action. The key to trust is the public key of the run's own key pair.
 */
const RUNTIME_SCRIPT = `import { load } from '@poly/runtime';
const rt = await load('./.poly/build', { certificate: './.poly/certificate.json', trust: { smoke: process.env.POLY_SMOKE_TRUST_KEY } });
const gate = await rt.create('hello.Gate');
const answer = await rt.dispatch(gate.id, 'Coin', {}, { actionId: 'coin-1' });
console.log(JSON.stringify(answer));
`;
/** The test of the TypeScript arm's node-test step (DB16 item 4): one trivial test of node:test. */
const TRIVIAL_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
test('one plus one', () => { assert.equal(1 + 1, 2); });
`;

/** The environment of the smoke test: no registry, no cache, so any fetch fails. */
// NODE_TEST_CONTEXT is dropped: inside `node --test` it makes the child's own `node --test` print a machine format, and the node-test step would not see its `pass 1` line.
const offline = (cache) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')),
  npm_config_offline: 'true',
  npm_config_cache: cache,
  npm_config_registry: 'http://127.0.0.1:9/',
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_update_notifier: 'false',
});

/**
 * Runs the steps of an arm in a fresh workspace. Returns { ok, steps }, steps being [{ name, ok, detail }]. A step that fails ends the run
 * (the later steps would only repeat its failure). A root that lacks the package sources makes the build of the workspace throw.
 */
export function smokeTest(arm, { root = ROOT } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'poly-demo-smoke-'));
  try {
    const ws = join(tmp, 'ws');
    makeWorkspace(arm, ws, root);
    const env = offline(join(tmp, 'cache'));
    const steps = [];
    const sh = (command, extra = {}) => spawnSync(command, { cwd: ws, env: { ...env, ...extra }, shell: true, encoding: 'utf8', timeout: 240000 });
    const tail = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').filter(Boolean).slice(-6).join(' | ').slice(0, 600);
    // The line that says what happened: a verdict or a finding if there is one, otherwise the last line of output.
    const first = (r) => {
      const lines = `${r.stdout ?? ''}`.trim().split('\n').filter(Boolean);
      return (lines.find((l) => /verdict:|PL\d{4}/.test(l)) ?? lines.at(-1) ?? 'no output').slice(0, 200);
    };
    /** One step: `check` gets the finished process and returns an error text or null. `line` picks the line of output that the detail shows. */
    const step = (name, command, check = () => null, { env: extra, line = first } = {}) => {
      const r = sh(command, extra);
      const problem = r.status !== 0 && !/check/.test(name) ? `exit ${r.status}: ${tail(r)}` : check(r);
      steps.push({ name, ok: !problem, detail: problem ?? `${command}: ${line(r)}` });
      return !problem;
    };
    const declared = () => Object.keys(JSON.parse(readFileSync(join(ws, 'package.json'), 'utf8')).devDependencies ?? {});
    const present = () => {
      const missing = declared().filter((name) => !existsSync(join(ws, 'node_modules', ...name.split('/'), 'package.json')));
      return missing.length ? `declared but not installed: ${missing.join(', ')}` : null;
    };
    const installLocal = () => step('install-local', 'npm install --save-dev ./unrelated', (r) => (r.status === 0 ? null : `exit ${r.status}: ${tail(r)}`));
    const makeUnrelated = () => {
      mkdirSync(join(ws, 'unrelated'), { recursive: true });
      writeFileSync(join(ws, 'unrelated', 'package.json'), `${JSON.stringify({ name: 'unrelated-local', version: '1.0.0' })}\n`);
    };

    /** The line of the output that starts with, or holds, a text; the last line if none does. */
    const lineWith = (re) => (r) => (`${r.stdout ?? ''}`.trim().split('\n').find((l) => re.test(l)) ?? first(r)).slice(0, 300);

    if (arm === 'poly') {
      // The host of the runtime step: the clean example as the project's module, an admission key of this run's own, and a script to load it.
      const hostUp = () => {
        const { privateKey, publicKey } = generateKeyPairSync('ed25519');
        mkdirSync(join(ws, 'src'), { recursive: true });
        copyFileSync(join(ws, CLEAN), join(ws, 'src', 'hello.poly'));
        const manifest = JSON.parse(readFileSync(join(ws, 'poly.json'), 'utf8'));
        writeFileSync(join(ws, 'poly.json'), `${JSON.stringify({ ...manifest, keys: { admission: { id: 'smoke', location: 'env:POLY_ADMISSION_KEY' } } }, null, 2)}
`);
        writeFileSync(join(ws, 'smoke-runtime.mjs'), RUNTIME_SCRIPT);
        return { POLY_ADMISSION_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), POLY_SMOKE_TRUST_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
      };
      const verdict = (file, wanted) => (r) => (`${r.stdout}${r.stderr}`.includes(wanted) ? null : `expected ${wanted} for ${file}: ${tail(r)}`);
      let keyEnv;
      const ok = step('install', 'npm install')
        && step('check-clean', `npm run poly check ${CLEAN}`, verdict(CLEAN, 'verdict: CLEAN'))
        && step('check-finding', `npm run poly check ${FINDING}`, verdict(FINDING, 'PL3201'))
        && (keyEnv = hostUp(), step('admit', 'npm run poly admit .', (r) => (/^admitted /m.test(r.stdout ?? '') ? null : `no admitted line: ${tail(r)}`), { env: keyEnv, line: lineWith(/^admitted /) }))
        && step('runtime', 'node smoke-runtime.mjs', (r) => (/"stepKind":"accepted"/.test(r.stdout ?? '') && /"coins":1/.test(r.stdout ?? '') ? null : `the runtime did not accept the action: ${tail(r)}`), { env: keyEnv, line: lineWith(/"stepKind"/) })
        && (makeUnrelated(), installLocal())
        && step('check-after', `npm run poly check ${CLEAN}`, (r) => verdict(CLEAN, 'verdict: CLEAN')(r) ?? present());
      return { ok, steps };
    }
    const ok = step('install', 'npm install')
      && step('tsc-version', 'npx tsc --version', (r) => (/^Version /m.test(r.stdout ?? '') ? null : `no version line: ${tail(r)}`))
      && (mkdirSync(join(ws, 'test'), { recursive: true }), writeFileSync(join(ws, 'test', 'smoke.test.js'), TRIVIAL_TEST), step('node-test', 'npm test', (r) => (/pass 1\b/.test(`${r.stdout ?? ''}`) ? null : `the trivial test did not pass: ${tail(r)}`), { line: lineWith(/pass 1\b/) }))
      && (makeUnrelated(), installLocal())
      && step('tsc-after', 'npx tsc --version', (r) => (/^Version /m.test(r.stdout ?? '') ? null : `no version line: ${tail(r)}`) ?? present());
    return { ok, steps };
  } finally { rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); }
}
