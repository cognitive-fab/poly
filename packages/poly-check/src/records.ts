// `poly approve` and `poly accept` (PT12.5, PT14, S150): a person signs a record with a key given by file, never one
// under version control (S126). Neither command is offered over MCP; the enforcement is the signature check at the
// runtime and at admission, not the transport.
//
//   poly approve <intent> --by <keyId> --key <file> --db <store> [--out <file>]
//     signs an approval of the intent's latest escalation (the escalated verdict event's hash) and writes the record,
//     which the host hands to rt.approve.
//   poly accept <witness id> --by <keyId> --key <file> [--root <dir>]
//     signs the acceptance of the finding with that witness, from the last report, into <root>/accepted/<id>.json,
//     which admission reads.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { signRecord, type SignedRecord } from '@poly/core';
import { openJournal } from '@poly/runtime';
import { personKey } from './admit.js';
import { lookupWitness } from './witness.js';

export class RecordUsageError extends Error {}

const now = () => new Date().toISOString();

/** The approval record for an intent's latest escalation in a store. */
export async function approvalRecord(db: string, intentId: string, by: string, keyFile: string): Promise<SignedRecord> {
  const reader = openJournal(db);
  try {
    let found: { hash: string; seq: number } | null = null;
    for (const run of await reader.runs()) {
      for (const e of await reader.chain(run.run)) {
        const b = e.body as { intent?: string; outcome?: string } | undefined;
        if (e.kind === 'verdict' && b?.intent === intentId && b?.outcome === 'escalated' && (!found || e.seq > found.seq)) found = { hash: e.hash, seq: e.seq };
      }
    }
    if (!found) throw new RecordUsageError(`no escalation of intent ${intentId} in ${db}`);
    return signRecord({ kind: 'approval', subject: found.hash, by, at: now() }, personKey(keyFile));
  } finally { await reader.close(); }
}

/** The acceptance record of the finding with this witness id (or a 12-digit prefix), from the last report. */
export function acceptanceRecord(report: unknown, witnessId: string, by: string, keyFile: string): { record: SignedRecord; name: string } {
  const looked = lookupWitness(report, witnessId);
  if (!('found' in looked)) throw new RecordUsageError(looked.reason);
  const { report: file, diagnostic } = looked.found;
  if (diagnostic.severity !== 'finding') throw new RecordUsageError(`${diagnostic.code} is not a finding a person can accept (PT12.5)`);
  const record = signRecord({ kind: 'acceptance', subject: `${file.moduleDigest}:${diagnostic.witness!.id}`, by, at: now() }, personKey(keyFile));
  return { record, name: `${diagnostic.witness!.id.slice(7, 19)}.json` };
}

export function writeAcceptance(root: string, a: { record: SignedRecord; name: string }): string {
  mkdirSync(join(root, 'accepted'), { recursive: true });
  const path = join(root, 'accepted', a.name);
  writeFileSync(path, JSON.stringify(a.record, null, 2) + '\n');
  return path;
}
