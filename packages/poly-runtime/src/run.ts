// `poly run` (S174, S188, S189): the project's runtime, loaded from the `run` field of its poly.json. Trust is admission
// public keys only; the ledger signer is a `file:` outside the project, read once and never echoed: an error names its
// path, never its contents, and nothing of it reaches output, logs or the journal. One process owns a store at a time,
// by a lock file beside it that names the owner's process id. No key is read from the environment.
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseManifest, type RunConfig } from '@poly/core';
import { load, type PolyRuntime } from './runtime.js';

export class RunConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'RunConfigError'; }
}

export interface LoadedRun {
  rt: PolyRuntime;
  /** The approvals drop folder (S189), created when absent. */
  approvals: string;
  /** Closes the runtime and gives up the store. */
  close(): Promise<void>;
}

/** Whether a path, resolved through any link, lies inside the directory. */
function inside(dir: string, path: string): boolean {
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const rel = relative(real(dir), real(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** S174: takes the store's lock, or refuses while a live process holds it. */
function lockStore(store: string): string {
  const lock = `${store}.lock`;
  mkdirSync(dirname(store), { recursive: true });
  for (let k = 0; k < 2; k++) {
    try { writeFileSync(lock, String(process.pid), { flag: 'wx' }); return lock; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const owner = Number(readFileSync(lock, 'utf8'));
      if (Number.isInteger(owner) && alive(owner)) throw new RunConfigError(`the store ${store} is owned by process ${owner}; one process owns a store at a time (S174)`);
      unlinkSync(lock); // its owner is gone
    }
  }
  throw new RunConfigError(`the store ${store} could not be locked (S174)`);
}

/** S188: the `run` field of the project's poly.json, or why not. */
export function runConfigOf(project: string): RunConfig {
  const path = join(project, 'poly.json');
  if (!existsSync(path)) throw new RunConfigError(`no poly.json in ${project}`);
  const m = parseManifest(readFileSync(path, 'utf8'), path);
  if (!m.run) throw new RunConfigError(`${path} has no "run" field: poly run loads its certificate, store, trust and signer from it (S188)`);
  return m.run;
}

/** S188, S189: loads the project's runtime as its poly.json's `run` field configures it. */
export async function loadRun(project: string, opts: { now?: () => number } = {}): Promise<LoadedRun> {
  const dir = resolve(project);
  const run = runConfigOf(dir);
  const certificate = resolve(dir, run.certificate ?? '.poly/certificate.json');
  const store = resolve(dir, run.store ?? '.poly/run/store.sqlite');
  const approvals = resolve(dir, run.approvals ?? 'approvals');
  // Trust: public keys only. A private key here is refused, and its contents are not shown.
  const trust: Record<string, string> = {};
  for (const [keyId, loc] of Object.entries(run.trust)) {
    const file = resolve(dir, loc.slice('file:'.length));
    if (!existsSync(file)) throw new RunConfigError(`run.trust ${keyId}: no file ${file}`);
    const pem = readFileSync(file, 'utf8');
    if (/PRIVATE KEY/.test(pem) || !/-----BEGIN PUBLIC KEY-----/.test(pem)) throw new RunConfigError(`run.trust ${keyId}: ${file} is not a public key; trust holds admission public keys only (S188)`);
    try { trust[keyId] = createPublicKey(pem).export({ type: 'spki', format: 'pem' }).toString(); } catch { throw new RunConfigError(`run.trust ${keyId}: ${file} does not parse as a public key (S188)`); }
  }
  // The signer: a file outside the project, read once. Errors name the path only.
  let ledger: { keyId: string; privateKeyPem: string } | undefined;
  if (run.ledger) {
    const file = resolve(dir, run.ledger.signer.slice('file:'.length));
    if (inside(dir, file)) throw new RunConfigError(`run.ledger.signer ${file} is inside the project ${dir}; a key in the tree is one git add from being committed, so it must resolve outside the project (S188)`);
    if (!existsSync(file)) throw new RunConfigError(`run.ledger.signer: no file ${file}`);
    const pem = readFileSync(file, 'utf8');
    try { createPrivateKey(pem); } catch { throw new RunConfigError(`run.ledger.signer ${file} is not a private key (S188)`); }
    ledger = { keyId: run.ledger.keyId, privateKeyPem: pem };
  }
  const lock = lockStore(store);
  mkdirSync(approvals, { recursive: true });
  let rt: PolyRuntime;
  try {
    rt = await load(join(dir, '.poly', 'build'), { certificate, trust, store: { sqlite: store }, ...(ledger ? { ledger } : {}), ...(opts.now ? { now: opts.now } : {}) });
  } catch (e) {
    unlinkSync(lock);
    throw e;
  }
  return {
    rt,
    approvals,
    async close() {
      try { await rt.close(); } finally { try { unlinkSync(lock); } catch { /* already gone */ } }
    },
  };
}
