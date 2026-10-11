// plan-e3.md E3.3, HT3, S553: the receipt verifier. Deterministic code, no model. It checks a cheaper model's reading of a
// log against the original, and the harness shows the receipt to the agent only when every check passes (HF3.2); the
// machines prove that only a verified receipt is shown, and this file is the assumption "verifier-verdict" of
// assumptions.json. A receipt is JSON: { sourceHash: "sha256:<hex>", status: "pass" | "fail", quotes: [text, ...] }.
//
// The checks, each on one tagged line (// @V-name) so that the tests can seed a mutant verifier that skips it:
//   hash    the receipt's source hash is the hash of the archived log;
//   quote   every quote occurs in the log, byte for byte;
//   status  the receipt's status is the command's (exit status 0 is pass, anything else fail);
//   size    the receipt is smaller than the log.
// Every check runs and every failure is reported, so a rejection names all that were wrong.
import { createHash } from 'node:crypto';

const HASH = /^sha256:[0-9a-f]{64}$/;

/** The hash of a log's bytes, in the receipt's form. */
export const hashOf = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** The receipt a text holds, or null when it is not one. */
export function parseReceipt(text) {
  let r;
  try {
    r = JSON.parse(text);
  } catch {
    return null;
  }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  if (typeof r.sourceHash !== 'string' || !HASH.test(r.sourceHash)) return null;
  if (r.status !== 'pass' && r.status !== 'fail') return null;
  if (!Array.isArray(r.quotes) || r.quotes.length > 64) return null;
  if (!r.quotes.every((q) => typeof q === 'string' && q.length > 0)) return null;
  return r;
}

/**
 * @param {{ receiptText: string, log: Buffer | string, exitStatus: number }} input the receipt as the model wrote it,
 *   the archived log's bytes, and the exit status of the command that wrote the log
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function verifyReceipt({ receiptText, log, exitStatus }) {
  const bytes = Buffer.isBuffer(log) ? log : Buffer.from(String(log), 'utf8');
  const receipt = parseReceipt(receiptText);
  if (!receipt) return { ok: false, reasons: ['malformed'] };
  const reasons = [];
  if (receipt.sourceHash !== hashOf(bytes)) reasons.push('hash-mismatch'); // @V-hash
  for (const q of receipt.quotes) {
    if (bytes.indexOf(Buffer.from(q, 'utf8')) === -1) reasons.push('quote-not-in-log'); // @V-quote
  }
  if (receipt.status !== (exitStatus === 0 ? 'pass' : 'fail')) reasons.push('status-mismatch'); // @V-status
  if (Buffer.byteLength(receiptText, 'utf8') >= bytes.length) reasons.push('not-smaller'); // @V-size
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/**
 * The effect handler of tool.verify. The receipt is the effect's Content payload; the log and the command's exit status
 * come from the turn's archive, through the store capability the effect's label grants. A rejection is a permanent
 * failure, which the runtime completes as the effect's failed outcome without a retry (the runtime test is E3.4's).
 */
export async function verify(payload, caps, ctx) {
  const receiptText = await caps.content.read(payload.receipt);
  const kept = await caps.store.read(`archive/${ctx.instanceId}`);
  const v = verifyReceipt({ receiptText, log: Buffer.from(kept.log, 'base64'), exitStatus: kept.exitStatus });
  if (!v.ok) throw Object.assign(new Error(`receipt refused: ${v.reasons.join(', ')}`), { permanent: true });
  return { ok: true };
}
