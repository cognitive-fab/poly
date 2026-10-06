// polysec notary — canonical windows made into chained, signed receipts
// (docs/polysec-notary-spec.md §4, §5, §12 step 2).
//
// A receipt proves that a decision WAS RECORDED AS MADE, by a named policy
// that passed a named proof, and has not been altered or removed since. It
// does not prove the gate saw every call — that residual is confinement, and
// it is unchanged (§0).
//
// Three digests travel together, and the third is the one that makes a receipt
// worth more than a signed log:
//   window  — the decision itself, canonical and therefore comparable
//   policy  — the exact artefacts that made it (module + manifest + contract)
//   verdict — the security-report.json proving THAT policy fully mediated
//
// Signing is OFF the decision path (§8): the gate decides, journals, returns;
// chaining and signing happen after. A slow notary can never change a verdict.
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canon, digest, canonicalWindow } from './polysec-canon.mjs';
import { loadSpec, makeMediator } from './polysec-lib.mjs';
import { catalogueDigest } from './polysec-catalogue.mjs';

export const RECEIPT_V = 1;
export const ALG = 'ed25519';

// ── keys ────────────────────────────────────────────────────────────────────

/**
 * DEMO KEYS ONLY. Derives a deterministic ed25519 key from a seed phrase so
 * the examples are reproducible and NO key material lives in the repository.
 * A deterministic key is a demo affordance, never a deployment: anyone reading
 * the seed holds the key. Production loads from a file or a KMS handle.
 */
export function demoKeyFromSeed(seedPhrase) {
  const seed = createHash('sha256').update(String(seedPhrase), 'utf8').digest(); // 32 bytes
  // PKCS#8 wrapper for a raw Ed25519 seed (RFC 8410): fixed 16-byte prefix.
  const pkcs8 = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    seed,
  ]);
  const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

/** Export a public key as base64 SPKI — safe to commit, safe to publish. */
export function publicKeyB64(publicKey) {
  return publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
}

/** Re-import a public key exported by publicKeyB64(). */
export function publicKeyFromB64(b64) {
  return createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
}

// ── the three digests ───────────────────────────────────────────────────────

/**
 * Digest of the artefacts that made the decision. Binds a receipt to the exact
 * policy — the runtime half of the coherence gate. Sources are hashed as bytes
 * (the module is code, not data) under sorted role names.
 */
export function policyDigest({ module: modulePath, security, contract, tools = null, catalogue = null }) {
  const parts = {
    module: 'sha256:' + createHash('sha256').update(readFileSync(resolve(modulePath))).digest('hex'),
    security: 'sha256:' + createHash('sha256').update(readFileSync(resolve(security))).digest('hex'),
  };
  if (contract) parts.contract = 'sha256:' + createHash('sha256').update(readFileSync(resolve(contract))).digest('hex');
  if (tools) parts.tools = digest(tools);
  // THE CATALOGUE IS PART OF THE POLICY (v1 track 3, item 9).
  //
  // It was not, and that was a hole exactly where currency was designed to
  // work: a later catalogue relabels a tool you use, you do not re-import, and
  // your receipt stays PERFECTLY CURRENT against a security.json that is
  // quietly wrong. Binding the catalogue makes that move visible as degraded.
  //
  // OPTIONAL, so receipts issued before this verify unchanged — they simply
  // cannot say which catalogue they used, and `verifyAll` reports that rather
  // than failing them or pretending they were bound.
  if (catalogue) parts.catalogue = catalogue;
  return digest(parts);
}

/**
 * Digest of the verdict that proved the policy, plus the pass/fail it carried.
 * `verify` (§7) refuses a receipt whose verdict digest names a report that did
 * not pass — which is the whole point of carrying the field.
 */
export function verdictDigest(report) {
  if (!report || typeof report !== 'object') throw new Error('verdictDigest: no security report');
  return digest(report);
}

export function reportPassed(report) {
  return !!(report && report.verdict && report.verdict.fullyMediated === true);
}

// ── signing ─────────────────────────────────────────────────────────────────

/** The bytes a signature covers: everything in the receipt except the signature. */
export function receiptPreimage(r) {
  const { sig, ...rest } = r;
  return canon(rest);
}

