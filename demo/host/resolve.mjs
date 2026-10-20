// DF21: a person ends the Unknown state of a Desk's refund ledger (DF19). Two parts. `operatorVerifier` is the host's verifier of the
// claims of `Resolve`: the person-key adapter of S107 over the certified keyrings, reduced to the claims type `Operator`, which has the
// principal alone. The adapter's own output has four fields (kind, attestation, assurance, principal); the checks of the first three are
// its (K11), and the claims type keeps the Desk's check small (939,206 transitions and 16 minutes with four fields, 484,008 and 7 with
// one). `runResolve` is the line the presenter's prompt prints for `resolve <desk> done|not-done`, as `runApprove` is for `approve`.
import { personKeyVerifier } from '@poly/runtime';

/** The claims of Resolve for a person's signed invocation record, else null: an agent key, an unknown key, another dispatch, anything else. */
export function operatorVerifier(keyrings) {
  const person = personKeyVerifier(keyrings);
  return (credentials, ctx) => {
    const claims = person(credentials, ctx);
    if (!claims || claims.kind !== 'Person' || claims.attest !== 'Verified' || claims.assurance !== 3) return null;
    return { principal: claims.principal };
  };
}

// A thrown value can be anything: an Error, a string, a plain object with a message, an object with no prototype, null.
function messageOf(e) {
  try {
    if (e instanceof Error) return e.message;
    if (e && typeof e === 'object' && typeof e.message === 'string') return e.message;
    return String(e);
  } catch { return 'unreadable error'; }
}
const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim();

const USAGE = 'usage: resolve <desk> done|not-done';

/** Runs the resolution and returns { ok, line }; it never throws. */
export async function runResolve(demo, desk, outcome) {
  if (typeof desk !== 'string' || desk === '' || (outcome !== 'done' && outcome !== 'not-done')) return { ok: false, line: USAGE };
  try {
    const r = await demo.resolve(desk, outcome);
    return { ok: true, line: `resolved: desk ${desk} is ${outcome === 'done' ? 'issued' : 'none'}, signed by the presenter key ${r.by}` };
  } catch (e) {
    const message = oneLine(messageOf(e)).replace(/^resolve refused: /, '').slice(0, 200);
    return { ok: false, line: `resolve refused: ${message}` };
  }
}
