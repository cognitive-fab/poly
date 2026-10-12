// poly-mine (PT30.1, PT31.3, S507): the two processes poly starts besides poly new, polyx (`poly mine`) and polyness (`poly
// propose`), each run by path as a separately installed tool. It is the only package besides poly-new that may start a
// process, and what it may start is narrower than poly-new's:
//   - the argument vector is fixed, and no shell is involved: the only polyx command is `mine`, the only polyness command
//     is `propose`, and scripts/check-boundaries.mjs holds the list of the two tools;
//   - the child's environment is built fresh from a short allowlist, never inherited, so no key, token or secret reaches it;
//   - the polyx on disk is checked against the pin (the S507 record: name, version and the SHA-256 of its entry point)
//     immediately before each start, and a mismatch refuses;
//   - the run has a timeout and a cap on the size of its output;
//   - polyness is given a temporary home made fresh for the run (PT31.8), holding only the transcripts copied into it, and
//     removed afterwards, whatever happened;
//   - it imports node builtins that reach no network, and nothing else.
// scripts/check-boundaries.mjs enforces the imports, the absence of a shell and of any other spawn, the whole-environment
// reads and the name of polyx's model-calling command; test/polyx-seam.test.mjs checks the rest by running it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

/** The names the child may see of this process's environment. Everything else, whatever it is called, stays behind. */
export const ENV_ALLOWLIST = ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'LANG'] as const;
export const DEFAULT_TIMEOUT_MS = 600_000;
export const DEFAULT_MAX_OUTPUT = 64 * 1024 * 1024;

/** A refusal to start polyx: its pin is missing or does not match, or the run went past a limit. */
export class PolyxRefused extends Error {}

/** The S507 record of the polyx that was trusted: it is the file the project keeps beside its sources. */
export interface PolyxPin { v: 1; name: 'polyx'; version: string; entry: string }

const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const entryOf = (dir: string) => join(dir, 'bin', 'polyx.mjs');

/** The pin of the polyx at a path: its version and the digest of its entry point. */
export function pinOf(dir: string): PolyxPin {
  if (!existsSync(entryOf(dir))) throw new PolyxRefused(`${dir} has no bin/polyx.mjs: it is the directory of a polyx checkout`);
  let version = '';
  try { version = String((JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown }).version ?? ''); } catch { version = ''; }
  return { v: 1, name: 'polyx', version, entry: sha(readFileSync(entryOf(dir))) };
}

/** Refuses unless the polyx at the path is the one the pin records. */
export function checkPin(dir: string, pin: unknown): PolyxPin {
  const p = pin as Partial<PolyxPin> | null;
  if (!p || p.v !== 1 || p.name !== 'polyx' || typeof p.entry !== 'string' || typeof p.version !== 'string') throw new PolyxRefused('the polyx pin is not { v: 1, name: "polyx", version, entry } (S507)');
  const now = pinOf(dir);
  if (now.entry !== p.entry) throw new PolyxRefused(`the polyx at ${dir} is not the pinned one: its entry point digests to ${now.entry}, and the pin records ${p.entry} (S507)`);
  if (now.version !== p.version) throw new PolyxRefused(`the polyx at ${dir} is version ${now.version}, and the pin records ${p.version} (S507)`);
  return now;
}

/** The child's environment: built from the allowlist, with a value for a name only if this process has one. */
export function polyxEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) { const v = process.env[name]; if (typeof v === 'string') env[name] = v; }
  return env;
}

export interface RunOptions { polyx: string; pin: unknown; config: string; cwd: string; all?: boolean; timeoutMs?: number; maxOutput?: number }

