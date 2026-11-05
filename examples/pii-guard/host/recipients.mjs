// The table of approved recipients of the pii-guard example (docs/examples/pii-guard.md, "Recipients", Q6). An address is
// held only as its keyed digest, so the table names no one; an address it does not hold is new.
import { createHmac } from 'node:crypto';

const normal = (address) => String(address).trim().toLowerCase();

/** `{ has, add, digests }` over the HMAC-SHA256 under `key` of each address, trimmed and lowercased. */
export function recipientTable(key, digests = []) {
  const held = new Set(digests);
  const digest = (address) => createHmac('sha256', key).update(normal(address), 'utf8').digest('hex');
  return {
    has: (address) => held.has(digest(address)),
    add: (address) => { held.add(digest(address)); },
    digests: () => [...held].sort(),
  };
}
