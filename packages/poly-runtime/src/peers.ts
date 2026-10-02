// The engines poly runs as optional peers (S145, S161). Polyaxion, polyman and polysec-core (BUSL-1.1), and
// polycheck, are not vendored: each is resolved from a sibling checkout (`../polyaxion` or `../polycheck` beside the
// repository, or the directory `POLY_POLYAXION_DIR` or `POLY_POLYCHECK_DIR` names), and every file poly runs is
// pinned by SHA-256 in peers/<name>/PROVENANCE.md. A peer is used only when every pinned file matches; otherwise it
// is reported with its reason, and each check that needs it is listed as not run (no silent clean). Nothing here is
// on the step path: the pins are checked once per process.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The repository root: this file is packages/poly-runtime/dist/src/peers.js. */
export const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
export const PEER_PROVENANCE = join(REPO_ROOT, 'peers', 'polyaxion', 'PROVENANCE.md');

export type PeerStatus = { ok: true; dir: string; commit: string; files: number } | { ok: false; dir: string; reason: string };

type PeerName = 'polyaxion' | 'polycheck';
const PEERS: Record<PeerName, { env: string; probe: string; ruling: string }> = {
  polyaxion: { env: 'POLY_POLYAXION_DIR', probe: 'packages', ruling: 'S145' },
  polycheck: { env: 'POLY_POLYCHECK_DIR', probe: 'src', ruling: 'S161' },
};
const cached = new Map<PeerName, PeerStatus>();

/** A pinned file's digest: SHA-256 of its bytes with CRLF read as LF, so a Windows checkout of the commit matches its pin. */
export const pinDigest = (b: Buffer): string => createHash('sha256').update(Buffer.from(b.toString('latin1').split('\r\n').join('\n'), 'latin1')).digest('hex');

function pins(name: PeerName): { commit: string; rows: { file: string; sha: string }[] } {
  const text = readFileSync(join(REPO_ROOT, 'peers', name, 'PROVENANCE.md'), 'utf8');
  const commit = /commit `([0-9a-f]+)`/.exec(text)?.[1] ?? 'unknown';
  return { commit, rows: [...text.matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)].map((m) => ({ file: m[1], sha: m[2] })) };
}

/** Where a peer is, and whether every pinned file matches. `fresh` re-checks; `dir` names another checkout. */
export function peer(name: PeerName, opts: { dir?: string; fresh?: boolean } = {}): PeerStatus {
  const c = cached.get(name);
  if (c && !opts.fresh && !opts.dir) return c;
  const p = PEERS[name];
  const dir = resolve(opts.dir ?? process.env[p.env] ?? join(REPO_ROOT, '..', name));
  let status: PeerStatus;
  if (!existsSync(join(dir, p.probe))) status = { ok: false, dir, reason: `absent: no ${name} checkout at ${dir} (not run, ${p.ruling})` };
  else {
    const { commit, rows } = pins(name);
    const problems: string[] = [];
    for (const { file, sha } of rows) {
      const f = join(dir, file);
      if (!existsSync(f)) { problems.push(`${file} is missing`); continue; }
      if (pinDigest(readFileSync(f)) !== sha) problems.push(`${file} differs`);
    }
    status = problems.length
      ? { ok: false, dir, reason: `the peer at ${dir} differs from its pin at ${commit}: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? `; and ${problems.length - 3} more` : ''} (not run, ${p.ruling})` }
      : { ok: true, dir, commit, files: rows.length };
  }
  if (!opts.dir) cached.set(name, status);
  return status;
}

export const polyaxionPeer = (opts: { dir?: string; fresh?: boolean } = {}): PeerStatus => peer('polyaxion', opts);
export const polycheckPeer = (opts: { dir?: string; fresh?: boolean } = {}): PeerStatus => peer('polycheck', opts);

export class PeerUnavailable extends Error {
  constructor(message: string) { super(message); this.name = 'PeerUnavailable'; }
}

/** One pinned module of the Polyaxion package by its path under packages/polyaxion/src (PT8.5's discharge check). */
export async function loadPolyaxionModule(rel: string): Promise<any> {
  const s = polyaxionPeer();
  if (!s.ok) throw new PeerUnavailable(s.reason);
  return import(pathToFileURL(join(s.dir, 'packages', 'polyaxion', 'src', ...rel.split('/'))).href);
}

/** The Polyaxion package's public surface, from a peer whose every pinned file matches. */
export async function loadPolyaxion(): Promise<any> {
  const s = polyaxionPeer();
  if (!s.ok) throw new PeerUnavailable(s.reason);
  return import(pathToFileURL(join(s.dir, 'packages', 'polyaxion', 'src', 'index.mjs')).href);
}

/** polycheck's model checker and its default regions (S161), from a peer whose every pinned file matches. */
export async function loadPolycheck(): Promise<{ modelCheck: (model: any) => any; regions: { name: string; kind: string; requires: string[] }[] }> {
  const s = polycheckPeer();
  if (!s.ok) throw new PeerUnavailable(s.reason);
  const { modelCheck } = await import(pathToFileURL(join(s.dir, 'src', 'check.mjs')).href);
  const regions = JSON.parse(readFileSync(join(s.dir, 'data', 'regions.json'), 'utf8')).regions;
  return { modelCheck, regions };
}