export function makeSigner({ keyId, privateKey }) {
  if (!keyId) throw new Error('makeSigner: a key id is required — receipts name the key, never carry it');
  return {
    keyId,
    sign(preimage) { return edSign(null, Buffer.from(preimage, 'utf8'), privateKey).toString('base64'); },
  };
}

export function verifyReceiptSignature(receipt, publicKey) {
  if (!receipt || typeof receipt.sig !== 'string') return false;
  try {
    return edVerify(null, Buffer.from(receiptPreimage(receipt), 'utf8'), publicKey, Buffer.from(receipt.sig, 'base64'));
  } catch { return false; }
}

// ── the chain ───────────────────────────────────────────────────────────────

/**
 * Turn journal windows into a receipt stream. `prev`/`seq` chain PER SESSION —
 * cross-session ordering is not claimed, because sessions are concurrent and a
 * total order would be a lie (§4).
 *
 * REJECTS ARE RECEIPTED. Doctrine 3 says default-deny does not count unless
 * refusal is observable; a receipt stream containing only allows is a record
 * of half the gate's behaviour.
 */
export function notarize({ journal, policy, verdict, provenAt, signer, setLike = new Set(), sessionOf = defaultSessionOf }) {
  if (!Array.isArray(journal) || journal.length === 0) {
    throw new Error('notarize: empty journal — nothing to receipt (no silent-clean)');
  }
  if (!policy || !verdict) throw new Error('notarize: a receipt must bind both its policy and its verdict');
  if (!Number.isInteger(provenAt)) throw new Error('notarize: provenAt must be integer ms (the checker is clockless; this is captured at signing)');

  const heads = new Map();   // session -> { prev, seq }
  const receipts = [];
  for (const w of journal) {
    const session = sessionOf(w);
    const head = heads.get(session) || { prev: null, seq: 0 };
    const receipt = {
      v: RECEIPT_V,
      session,
      window: digest(canon(canonicalWindow(w, { setLike }), { setLike })),
      policy, verdict, provenAt,
      prev: head.prev,
      seq: head.seq,
      alg: ALG,
      key: signer.keyId,
    };
    receipt.sig = signer.sign(receiptPreimage(receipt));
    receipts.push(receipt);
    heads.set(session, { prev: digest(receiptPreimage(receipt)), seq: head.seq + 1 });
  }
  return receipts;
}

export function defaultSessionOf(w) {
  return (w && (w.session || (w.principal && w.principal.session))) || 'default';
}

/**
 * Chain continuity per session: `seq` monotonic from 0, `prev` equal to the
 * previous receipt's own digest. Per-entry signatures detect edits; only the
 * chain detects DELETION and REORDERING. Returns the first break, or null.
 */
export function chainBreak(receipts) {
  const heads = new Map();
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    const head = heads.get(r.session) || { prev: null, seq: 0 };
    if (r.seq !== head.seq) {
      return { index: i, session: r.session, why: `seq ${r.seq} where ${head.seq} was expected — a receipt was deleted or reordered` };
    }
    if ((r.prev || null) !== (head.prev || null)) {
      return { index: i, session: r.session, why: 'prev does not match the previous receipt in this session' };
    }
    heads.set(r.session, { prev: digest(receiptPreimage(r)), seq: r.seq + 1 });
  }
  return null;
}

// ── verification (§7) ───────────────────────────────────────────────────────

/**
 * The four checks, all local, all deterministic. Returns a structured result;
 * `ok` is false if ANY check fails, and every failure names what and where.
 *
 * Note the shape: receipts carry the window DIGEST, not the window. So
 * verification consumes the journal too — the digest match is how a rewritten
 * journal is caught, and the replay is how a journal that no policy would have
 * produced is caught. Signature alone proves only that nobody edited the
 * receipt.
 */
