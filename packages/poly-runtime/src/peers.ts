// The gate engine as an optional peer (S145). Polyaxion, polyman and polysec-core are BUSL-1.1 and are not
// vendored: they are resolved from a sibling checkout (`../polyaxion` beside the repository, or the directory
// `POLY_POLYAXION_DIR` names), and every file poly runs is pinned by SHA-256 in peers/polyaxion/PROVENANCE.md. A
// peer is used only when every pinned file matches; otherwise it is reported with its reason, and each check that
// needs it is listed as not run (no silent clean). Nothing here is on the step path: the pins are checked once.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The repository root: this file is packages/poly-runtime/dist/src/peers.js. */
export const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
export const PEER_PROVENANCE = join(REPO_ROOT, 'peers', 'polyaxion', 'PROVENANCE.md');

export type PeerStatus = { ok: true; dir: string; commit: string; files: number } | { ok: false; dir: string; reason: string };

let cached: PeerStatus | null = null;

/** A pinned file's digest: SHA-256 of its bytes with CRLF read as LF, so a Windows checkout of the commit matches its pin. */
export const pinDigest = (b: Buffer): string => createHash('sha256').update(Buffer.from(b.toString('latin1').split('\r\n').join('\n'), 'latin1')).digest('hex');

function pins(): { commit: string; rows: { file: string; sha: string }[] } {
  const text = readFileSync(PEER_PROVENANCE, 'utf8');
  const commit = /commit `([0-9a-f]+)`/.exec(text)?.[1] ?? 'unknown';
  return { commit, rows: [...text.matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)].map((m) => ({ file: m[1], sha: m[2] })) };
}

/** Where the peer is, and whether every pinned file matches. `fresh` re-checks; `dir` names another checkout. */
export function polyaxionPeer(opts: { dir?: string; fresh?: boolean } = {}): PeerStatus {
  if (cached && !opts.fresh && !opts.dir) return cached;
  const dir = resolve(opts.dir ?? process.env.POLY_POLYAXION_DIR ?? join(REPO_ROOT, '..', 'polyaxion'));
  let status: PeerStatus;
  if (!existsSync(join(dir, 'packages'))) status = { ok: false, dir, reason: `absent: no Polyaxion checkout at ${dir} (not run, S145)` };
  else {
    const { commit, rows } = pins();
    const problems: string[] = [];
    for (const { file, sha } of rows) {
      const p = join(dir, file);
      if (!existsSync(p)) { problems.push(`${file} is missing`); continue; }
      if (pinDigest(readFileSync(p)) !== sha) problems.push(`${file} differs`);
    }
    status = problems.length
      ? { ok: false, dir, reason: `the peer at ${dir} differs from its pin at ${commit}: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? `; and ${problems.length - 3} more` : ''} (not run, S145)` }
      : { ok: true, dir, commit, files: rows.length };
  }
  if (!opts.dir) cached = status;
  return status;
}

export class PeerUnavailable extends Error {
  constructor(message: string) { super(message); this.name = 'PeerUnavailable'; }
}

/** The Polyaxion package's public surface, from a peer whose every pinned file matches. */
export async function loadPolyaxion(): Promise<any> {
  const peer = polyaxionPeer();
  if (!peer.ok) throw new PeerUnavailable(peer.reason);
  return import(pathToFileURL(join(peer.dir, 'packages', 'polyaxion', 'src', 'index.mjs')).href);
}
