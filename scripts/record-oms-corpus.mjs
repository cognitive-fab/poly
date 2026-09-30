#!/usr/bin/env node
// Corpus (b) of S24: the OMS order's sixteen scenarios, recorded by polyrun's own kernel from the
// hand-written artefacts, and exported as polyrun exports traces.
//
//   node scripts/record-oms-corpus.mjs            record into conformance/field-studies/order-kernel/
//   node scripts/record-oms-corpus.mjs <dir>      record into another directory (the test re-records and compares)
//
// The scenarios are the sixteen trace files of corpus (a), named for what they do. Corpus (a) predates
// the module's next-state migration, so its windows never leave `pending` (S24); its action sequences are
// what this script replays, through the real kernel, against the hand-written order, shipment, mapper and
// manifest copied in conformance/field-studies/order/. A SHIPMENT_COMPLETED for a shipment that is live
// is produced the way production produces it: the shipment itself is driven to its terminal state
// (SHIP then DELIVER, or CANCEL_SHIPMENT), and the kernel delivers the completion in the cascade. Any
// other step, a stale completion included, is dispatched as the corpus records it. The clock and every
// action id are fixed, so the corpus is the same bytes on every run.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '@cognitive-fab/polygraph/polyrun/src/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HAND = join(ROOT, 'conformance', 'field-studies', 'order');
export const DEFAULT_OUT = join(ROOT, 'conformance', 'field-studies', 'order-kernel');

/** The action sequence of each scenario of corpus (a). */
export function scenarios() {
  const dir = join(HAND, 'machines', 'order', 'traces');
  return readdirSync(dir).filter((f) => f.endsWith('.ndjson')).sort().map((f) => ({
    name: basename(f, '.ndjson'),
    steps: readFileSync(join(dir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((w) => ({ action: w.action, data: w.data })),
  }));
}

export async function record(out = DEFAULT_OUT) {
  const now = 1_700_000_000_000;
  const rt = await createRuntime({
    store: { sqlite: ':memory:' },
    now: () => now,
    machines: [
      { machineId: 'order', module: join(HAND, 'machines', 'order', 'next.cjs'), contract: join(HAND, 'machines', 'order-contract.json'), effects: { mapper: join(HAND, 'effects.cjs'), manifest: join(HAND, 'effects.manifest.json') } },
      { machineId: 'shipment', module: join(HAND, 'machines', 'shipment', 'next.cjs'), contract: join(HAND, 'machines', 'shipment', 'authoring-contract.json') },
    ],
  });
  const files = [];
  try {
    mkdirSync(join(out, 'traces'), { recursive: true });
    for (const sc of scenarios()) {
      const id = `order-${sc.name}`;
      await rt.create('order', id);
      let n = 0;
      const aid = () => `${sc.name}:${++n}`;
      for (const st of sc.steps) {
        if (st.action === 'SHIPMENT_COMPLETED') {
          const child = (await rt.store.listChildren(id)).find((c) => c.child_key === st.data.childKey && c.status === 'active');
          if (child) {
            // Production's way: the shipment reaches its terminal state and the kernel completes the order.
            const path = st.data.childState.shipState === 'delivered' ? ['SHIP', 'DELIVER'] : ['CANCEL_SHIPMENT'];
            for (const a of path) await rt.dispatch(child.instance_id, a, {}, aid());
            continue;
          }
        }
        await rt.dispatch(id, st.action, st.data, aid());
      }
      const text = (await rt.exportTraces(id)) + '\n';
      const file = join('traces', `${sc.name}.ndjson`);
      writeFileSync(join(out, file), text);
      files.push(file.split('\\').join('/'));
    }
  } finally {
    await rt.close();
  }
  const sha = (f) => createHash('sha256').update(readFileSync(join(out, f))).digest('hex');
  const handHash = createHash('sha256');
  for (const f of ['machines/order/next.cjs', 'machines/shipment/next.cjs', 'effects.cjs', 'effects.manifest.json', 'machines/order-contract.json', 'machines/shipment/authoring-contract.json']) handHash.update(readFileSync(join(HAND, f)));
  writeFileSync(join(out, 'PROVENANCE.md'), [
    '# Provenance: order-kernel',
    '',
    'Corpus (b) of S24: the OMS order\'s sixteen scenarios, **generated from the hand-written artefacts**, not captured from a running system. `scripts/record-oms-corpus.mjs` replays the action sequence of each trace file of corpus (a) (`conformance/field-studies/order/machines/order/traces`) through polyrun\'s own kernel, against the hand-written order, shipment, mapper and manifest copied in `conformance/field-studies/order/`, and exports each order\'s journal as polyrun exports traces (accepted steps only).',
    '',
    '| Item | Value |',
    '|---|---|',
    '| Generator | `scripts/record-oms-corpus.mjs`, with the kernel vendored in `vendor/polygraph` (polygraph 583b82c) |',
    `| Inputs | the copies in \`conformance/field-studies/order/\`; SHA-256 of the order and shipment modules, mapper, manifest and contracts together: \`${handHash.digest('hex')}\` |`,
    '| Completions | a SHIPMENT_COMPLETED for a live shipment is produced by driving the shipment (SHIP then DELIVER, or CANCEL_SHIPMENT) so the kernel delivers it; any other step is dispatched as corpus (a) records it |',
    '| Determinism | fixed clock and action ids; `test/oms.test.mjs` re-records into a scratch directory and compares the bytes |',
    '| Licence | Apache-2.0, as the inputs (polygraph/LICENSE) |',
    '',
    '| File | SHA-256 |',
    '|---|---|',
    ...files.map((f) => `| \`${f}\` | \`${sha(f)}\` |`),
    '',
    '## Conclusion',
    '',
    'The poly order must replay this corpus at 100% (S24). It is regenerated only by the script, never edited by hand, and the hashes pin it.',
    '',
  ].join('\n'));
  return files;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = await record(process.argv[2] ?? DEFAULT_OUT);
  console.log(`recorded ${files.length} scenarios`);
}
