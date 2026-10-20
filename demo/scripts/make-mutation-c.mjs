#!/usr/bin/env node
// DF23 item 4, Act 1 part 4: mutation (c). Two copies of the committed tree of `poly-kept` (never edited), made in an output folder:
//
//   poly-kept-reissue          RefundUnknown goes to Idle and clears `want`, where the kept build goes to Review. An uncertain refund is
//                              treated as a refusal, as the concierge of v1.3.0 did. The shipped properties stay CLEAN (161 states):
//                              they speak of lines confirmed at Stripe (`refunded`), and an uncertain refund is not confirmed.
//   poly-kept-reissue-checked  the same plus the property `no-reissue`, which needs a ghost field and its updates, so it is not one
//                              line: one field (`issued`), three updates (Confirm sets it, RefundFailed and Resolve with `done` false
//                              clear it) and one `never` for each of the four lines. That is 8 lines. With them the check finds, for
//                              each line, a witness of 6 steps: Open, RequestAll, Confirm, RefundUnknown, RequestAll, Confirm.
//
//   node demo/scripts/make-mutation-c.mjs <outdir>
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const KEPT = join(ROOT, 'demo', 'baseline', 'runs', 'poly-kept', 'tree');

function once(text, from, to) {
  if (text.split(from).length !== 2) throw new Error(`the kept tree no longer holds "${from.trim().split('\n')[0]}" exactly once`);
  return text.split(from).join(to);
}

/** The mutation: RefundUnknown goes to Idle, with the request cleared, in place of Review. */
export function reissue(text) {
  return once(text, "  on RefundUnknown {\n    require phase == Refunding else reject \"not-refunding\"\n    phase' = Review\n", "  on RefundUnknown {\n    require phase == Refunding else reject \"not-refunding\"\n    phase' = Idle\n    want' = [false, false, false, false]\n");
}

/** The property no-reissue and the ghost field it reads. */
export function withNoReissueProperty(text) {
  let s = text;
  s = once(s, '    phase    : Phase           = New\n', '    phase    : Phase           = New\n    issued   : map<0..3, bool> = [false, false, false, false]\n');
  s = once(s, "    require phase == Confirming else reject \"nothing-to-confirm\"\n    phase' = Refunding\n    emit refund(", "    require phase == Confirming else reject \"nothing-to-confirm\"\n    phase' = Refunding\n    issued' = [issued[0] || want[0], issued[1] || want[1], issued[2] || want[2], issued[3] || want[3]]\n    emit refund(");
  s = once(s, "  on RefundFailed {\n    require phase == Refunding else reject \"not-refunding\"\n    phase' = Idle\n", "  on RefundFailed {\n    require phase == Refunding else reject \"not-refunding\"\n    phase' = Idle\n    issued' = [issued[0] && !want[0], issued[1] && !want[1], issued[2] && !want[2], issued[3] && !want[3]]\n");
  s = once(s, "    } else {\n      phase' = Idle\n      emit say(msg: RefundFailed", "    } else {\n      phase' = Idle\n      issued' = [issued[0] && !want[0], issued[1] && !want[1], issued[2] && !want[2], issued[3] && !want[3]]\n      emit say(msg: RefundFailed");
  s = once(s, '  // No line is ever refunded twice.\n', '  never no-reissue-0: emit refund(l0: true) while issued[0]\n  never no-reissue-1: emit refund(l1: true) while issued[1]\n  never no-reissue-2: emit refund(l2: true) while issued[2]\n  never no-reissue-3: emit refund(l3: true) while issued[3]\n\n  // No line is ever refunded twice.\n');
  return s;
}

/** Writes the two copies under `out` and returns their folders. */
export function makeMutationC(out) {
  const support = join('src', 'support.poly');
  const original = readFileSync(join(KEPT, support), 'utf8');
  const mutated = reissue(original);
  const folders = { reissue: join(out, 'poly-kept-reissue'), checked: join(out, 'poly-kept-reissue-checked') };
  for (const [folder, text] of [[folders.reissue, mutated], [folders.checked, withNoReissueProperty(mutated)]]) {
    mkdirSync(folder, { recursive: true });
    // .poly holds the build of the kept program, which is not this program's: the checker makes its own in the copy.
    cpSync(KEPT, folder, { recursive: true, filter: (p) => !p.split(/[\\/]/).some((part) => part === 'node_modules' || part === '.poly') });
    writeFileSync(join(folder, support), text);
  }
  return folders;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = process.argv[2];
  if (!out) { console.error('usage: node demo/scripts/make-mutation-c.mjs <outdir>'); process.exit(2); }
  const folders = makeMutationC(out);
  console.log(`${folders.reissue}\n${folders.checked}`);
}