/**
 * ── CURRENCY vs BINDING (system spec §8, "verdict staleness") ───────────────
 *
 * A receipt whose bound digests do not match the artifacts in front of you has
 * always failed BINDING. That is right when the question is *"do these receipts
 * attest decisions made under the policy I am running right now?"* — the deploy
 * and runtime question, and it must stay fail-closed.
 *
 * It is wrong when the question is *"is this archived evidence intact and
 * true?"* A receipt recording a decision made under v1 is a TRUE RECORD of that
 * decision. The policy moving to v2 afterwards does not falsify it; it means
 * the receipt tells you nothing about v2. Reporting that as "the receipt is
 * invalid" tells an auditor the record was forged, which is a different and
 * much more serious accusation than the truth.
 *
 * So the two are separated rather than merged:
 *
 *   binding   unchanged, still fails by default (`expectCurrent: true`).
 *   currency  ALWAYS computed, never folded into `ok`. Says whether the
 *             receipt is about the artifacts supplied now, and how old the
 *             proof behind it was when it was signed.
 *
 * `expectCurrent: false` is the archive question: a digest mismatch then
 * downgrades to `degraded` instead of failing. Nothing about the default
 * changes, so no existing gate is weakened by this.
 *
 * `maxAgeMs` needs `now` passed in. The checker is clockless everywhere else
 * and stays clockless here: a verifier that read the wall clock would give a
 * different answer tomorrow for the same bytes.
 */
/**
 * Append a KEY ROTATION to a receipt stream.
 *
 * Specified in `polysec-notary-spec.md` §"Key rotation" long before it
 * existed: *a rotation is an entry in the chain, signed by the outgoing key;
 * history stays verifiable across rotations.* The receipt already carried a
 * `key` id "so rotation does not invalidate history" — the field was there and
 * nothing ever wrote a second value into it.
 *
 * The outgoing key signs, which is the whole mechanism: the departing key
 * attests its successor, so a verifier holding only the FIRST public key can
 * walk the chain forward and pick up each new key as it is introduced.
 *
 * A rotation is NOT a revocation. Receipts signed by a retired key stay valid
 * — they were true when they were made. Compromise is a different statement
 * and this does not make it; that absence is deliberate and recorded.
 */
export function rotate({ receipts, session = 'default', to, toPublicKey, signer, policy = null, verdict = null, provenAt }) {
  if (!Array.isArray(receipts)) throw new Error('rotate: pass the existing receipt stream — a rotation is an entry IN the chain, not a document beside it');
  if (!to) throw new Error('rotate: the incoming key id is required');
  if (!toPublicKey) throw new Error('rotate: the incoming PUBLIC key must travel in the receipt, or a verifier cannot continue past the rotation');
  if (!signer) throw new Error('rotate: the OUTGOING signer must sign — that is what attests the successor');
  if (to === signer.keyId) throw new Error(`rotate: '${to}' is already the active key — a rotation that rotates nothing hides a mistake rather than recording one`);
  if (!Number.isInteger(provenAt)) throw new Error('rotate: provenAt must be integer ms');

  const mine = receipts.filter((r) => r.session === session);
  const last = mine.length ? mine[mine.length - 1] : null;
  const receipt = {
    v: RECEIPT_V,
    session,
    type: 'rotation',
    window: null,
    policy: policy || (last && last.policy) || null,
    verdict: verdict || (last && last.verdict) || null,
    provenAt,
    rotation: { from: signer.keyId, to, toPublicKey: publicKeyB64(toPublicKey) },
    prev: last ? digest(receiptPreimage(last)) : null,
    seq: last ? last.seq + 1 : 0,
    alg: ALG,
    key: signer.keyId,
  };
  receipt.sig = signer.sign(receiptPreimage(receipt));
  return receipt;
}

/** The key a receipt must verify under, walking rotations forward. */
export function keyAt(receipts, index, firstPublicKey) {
  let active = firstPublicKey;
  for (let i = 0; i < index; i++) {
    const r = receipts[i];
    if (r && r.type === 'rotation' && r.rotation && r.rotation.toPublicKey) {
      active = publicKeyFromB64(r.rotation.toPublicKey);
    }
  }
  return active;
}

