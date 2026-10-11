// PS16.4, PT10g (ruled 2026-10-11): which grants of a credential are live in a store, for `poly grant-revoke --credential
// <c> --db <store>`. The store is opened read-only: signing a revocation writes nothing to it, and the runtime that owns
// the store takes the signed record by the approvals folder. A grant is live while its Grant instance is active; a
// revoked one is terminal (`terminal g == Revoked`), and a holder's earlier generations are not the current grant.
import { DatabaseSync } from 'node:sqlite';

/** The instance ids of the live, current grants of a credential in a store, sorted. */
export function liveGrants(dbPath: string, credential: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(
      `SELECT g.instance AS instance FROM poly_grant g JOIN pr_instance i ON i.instance_id = g.instance
       WHERE g.credential = ? AND i.status = 'active'
         AND g.generation = (SELECT MAX(generation) FROM poly_grant WHERE credential = g.credential AND holder = g.holder)
       ORDER BY g.instance`,
    ).all(credential) as { instance: string }[];
    return rows.map((r) => r.instance);
  } finally { db.close(); }
}
