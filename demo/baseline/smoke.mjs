// The smoke test of a workspace (DB10 item 4): a throwaway workspace of the arm is built, installed with no network, and used the way the
// agent uses it. If it cannot be, the arm is not started. It costs nothing and calls no model. It is synchronous.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, makeWorkspace } from './arms.mjs';

const CLEAN = 'tools/poly/examples/hello/hello-empty.poly';
const FINDING = 'tools/poly/examples/hello/hello.poly';

/** The environment of the smoke test: no registry, no cache, so any fetch fails. */
const offline = (cache) => ({
  ...process.env,
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
    const sh = (command) => spawnSync(command, { cwd: ws, env, shell: true, encoding: 'utf8', timeout: 240000 });
    const tail = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').filter(Boolean).slice(-6).join(' | ').slice(0, 600);
    // The line that says what happened: a verdict or a finding if there is one, otherwise the last line of output.
    const first = (r) => {
      const lines = `${r.stdout ?? ''}`.trim().split('\n').filter(Boolean);
      return (lines.find((l) => /verdict:|PL\d{4}/.test(l)) ?? lines.at(-1) ?? 'no output').slice(0, 200);
    };
    /** One step: `check` gets the finished process and returns an error text or null. */
    const step = (name, command, check = () => null) => {
      const r = sh(command);
      const problem = r.status !== 0 && !/check/.test(name) ? `exit ${r.status}: ${tail(r)}` : check(r);
      steps.push({ name, ok: !problem, detail: problem ?? `${command}: ${first(r)}` });
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

    if (arm === 'poly') {
      const verdict = (file, wanted) => (r) => (`${r.stdout}${r.stderr}`.includes(wanted) ? null : `expected ${wanted} for ${file}: ${tail(r)}`);
      const ok = step('install', 'npm install')
        && step('check-clean', `npm run poly check ${CLEAN}`, verdict(CLEAN, 'verdict: CLEAN'))
        && step('check-finding', `npm run poly check ${FINDING}`, verdict(FINDING, 'PL3201'))
        && (makeUnrelated(), installLocal())
        && step('check-after', `npm run poly check ${CLEAN}`, (r) => verdict(CLEAN, 'verdict: CLEAN')(r) ?? present());
      return { ok, steps };
    }
    const ok = step('install', 'npm install')
      && step('tsc-version', 'npx tsc --version', (r) => (/^Version /m.test(r.stdout ?? '') ? null : `no version line: ${tail(r)}`))
      && (makeUnrelated(), installLocal())
      && step('tsc-after', 'npx tsc --version', (r) => (/^Version /m.test(r.stdout ?? '') ? null : `no version line: ${tail(r)}`) ?? present());
    return { ok, steps };
  } finally { rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); }
}
