// Module and node digests (PT1.4, PT1.4a, PT12.1).
//
// The digest is the SHA-256 of the RFC 8785 canonical JSON of the AST with
// the per-node `id` and `span` removed. Ids are a function of structure and
// spans are display positions, so neither can distinguish two ASTs that mean
// the same program; comments are not in the AST at all. Two sources with the
// same AST therefore have the same digest, whatever their layout or comments.
import { createHash } from 'node:crypto';
import { canonicalize } from './jcs.js';

/** A deep copy without `id` and `span` keys. */
export function stripped(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripped);
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'id' || k === 'span') continue;
      out[k] = stripped(v);
    }
    return out;
  }
  return node;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** `sha256:<hex>` of any AST node (a module digest when given a Module). */
export function digest(node: unknown): string {
  return 'sha256:' + sha256Hex(canonicalize(stripped(node)));
}
