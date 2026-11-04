// S586, RT18: writes the store of a denial `escalate-once` recorded before finding 34's fix, which carries no
// `escalatedBy` and no `gateDecision`. The run is risk-desk.mjs's escalateOnceScenario with the policy untagged, made by
// the runtime of the tag v1.5.1: between v1.5.1 and the commit the tests were written at, packages/ changed only in
// poly-runtime/src/worker.ts, by 94e96062 (finding 34's fix), so that runtime is the one before the fix. It was run once
// from the detached v1.5.1 worktree that record-v151.mjs describes, with this file and risk-desk.mjs copied into its
// test/fixtures/s586/:
//   node --import ./test/fixtures/home-guard.mjs --env-file=test/fixtures/serial-heap.env test/fixtures/s586/record-prefix-store.mjs <dir>
// The directory keeps the store, the certificate, the build it certifies and the two public keys, with trust.json
// naming each by its key id. No private key is kept: the ledger and admission keys were drawn for the run (S126).
import '../home-guard.mjs';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { escalateOnceScenario } from './risk-desk.mjs';

const out = process.argv[2];
if (!out) throw new Error('usage: record-prefix-store.mjs <dir>');
const s = await escalateOnceScenario({ tagged: false, name: 's586-prefix-once' });
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
copyFileSync(s.db, join(out, 'store.db'));
for (const x of ['-wal', '-shm']) if (existsSync(`${s.db}${x}`)) copyFileSync(`${s.db}${x}`, join(out, `store.db${x}`));
copyFileSync(s.certificate, join(out, 'certificate.json'));
cpSync(s.build, join(out, 'build'), { recursive: true });
copyFileSync(s.trust.ledger.file, join(out, 'ledger.pub.pem'));
copyFileSync(s.trust.admission.file, join(out, 'admission.pub.pem'));
writeFileSync(join(out, 'trust.json'), JSON.stringify({ [s.trust.ledger.id]: 'ledger.pub.pem', [s.trust.admission.id]: 'admission.pub.pem' }, null, 2) + '\n');
console.log(`recorded to ${out}`);
