// polyrun shared kernel constants — split out of kernel.mjs so PURE consumers
// (check-product.mjs, and through it `polyvers product`) can import them
// without dragging kernel → store → node:sqlite into their module graph.
// node:sqlite does not exist on Node 20/21 and is experimental on 22+; a
// static model checker (and every polyvers command, whose CLI imports the
// product module) must not fail-to-import or emit sqlite warnings over two
// constants.
'use strict';

// The kernel's synthetic journal action for instance creation (row 0 of
// every journal). Shared so the DST simulator can filter creation rows out
// of the cascades it hands to transition invariants (the model's cascades
// never contain them — kernel parity of SHAPE, not just state).
export const CREATE_ACTION = '$create';

// Which step classifications are ACCEPTED steps: every one except 'rejected'
// and 'unhandled' ('mutated', 'identity-by-mutation', and sam-pattern 2.3.0's
// 'unchanged', an explicitly framed step that writes nothing but may emit).
// ONE predicate, called by the kernel, check-effects and check-product, so the
// runtime and its two model checkers can never disagree about which steps run
// the effect mapper (check-effects once listed only the first two, and would
// have dropped every emit-only step's effects).
export const isAcceptedClassification = (classification) =>
  typeof classification === 'string' && classification !== 'rejected' && classification !== 'unhandled';

// FR-8: dispatch cascades (parent → child signal → grandchild …) are capped;
// a deeper chain is a wiring cycle, which is a mapper defect. Shared with
// check-product.mjs so the model checker can never drift from the kernel cap.
export const MAX_CASCADE_DEPTH = 8;

/** Strips SAM-internal (__-prefixed) keys and functions from snapshots — the
 *  ONE observable-projection rule (kernel snapshots, checker projections). */
export const sanitizeReplacer = (key, value) => {
  if (typeof key === 'string' && key.startsWith('__')) return undefined;
  if (typeof value === 'function') return undefined;
  return value;
};
