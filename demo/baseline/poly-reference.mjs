// The language reference the poly arm starts with, in tools/poly/ of its workspace (DB3). It is the project's own README, its two
// specifications and three small examples, with the passages removed that work through a refund, a Stripe call or the double-charge case.
// The arm may read what the language does (retry, class and idempotent are features and stay); it is not handed a worked case of the
// task. The edits are exact strings, each of which must match once, so a change to a source document that moves one fails the build of
// the workspace instead of leaving the passage in. The pre-registration records the list of files and a digest of what they hold.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** What the arm gets, as [source in the repository, path in tools/poly/]. A folder is copied whole. */
export const REFERENCE_SOURCES = [
  ['README.md', 'README.md'],
  ['docs/03-technical-spec.md', 'docs/03-technical-spec.md'],
  ['docs/04-semantics.md', 'docs/04-semantics.md'],
  ['examples/hello', 'examples/hello'],
  ['examples/delivery', 'examples/delivery'],
  ['examples/evidence', 'examples/evidence'],
];

/** Where a poly user is told that poly does not do everything: the README must say it, because the arm's text points there. */
const HOST_PARAGRAPH = `**What poly does not express.** A poly program is the stateful core: machines, their actions, their effects and the properties checked over them. The code around it is ordinary JavaScript (or TypeScript), written beside the poly modules in the same project: the HTTP server that receives requests, and the handler of each effect, which makes the call to the outside system. The host loads the build with \`load\`, feeds the machines with \`rt.dispatch\`, and registers a handler for each effect kind with \`rt.handle\` (the host API, in \`docs/03-technical-spec.md\`).

`;

/**
 * Edits by file, applied in order. \`replace\` swaps an exact string, \`line\` replaces (or, with null, deletes) the one line that starts with
 * a prefix, \`cut\` deletes from the line that starts with the first prefix up to, not including, the line that starts with the second.
 * Each must match exactly once.
 */
export const REFERENCE_EDITS = {
  'README.md': [
    { cut: ['## A second look: the double charge', '## A third look: machines that talk'] },
    { replace: ['Handlers are pure functions of the pre-state:', `${HOST_PARAGRAPH}Handlers are pure functions of the pre-state:`] },
  ],
  'docs/03-technical-spec.md': [
    { line: ['This source contains three findings.', 'This source contains one finding.'] },
    { line: ['2. **Double charge.**', null] },
    { line: ['3. **Emit without state change.**', null] },
    { replace: ['`signal pay -> Refund()` lowers', '`signal pay -> Cancel()` lowers'] },
    { replace: ['credential payments: oauth2 {\n  provider "stripe-connect"', 'credential calendar: oauth2 {\n  provider "example-provider"'] },
    { replace: ['effect refund(merchant: Principal, amount: 0..500) {\n  kind "payments.refund"', 'effect sync(merchant: Principal, amount: 0..500) {\n  kind "calendar.sync"'] },
    { replace: ['targets { egress: "https://api.stripe.com/v1/refunds" }\n  uses payments { read_write } for merchant', 'targets { egress: "https://api.example.com/v1/sync" }\n  uses calendar { read_write } for merchant'] },
    { replace: ["The example's profile is Stripe Connect's, as its OAuth reference documents it: the scopes", "The example's profile is a provider's, with the scopes"] },
    { replace: ['`class none` on a refund passes.', '`class none` on a write passes.'] },
  ],
  'docs/04-semantics.md': [
    { replace: ['For an irreversible one (a refund, a charge) it is the defect.', 'For an irreversible one it is the defect.'] },
    { replace: ['an agent could write `class none` on a refund and be `CLEAN`', 'an agent could write `class none` on a write and be `CLEAN`'] },
  ],
};

const once = (text, needle, what) => {
  const at = text.indexOf(needle);
  if (at < 0 || text.indexOf(needle, at + 1) >= 0) throw new Error(`poly reference edit does not match exactly once: ${what}`);
  return at;
};

/** Applies the edits of one file to its text. Throws if an edit does not match exactly once. */
export function applyEdits(rel, text, edits = REFERENCE_EDITS[rel] ?? []) {
  let t = text;
  for (const e of edits) {
    if (e.replace) {
      const at = once(t, e.replace[0], e.replace[0].slice(0, 60));
      t = t.slice(0, at) + e.replace[1] + t.slice(at + e.replace[0].length);
    } else if (e.line) {
      const at = once(t, `\n${e.line[0]}`, e.line[0]) + 1;
      const end = t.indexOf('\n', at);
      t = t.slice(0, at) + (e.line[1] === null ? '' : e.line[1] + t.slice(end, end + 1)) + t.slice(end + 1);
    } else if (e.cut) {
      const from = once(t, `\n${e.cut[0]}`, e.cut[0]) + 1;
      const to = once(t, `\n${e.cut[1]}`, e.cut[1]) + 1;
      if (to <= from) throw new Error(`poly reference cut runs backwards: ${e.cut[0]}`);
      t = t.slice(0, from) + t.slice(to);
    } else throw new Error('unknown poly reference edit');
  }
  return t;
}

/** Writes the reference into \`<ws>/tools/poly\` from the repository at \`root\`. */
export function writeReference(ws, root) {
  for (const [from, to] of REFERENCE_SOURCES) {
    const dest = join(ws, 'tools', 'poly', to);
    mkdirSync(dirname(dest), { recursive: true });
    if (REFERENCE_EDITS[from]) writeFileSync(dest, applyEdits(from, readFileSync(join(root, from), 'utf8')));
    else cpSync(join(root, from), dest, { recursive: true });
  }
}
