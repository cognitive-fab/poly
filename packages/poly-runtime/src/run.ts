// `poly run` (S174, S188, S189): the project's runtime, loaded from the `run` field of its poly.json. Trust is admission
// public keys only; the ledger signer is a `file:` outside the project, read once and never echoed: an error names its
// path, never its contents, and nothing of it reaches output, logs or the journal. One process owns a store at a time:
// the decision comes from an exclusive SQLite lock on <store>.lock.db, held for the owner's whole life and released by
// the OS when the process ends, however it ends, so a reused process id cannot fool it. The lock file beside the store
// is information only: the owner's process id and start time, for the journal and for the error text. The store must
// be on a local disk; OS file locks are unreliable on network shares. No key is read from the environment.
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseManifest, type RunConfig } from '@poly/core';
import { load, type PolyRuntime } from './runtime.js';

/** S174: the runtime's own ledger run for its store, where a takeover of a stale lock is journaled. */
export const STORE_RUN = 'runtime:store';

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

/** The lock file's record: who owns the store, for the journal and the error text only. */
interface LockInfo { pid: number; startedAt: string }

const STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();

function lockInfo(file: string): LockInfo | null {
  try { const j = JSON.parse(readFileSync(file, 'utf8')) as LockInfo; return Number.isInteger(j.pid) ? j : null; } catch { return null; }
}

/**
 * S174: takes the store's lock, or refuses while another process holds it. The OS lock decides; the lock file is read
 * only to say who held the store before, so a takeover of a stale lock can be journaled with its process id and start
 * time.
 */
function lockStore(store: string): { previous: LockInfo | null; release(): void } {
  const file = `${store}.lock`;
  mkdirSync(dirname(store), { recursive: true });
  const db = new DatabaseSync(`${store}.lock.db`);
  try {
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('BEGIN EXCLUSIVE');
  } catch {
    db.close();
    const owner = lockInfo(file);
    throw new RunConfigError(`the store ${store} is owned by ${owner ? `process ${owner.pid}, started ${owner.startedAt}` : 'another process'}; one process owns a store at a time (S174)`);
  }
  const previous = lockInfo(file);
  writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: STARTED_AT } satisfies LockInfo));
  return {
    previous,
    release() {
      try { unlinkSync(file); } catch { /* already gone */ }
      try { db.exec('ROLLBACK'); } catch { /* nothing open */ }
      db.close();
    },
  };
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
    lock.release();
    throw e;
  }
  // A lock file the OS lock did not stand behind was stale: its process ended without releasing the store. The
  // takeover is journaled on the runtime's own store run, with the old process id and start time.
  if (lock.previous) {
    const previous = lock.previous;
    rt.store.ensureRun(STORE_RUN, 'runtime', 'store');
    await rt.store.txn(() => { rt.store.appendEvent(STORE_RUN, 'observation', { stage: 'store-lock', outcome: 'taken-over', previous, by: { pid: process.pid, startedAt: STARTED_AT } }, rt.now()); });
  }
  return {
    rt,
    approvals,
    async close() {
      try { await rt.close(); } finally { lock.release(); }
    },
  };
}