export function verifyAll({
  receipts, journal, publicKey, policyExpected = null, verdictExpected = null,
  report = null, spec = null, setLike = new Set(),
  expectCurrent = true, maxAgeMs = null, now = null,
}) {
  if (!Array.isArray(receipts) || receipts.length === 0) throw new Error('verify: no receipts');

  // 1 — SIGNATURE: every receipt verifies under the key ACTIVE AT ITS POINT IN
  // THE CHAIN. A rotation entry is signed by the OUTGOING key and carries the
  // incoming public key, so a verifier holding only the first key can walk
  // forward. History before a rotation stays verifiable forever.
  //
  // Walked ONCE, carrying the active key forward. `keyAt` rescanned the whole
  // prefix per receipt, which was O(n²) over a stream that grows without
  // bound — and worse, it adopted a rotation's `toPublicKey` before that
  // rotation's own signature had been checked, so a forged rotation moved the
  // key and every subsequent receipt was blamed instead of the forgery.
  // Adopting only AFTER the rotation verifies keeps the failure pointed at
  // the receipt that actually lied.
  const badSigs = [];
  let active = publicKey;
  for (const r of receipts) {
    const ok = verifyReceiptSignature(r, active);
    if (!ok) badSigs.push({ session: r.session, seq: r.seq, key: r.key });
    if (ok && r.type === 'rotation' && r.rotation && r.rotation.toPublicKey) {
      active = publicKeyFromB64(r.rotation.toPublicKey);
    }
  }
  const signature = { ok: badSigs.length === 0, checked: receipts.length, failures: badSigs };

  // 2 — CHAIN: prev/seq continuous per session; catches deletion and reorder.
  const brk = chainBreak(receipts);
  const chain = { ok: !brk, sessions: new Set(receipts.map((r) => r.session)).size, break: brk };

  // 3 — BINDING: the receipt names THIS policy, THIS verdict, and that verdict
  //     must be a pass. A receipt from a policy harden did not clear fails here.
  const bindingFailures = [];
  const drifted = [];
  if (policyExpected) {
    const wrong = receipts.filter((r) => r.policy !== policyExpected);
    if (wrong.length) {
      drifted.push({ what: 'policy', bound: receipts[0].policy, supplied: policyExpected, count: wrong.length });
      if (expectCurrent) bindingFailures.push({ what: 'policy', why: 'receipt policy digest does not match the supplied artefacts', count: wrong.length });
    }
  }
  if (verdictExpected) {
    const wrong = receipts.filter((r) => r.verdict !== verdictExpected);
    if (wrong.length) {
      drifted.push({ what: 'verdict', bound: receipts[0].verdict, supplied: verdictExpected, count: wrong.length });
      if (expectCurrent) bindingFailures.push({ what: 'verdict', why: 'receipt verdict digest does not match the supplied report', count: wrong.length });
    }
  }
  // A receipt bound to a FAILING report is a binding failure in either mode:
  // the decisions were made by a policy harden never cleared, and no amount of
  // archival distance makes that acceptable.
  if (report && !reportPassed(report)) {
    bindingFailures.push({ what: 'verdict', why: 'the bound report is NOT a pass — these decisions were made by a policy harden did not clear' });
  }
  const binding = { ok: bindingFailures.length === 0, failures: bindingFailures };

  // 3b — CURRENCY: does this receipt say anything about the policy in front of
  //      me *now*, and how old was the proof it rode on? A status, never a
  //      verdict — it does not touch `ok`.
  const provenAts = [...new Set(receipts.map((r) => r.provenAt).filter((x) => Number.isInteger(x)))].sort();
  let age = null;
  let stale = false;
  if (maxAgeMs !== null) {
    if (!Number.isInteger(now)) throw new Error('verify: maxAgeMs needs an integer `now` — the verifier is clockless, so the caller supplies the clock (same bytes must give the same answer tomorrow)');
    if (provenAts.length) {
      age = now - provenAts[0];   // the OLDEST proof in the stream sets the age
      stale = age > maxAgeMs;
    }
  }
  const currency = {
    current: drifted.length === 0,
    degraded: drifted.length > 0 || stale,
    drifted,
    provenAt: provenAts.length ? provenAts[0] : null,
    provenAtSpan: provenAts.length > 1 ? [provenAts[0], provenAts[provenAts.length - 1]] : null,
    ageMs: age,
    stale,
    checkedAgainstCurrent: !!(policyExpected || verdictExpected),
    reason: drifted.length
      ? (expectCurrent
        ? `the receipts are bound to ${drifted.map((d) => d.what).join(' and ')} digest(s) that differ from the artefacts supplied — reported as a BINDING FAILURE because this run asked the current-policy question (pass expectCurrent:false to ask the archive question instead)`
        : `DEGRADED: these receipts are a true record of decisions made under a policy that has since changed (${drifted.map((d) => d.what).join(', ')} differs). They remain intact and verifiable; they say nothing about the policy running now`)
      : stale
        ? `DEGRADED: intact and current, but the proof behind these receipts was ${Math.round(age / 86400000)} day(s) old at the age limit supplied — evidence about a proof nobody has re-run`
        : !(policyExpected || verdictExpected)
          ? 'currency NOT CHECKED — no policy/verdict digests were supplied to compare against, so nothing here says whether these receipts describe the current policy'
          : 'current: the receipts are bound to the artefacts supplied',
  };

  // 4 — REPLAY: does the deployed machine actually produce these decisions?
  //     `polyrun audit`'s drift = intrusion, promoted to a verifier step.
  let replay = { ok: true, ran: false, reason: 'no journal or module supplied — replay SKIPPED (verification is weaker)', failures: [] };
  if (journal && spec) {
    const failures = [];
    if (journal.length !== receipts.length) {
      failures.push({ what: 'count', why: `journal has ${journal.length} window(s) but there are ${receipts.length} receipt(s)` });
    }
    const { mediate } = makeMediator(spec);
    const n = Math.min(journal.length, receipts.length);
    for (let i = 0; i < n; i++) {
      const w = journal[i];
      const r = receipts[i];
      // (a) the receipt must be a receipt OF THIS window
      const d = digest(canon(canonicalWindow(w, { setLike }), { setLike }));
      if (d !== r.window) {
        failures.push({ index: i, what: 'window', why: 'journal window does not match the digest this receipt was signed over — the record was altered after signing' });
        continue;
      }
      // (b) the machine must in fact produce the recorded decision and post-state
      const m = mediate(w.pre, w.action, w.data || {});
      if (m.decision !== w.decision) {
        failures.push({ index: i, what: 'decision', why: `replay says '${m.decision}' where the record says '${w.decision}'`, action: w.action });
      } else if (canon(m.post, { setLike }) !== canon(w.post, { setLike })) {
        failures.push({ index: i, what: 'post', why: 'replay reaches a different post-state than the record', action: w.action });
      }
    }
    replay = { ok: failures.length === 0, ran: true, checked: n, failures };
  }

  return {
    // `ok` is the FOUR checks, unchanged. Currency is deliberately not in it:
    // a true record of a past decision is not a failed verification, and
    // folding a status into a verdict is how "degraded" quietly becomes
    // "broken" in somebody's dashboard.
    ok: signature.ok && chain.ok && binding.ok && replay.ok,
    checks: { signature, chain, binding, replay },
    currency,
    degraded: currency.degraded,
  };
}

