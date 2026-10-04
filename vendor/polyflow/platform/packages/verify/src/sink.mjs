// Ledger sinks and the head signer — the I/O half of the ledger (tech spec §5.3).
//
// A sink receives each run's events in order, possibly more than once (an
// activity retry re-delivers its header), possibly from several workers. It is
// idempotent on (run, seq): an event it already holds is skipped if identical
// and REPORTED if different, because two different events at the same seq of
// the same run is what tampering, or a split brain, looks like.
//
// A delta is taken whole or not at all (P6-P8 review SV6): if any of its
// events conflicts with a held one, or a new event does not chain from the
// held event before it (a fork), nothing of it is written, and every offending
// seq is reported. Otherwise a fork's continuation would sit on top of the
// real chain, and the run could never verify again.

import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createPrivateKey, createPublicKey, sign, verify, generateKeyPairSync } from 'node:crypto';
import { genesis } from '@cognitive-fab/polyflow-kernel';

/**
 * A path component: every UTF-8 byte outside [A-Za-z0-9_-] becomes '~' and two
 * uppercase hex digits — '.', '~' and '%' included — so no run escapes the
 * root ('..') and no two runs share a file (P9 security SEC-FS1). The Python
 * sink encodes the same way.
 */
const safe = (s) => {
  let out = '';
  for (const b of Buffer.from(String(s), 'utf-8')) {
    const c = String.fromCharCode(b);
    out += /[A-Za-z0-9_-]/.test(c) ? c : `~${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out || '~';
};

/**
 * Split a delta against what a sink holds for its run. `held(seq)` returns
 * { hash, prev } or undefined. Returns the events to write, the count already
 * held, and the seqs that make the delta a conflict or a fork (then `fresh` is
 * empty: the delta is refused whole).
 */
export function partitionDelta(events, held) {
  const fresh = [];
  const conflicts = [];
  let skipped = 0;
  for (const e of events) {
    const had = held(e.seq);
    if (had === undefined) fresh.push(e);
    else if (had.hash === e.hash) skipped++;
    else conflicts.push(e.seq);
  }
  if (!conflicts.length) {
    // A new event must chain from the held event before it, and a held event
    // after it must chain from it: otherwise the delta forks the run.
    const isFresh = new Set(fresh.map((e) => e.seq));
    for (const e of fresh) {
      const before = e.seq === 0 ? { hash: genesis(e.run) } : held(e.seq - 1);
      if (before && !isFresh.has(e.seq - 1) && e.prev !== before.hash) conflicts.push(e.seq);
      const after = isFresh.has(e.seq + 1) ? undefined : held(e.seq + 1);
      if (after && after.prev !== undefined && after.prev !== e.hash) conflicts.push(e.seq + 1);
    }
  }
  return conflicts.length
    ? { fresh: [], skipped: 0, conflicts: [...new Set(conflicts)].sort((a, b) => a - b) }
    : { fresh, skipped, conflicts };
}

/** Where a run's files live under a file sink's root. */
export const runPaths = (root, run) => {
  const dir = join(root, safe(run.ns), safe(run.wf));
  return { dir, events: join(dir, `${safe(run.run)}.jsonl`), heads: join(dir, `${safe(run.run)}.heads.jsonl`) };
};

/**
 * Read a JSONL file. `strict` throws on any unparseable line — what a verifier
 * wants, because a dropped line and a truncated file look the same otherwise
 * (review M6). Non-strict skips bad lines and reports each to `onBad`.
 */
export function readJsonl(path, { strict = false, onBad = () => {} } = {}) {
  const out = [];
  if (!existsSync(path)) return out;
  readFileSync(path, 'utf-8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try { out.push(JSON.parse(line)); } catch {
      if (strict) throw new Error(`${path}:${i + 1}: not a JSON line`);
      onBad(i + 1);
    }
  });
  return out;
}

/**
 * A directory of JSONL files, one per run. Good for tests, single workers and
 * air-gapped installs; the governance service is the multi-worker sink.
 */
export function fileSink(root) {
  const known = new Map(); // runKey -> Map(seq -> { hash, prev })
  const key = (run) => `${run.ns}|${run.wf}|${run.run}`;
  const load = (run) => {
    const k = key(run);
    if (!known.has(k)) {
      const m = new Map();
      for (const e of readJsonl(runPaths(root, run).events)) if (!m.has(e.seq)) m.set(e.seq, { hash: e.hash, prev: e.prev });
      known.set(k, m);
    }
    return known.get(k);
  };
  return {
    kind: 'file',
    root,
    /** @returns {{written:number, skipped:number, conflicts:number[]}} */
    write(events, signedHead) {
      if (!events.length) return { written: 0, skipped: 0, conflicts: [] };
      const run = events[0].run;
      const seen = load(run);
      const p = runPaths(root, run);
      mkdirSync(p.dir, { recursive: true });
      const { fresh, skipped, conflicts } = partitionDelta(events, (seq) => seen.get(seq));
      for (const e of fresh) seen.set(e.seq, { hash: e.hash, prev: e.prev });
      if (fresh.length) appendFileSync(p.events, fresh.map((e) => JSON.stringify(e)).join('\n') + '\n');
      if (signedHead && fresh.length) appendFileSync(p.heads, JSON.stringify(signedHead) + '\n');
      return { written: fresh.length, skipped, conflicts };
    },
    /** The highest contiguous event this sink holds for a run, or null. */
    head(run) {
      const seen = load(run);
      let seq = -1;
      while (seen.has(seq + 1)) seq++;
      return seq < 0 ? null : { seq, hash: seen.get(seq).hash };
    },
    read(run) {
      return { events: readJsonl(runPaths(root, run).events).sort((a, b) => a.seq - b.seq), heads: readJsonl(runPaths(root, run).heads) };
    },
  };
}

/** A sink that keeps everything in memory — tests. */
export function memorySink() {
  const runs = new Map();
  const key = (run) => `${run.ns}|${run.wf}|${run.run}`;
  return {
    kind: 'memory',
    write(events, signedHead) {
      if (!events.length) return { written: 0, skipped: 0, conflicts: [] };
      const k = key(events[0].run);
      if (!runs.has(k)) runs.set(k, { events: new Map(), heads: [] });
      const r = runs.get(k);
      const { fresh, skipped, conflicts } = partitionDelta(events, (seq) => r.events.get(seq));
      for (const e of fresh) r.events.set(e.seq, e);
      if (signedHead && fresh.length) r.heads.push(signedHead);
      return { written: fresh.length, skipped, conflicts };
    },
    head(run) {
      const r = runs.get(key(run));
      if (!r) return null;
      let seq = -1;
      while (r.events.has(seq + 1)) seq++;
      return seq < 0 ? null : { seq, hash: r.events.get(seq).hash };
    },
    read(run) {
      const r = runs.get(key(run));
      return r ? { events: [...r.events.values()].sort((a, b) => a.seq - b.seq), heads: r.heads.slice() } : { events: [], heads: [] };
    },
    runs: () => [...runs.values()].map((r) => [...r.events.values()][0]?.run).filter(Boolean),
  };
}

// ---- signing ---------------------------------------------------------------

/** The bytes a head signature covers. Fixed format, so any language can verify it. */
export const headMessage = (run, head) => `polyflow-head\n${run.ns}\n${run.wf}\n${run.run}\n${head.seq}\n${head.hash}`;

export function generateSigningKey(keyId = 'dev') {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    keyId,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

/** Sign a run's head. `key` = { keyId, privateKeyPem }. */
export function signHead(run, head, key) {
  const sig = sign(null, Buffer.from(headMessage(run, head)), createPrivateKey(key.privateKeyPem));
  return { run, seq: head.seq, hash: head.hash, keyId: key.keyId, alg: 'ed25519', sig: sig.toString('base64') };
}

/** Verify a signed head against a trust store { keyId: publicKeyPem }. */
export function verifyHead(signed, trust) {
  const pem = trust && Object.hasOwn(trust, signed?.keyId) ? trust[signed.keyId] : null;
  if (!pem) return { ok: false, reason: `no trusted key '${signed?.keyId}'` };
  // A malformed head (no run, a signature that is not a string) does not verify; it never throws.
  try {
    const ok = verify(null, Buffer.from(headMessage(signed.run, signed)), createPublicKey(pem), Buffer.from(signed.sig, 'base64'));
    return ok ? { ok: true } : { ok: false, reason: 'signature does not verify' };
  } catch (err) {
    return { ok: false, reason: `malformed signed head: ${err.message}` };
  }
}