/** Runs `polyx mine <corpus> --json --config <file>` and returns what it printed. */
export function runPolyxMine(o: RunOptions): string {
  checkPin(o.polyx, o.pin);
  const timeout = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = o.maxOutput ?? DEFAULT_MAX_OUTPUT;
  const argv = [entryOf(o.polyx), 'mine', 'poly-traces', '--json', '--config', o.config, ...(o.all ? ['--all'] : [])];
  try {
    return execFileSync(process.execPath, argv, { encoding: 'utf8', cwd: o.cwd, env: polyxEnv(), timeout, maxBuffer, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string | Buffer; killed?: boolean; signal?: string };
    if (err.code === 'ETIMEDOUT' || (err.killed && err.signal === 'SIGTERM')) throw new PolyxRefused(`polyx did not finish within ${Math.round(timeout / 1000)} s and was stopped`);
    if (err.code === 'ENOBUFS' || err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new PolyxRefused(`polyx wrote more than ${maxBuffer} bytes, the cap on its output, and was stopped`);
    throw new Error(`polyx failed: ${String(err.stderr ?? err.message).trim().split('\n').slice(0, 5).join(' | ')}`);
  }
}

// ── polyness (PT31.3, PT31.8) ───────────────────────────────────────────────────────────────────────────────────

/** The files of polyness whose text poly's reading depends on (PT31.3). A file a checkout does not have is not pinned. */
export const POLYNESS_FILES = ['bin/polyness.mjs', 'src/propose.mjs', 'src/rules.mjs', 'src/reader.mjs', 'src/normalise.mjs'] as const;
export const POLYNESS_HOME_PREFIX = 'poly-polyness-home-';

/** A refusal to start polyness: no entry point, a pin that does not match, or a run that went past a limit. */
export class PolynessRefused extends Error {}

export interface PolynessPin { v: 1; name: 'polyness'; version: string; files: Record<string, string> }
const polynessFile = (dir: string, rel: string) => join(dir, ...rel.split('/'));

/** The pin of the polyness at a path: its version and the digest of each file poly depends on. */
export function polynessPinOf(dir: string): PolynessPin {
  if (!existsSync(polynessFile(dir, 'bin/polyness.mjs'))) throw new PolynessRefused(`${dir} has no bin/polyness.mjs: it is the directory of a polyness checkout`);
  let version = '';
  try { version = String((JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown }).version ?? ''); } catch { version = ''; }
  const files: Record<string, string> = {};
  for (const rel of POLYNESS_FILES) if (existsSync(polynessFile(dir, rel))) files[rel] = sha(readFileSync(polynessFile(dir, rel)));
  return { v: 1, name: 'polyness', version, files };
}

/** Refuses unless the polyness at the path is the one the pin records, file by file. */
export function checkPolynessPin(dir: string, pin: unknown): PolynessPin {
  const p = pin as Partial<PolynessPin> | null;
  if (!p || p.v !== 1 || p.name !== 'polyness' || typeof p.version !== 'string' || !p.files || typeof p.files !== 'object') throw new PolynessRefused('the polyness pin is not { v: 1, name: "polyness", version, files } (PT31.3)');
  const now = polynessPinOf(dir);
  for (const rel of POLYNESS_FILES) if (now.files[rel] !== p.files[rel]) throw new PolynessRefused(`the polyness at ${dir} is not the pinned one: ${rel} differs from the pin (PT31.3)`);
  if (now.version !== p.version) throw new PolynessRefused(`the polyness at ${dir} is not the pinned one: its version is ${now.version}, and the pin records ${p.version} (PT31.3)`);
  return now;
}

export interface PolynessRunOptions { polyness: string; pin: unknown; step: string; transcripts: string[]; timeoutMs?: number; maxOutput?: number }
/** What a run of polyness left: its exit status and output, and every file of every proposal folder it wrote, by folder and name. */
export interface PolynessRun { status: number; stdout: string; stderr: string; proposals: Record<string, Record<string, string>> }

/**
 * Runs `polyness propose <step> project` in a temporary home (PT31.8): a fresh folder of the system's temporary directory,
 * holding `.claude/projects/project/` and the copies of the transcripts and nothing else, which is the working directory and
 * the home polyness is given. The pin is checked first. The home is removed afterwards, including when the run fails.
 */
export function runPolyness(o: PolynessRunOptions): PolynessRun {
  checkPolynessPin(o.polyness, o.pin);
  const timeout = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = o.maxOutput ?? DEFAULT_MAX_OUTPUT;
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), POLYNESS_HOME_PREFIX)));
  try {
    const into = join(home, '.claude', 'projects', 'project');
    mkdirSync(into, { recursive: true });
    for (const f of o.transcripts) copyFileSync(f, join(into, basename(f)));
    const argv = [polynessFile(o.polyness, 'bin/polyness.mjs'), 'propose', o.step, 'project'];
    const env = { ...polyxEnv(), HOME: home, USERPROFILE: home };
    let status = 0; let stdout = ''; let stderr = '';
    try {
      stdout = execFileSync(process.execPath, argv, { encoding: 'utf8', cwd: home, env, timeout, maxBuffer, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { stdout?: string | Buffer; stderr?: string | Buffer; killed?: boolean; signal?: string; status?: number | null };
      if (err.code === 'ETIMEDOUT' || (err.killed && err.signal === 'SIGTERM')) throw new PolynessRefused(`polyness did not finish within ${Math.round(timeout / 1000)} s and was stopped`);
      if (err.code === 'ENOBUFS' || err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new PolynessRefused(`polyness wrote more than ${maxBuffer} bytes, the cap on its output, and was stopped`);
      if (typeof err.status !== 'number') throw new Error(`polyness could not be started: ${err.message}`);
      status = err.status; stdout = String(err.stdout ?? ''); stderr = String(err.stderr ?? '');
    }
    const proposals: PolynessRun['proposals'] = {};
    const root = join(home, '.polyness', 'proposals');
    if (existsSync(root)) {
      for (const folder of readdirSync(root, { withFileTypes: true })) {
        if (!folder.isDirectory()) continue;
        const files: Record<string, string> = {};
        for (const f of readdirSync(join(root, folder.name), { withFileTypes: true })) if (f.isFile()) files[f.name] = readFileSync(join(root, folder.name, f.name), 'utf8');
        proposals[folder.name] = files;
      }
    }
    return { status, stdout, stderr, proposals };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