export function readReceipts(pathArg) {
  const text = readFileSync(resolve(pathArg), 'utf-8');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new Error(`receipts '${pathArg}' is empty — an empty stream is not a clean audit`);
  return lines.map((l, i) => {
    try { return JSON.parse(l); } catch (e) { throw new Error(`receipts '${pathArg}' line ${i + 1}: ${e && e.message}`); }
  });
}

export function writeReceipts(pathArg, receipts) {
  const abs = resolve(pathArg);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, receipts.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return abs;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const USAGE = `usage: node polysec-notary.mjs <sign|verify> [options]

  sign    --journal <j.ndjson> --module <next.cjs> --security <security.json>
          --report <security-report.json> [--contract <c.json>] [--out <dir|file>]
          [--notary <notary.json>] [--proven-at <ms>] [--set-like a,b] [--allow-unproven]

  verify  --receipts <r.ndjson> [--journal <j.ndjson>] [--module <next.cjs>]
          [--security <security.json>] [--contract <c.json>] [--report <report.json>]
          [--notary <notary.json> | --pubkey <base64>] [--set-like a,b]

Exit codes: 0 = every check passed · 1 = a check FAILED · 2 = could not run.`;

// Run as a CLI when this file — or the shim that re-exports it from packages/polysec/scripts — is the entry point.
if (process.argv[1] && basename(resolve(process.argv[1])) === basename(fileURLToPath(import.meta.url))) {
  const cmd = process.argv[2];
  const args = {};
  for (let i = 3; i < process.argv.length; i++) {
    if (!process.argv[i].startsWith('--')) continue;
    const k = process.argv[i].slice(2); const n = process.argv[i + 1];
    if (n === undefined || n.startsWith('--')) args[k] = true; else { args[k] = n; i++; }
  }
  if (process.env.ANTHROPIC_API_KEY) {
    console.error('note: polysec notary makes NO model calls; ANTHROPIC_API_KEY is set but will not be used.');
  }
  const setLike = new Set(String(args['set-like'] || '').split(',').map((s) => s.trim()).filter(Boolean));
  const cfgOf = () => (args.notary ? JSON.parse(readFileSync(resolve(args.notary), 'utf-8')) : {});

  if (cmd === 'sign') {
    if (!args.journal || !args.module || !args.security || !args.report) { console.error(USAGE); process.exit(2); }
    try {
      const cfg = cfgOf();
      const keyId = cfg.key || 'demo-key';
      const seed = cfg.demoSeed || process.env.POLYSEC_NOTARY_SEED;
      if (!seed) throw new Error('no signing key: give notary.json a demoSeed (examples) or set POLYSEC_NOTARY_SEED');
      const { privateKey, publicKey } = demoKeyFromSeed(seed);

      const report = JSON.parse(readFileSync(resolve(args.report), 'utf-8'));
      if (!reportPassed(report) && !args['allow-unproven']) {
        // Signing an unproven policy is well-evidenced negligence (§0).
        throw new Error(`the report at '${args.report}' is NOT a pass — refusing to sign decisions by a policy harden did not clear (override: --allow-unproven)`);
      }
      if (!reportPassed(report)) console.error('WARNING: signing against a FAILED verdict because --allow-unproven was given.');

      const journal = readReceipts(args.journal);
      const provenAt = args['proven-at'] ? Number(args['proven-at']) : Math.floor(statSync(resolve(args.report)).mtimeMs);
      const receipts = notarize({
        journal,
        policy: policyDigest({ module: args.module, security: args.security, contract: args.contract, catalogue: catalogueDigest() }),
        verdict: verdictDigest(report),
        provenAt,
        signer: makeSigner({ keyId, privateKey }),
        setLike,
      });
      const outArg = args.out ? resolve(args.out) : resolve(dirname(args.journal), '..', 'out');
      const outFile = outArg.endsWith('.ndjson') ? outArg : join(outArg, 'receipts.ndjson');
      writeReceipts(outFile, receipts);

      const rejects = journal.filter((w) => w.decision === 'reject').length;
      console.log(`# polysec notary sign — ${receipts.length} receipt(s)`);
      console.log(`  key       ${keyId} (${ALG})`);
      console.log(`  policy    ${receipts[0].policy}`);
      console.log(`  verdict   ${receipts[0].verdict}  (report: ${reportPassed(report) ? 'PASS' : 'FAIL — UNPROVEN'})`);
      console.log(`  sessions  ${new Set(receipts.map((r) => r.session)).size}`);
      console.log(`  rejects   ${rejects} receipted (a stream of only allows is half the gate's behaviour)`);
      console.log(`  chain     ${chainBreak(receipts) ? 'BROKEN' : 'continuous'}`);
      console.log(`\nwrote ${outFile}`);
      console.log(`public key (safe to publish): ${publicKeyB64(publicKey)}`);
      process.exit(0);
    } catch (e) { console.error(`polysec notary sign FAILED: ${e && e.message}`); process.exit(2); }
  }

  if (cmd === 'verify') {
    if (!args.receipts) { console.error(USAGE); process.exit(2); }
    let result, report = null;
    try {
      const cfg = cfgOf();
      const publicKey = args.pubkey
        ? publicKeyFromB64(args.pubkey)
        : demoKeyFromSeed(cfg.demoSeed || process.env.POLYSEC_NOTARY_SEED || '').publicKey;
      const receipts = readReceipts(args.receipts);
      const journal = args.journal ? readReceipts(args.journal) : null;
      const spec = args.module ? loadSpec(args.module) : null;
      report = args.report ? JSON.parse(readFileSync(resolve(args.report), 'utf-8')) : null;
      const policyExpected = (args.module && args.security)
        ? policyDigest({ module: args.module, security: args.security, contract: args.contract, catalogue: catalogueDigest() }) : null;
      const verdictExpected = report ? verdictDigest(report) : null;

      result = verifyAll({
        receipts, journal, publicKey, policyExpected, verdictExpected, report, spec, setLike,
        // --archive asks the ARCHIVE question (is this evidence intact and
        // true?) instead of the current-policy question. Default stays
        // fail-closed on drift.
        expectCurrent: !('archive' in args),
        maxAgeMs: args['max-age-days'] ? Number(args['max-age-days']) * 86400000 : null,
        now: args.now ? Number(args.now) : null,
      });
    } catch (e) { console.error(`polysec notary verify FAILED: ${e && e.message}`); process.exit(2); }

    const { checks } = result;
    const mark = (c) => (c.ok ? 'PASS ✓' : 'FAIL ✗');
    // A green headline over degraded evidence is the exact misreading the
    // currency status exists to prevent, so it never appears unqualified.
    const headline = !result.ok ? 'VERIFICATION FAILED ✗'
      : result.degraded ? 'CHECKS PASSED, EVIDENCE DEGRADED ~'
      : 'ALL CHECKS PASSED ✓';
    console.log(`# polysec notary verify — ${headline}\n`);
    console.log(`| check      | result |`);
    console.log(`|------------|--------|`);
    console.log(`| signature  | ${mark(checks.signature)} (${checks.signature.checked} receipt(s)) |`);
    console.log(`| chain      | ${mark(checks.chain)} (${checks.chain.sessions} session(s)) |`);
    console.log(`| binding    | ${mark(checks.binding)} |`);
    console.log(`| replay     | ${checks.replay.ran ? `${mark(checks.replay)} (${checks.replay.checked} window(s))` : 'SKIPPED'} |`);
    const cur = result.currency;
    console.log(`| currency   | ${!cur.checkedAgainstCurrent ? 'NOT CHECKED' : cur.degraded ? 'DEGRADED ~' : 'current ✓'} |`);
    console.log('');
    console.log(`currency: ${cur.reason}`);

    if (!checks.signature.ok) {
      console.log(`\n## signature`);
      for (const f of checks.signature.failures) console.log(`  ✗ session '${f.session}' seq ${f.seq}: does not verify under key '${f.key}' — the receipt was EDITED after signing`);
    }
    if (!checks.chain.ok) {
      console.log(`\n## chain`);
      const b = checks.chain.break;
      console.log(`  ✗ session '${b.session}' at index ${b.index}: ${b.why}`);
      console.log(`    (per-entry signatures cannot see this — only the chain detects deletion and reordering)`);
    }
    if (!checks.binding.ok) {
      console.log(`\n## binding`);
      for (const f of checks.binding.failures) console.log(`  ✗ ${f.what}: ${f.why}${f.count ? ` (${f.count} receipt(s))` : ''}`);
    }
    if (checks.replay.ran && !checks.replay.ok) {
      console.log(`\n## replay — drift = intrusion`);
      for (const f of checks.replay.failures) {
        console.log(`  ✗ window ${f.index ?? '-'} ${f.action ? `(${f.action}) ` : ''}[${f.what}]: ${f.why}`);
      }
    }
    if (!checks.replay.ran) {
      console.log(`\nnote: ${checks.replay.reason}`);
      console.log('      Signature proves nobody edited the record. Only replay proves the record is');
      console.log('      what that policy would have produced — pass --journal and --module.');
    }
    console.log('\n> A receipt proves a decision was recorded as made, by a named policy that passed a');
    console.log('> named proof, and has not been altered since. It does not prove the gate saw every');
    console.log('> call — that residual is confinement (notary spec §0), unchanged.');
    process.exit(result.ok ? 0 : 1);
  }

  console.error(USAGE);
  process.exit(2);
}
