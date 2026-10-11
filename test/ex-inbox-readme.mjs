// plan-ex.md E2, "Run it yourself": the README's own command blocks, read and run, so the steps the test runs cannot
// drift from the steps the owner is shown. A fenced `sh` block holds one or more steps, each begun by a line
// `# step: <name>` and made of `node ...` command lines; a line `# live: <name>` begins steps the owner runs on his own
// accounts, which no test runs. A command runs as a child process of this one, as the owner would run it, with two test-only
// additions: a larger heap, and a preload that points the per-user keyring configuration at a folder of the test's, so
// that a test never writes the real user's.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';

export const README = join(ROOT, 'examples', 'inbox', 'README.md');
const PRELOAD = join(ROOT, 'test', 'ex-inbox-preload.mjs');

/** The test steps of the README, in order: { name, commands: [line] }, and the live steps' names. */
export function readmeSteps(text = readFileSync(README, 'utf8')) {
  const steps = [];
  const live = [];
  for (const block of text.matchAll(/```(?:sh|powershell)\r?\n([\s\S]*?)```/g)) {
    let current = null;
    for (const raw of block[1].split(/\r?\n/)) {
      const line = raw.trim();
      const m = /^# (step|live): (.+)$/.exec(line);
      if (m) { current = m[1] === 'step' ? { name: m[2], commands: [] } : null; if (current) steps.push(current); else live.push(m[2]); continue; }
      if (current && line && !line.startsWith('#')) current.commands.push(line);
    }
  }
  return { steps, live };
}

/** A command line as arguments: split on spaces, a double-quoted argument kept whole. */
export function argumentsOf(line) {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

/** The line with its placeholders filled; a placeholder left unfilled is an error. */
export function fill(line, vars) {
  const out = Object.entries(vars).reduce((s, [k, v]) => s.split(`<${k}>`).join(v), line);
  const left = out.match(/<[A-Za-z_ ]+>/);
  if (left) throw new Error(`the README step still has the placeholder ${left[0]}: ${line}`);
  return out;
}

/** Runs one filled command line as a child process; `anchors` is the folder standing for the per-user configuration. */
export function runCommand(line, { anchors, cwd = ROOT, env = {} }) {
  const [node, script, ...args] = argumentsOf(line);
  if (node !== 'node') throw new Error(`a README command starts with node: ${line}`);
  const r = spawnSync(process.execPath, ['--max-old-space-size=8192', '--import', pathToFileURL(PRELOAD).href, script, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, POLY_TEST_ANCHORS: anchors, ...env }, maxBuffer: 64 * 1024 * 1024,
  });
  return { line, status: r.status, stdout: r.stdout, stderr: r.stderr };
}
