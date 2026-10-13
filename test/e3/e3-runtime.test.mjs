// plan-e3.md E3.4, gate items (owner, 2026-10-11): the harness under poly-runtime with its real handler files.
//
// Gate 1, failure mapping. A verifier's permanent error completes as the effect's failed outcome (Refused) with no retry.
// If the runtime retried a permanent error, this test would stop the work and report it; the harness does not work around it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { admittedHarness, loaded } from './e3-runtime-helpers.mjs';

const LOG = ['> build', 'src/a.ts(3,5): error TS2322: Type string is not assignable to type number.', 'Found 1 error.', 'x'.repeat(600)].join('\n');
const hashOf = (s) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const receipt = (quotes) => JSON.stringify({ sourceHash: hashOf(Buffer.from(LOG)), status: 'fail', quotes });

/** An in-memory store transport that counts its reads, and a secrets transport. */
function transports(archive) {
  const tables = new Map();
  const reads = [];
  return {
    reads,
    tables,
    store: {
      read(table, key) { reads.push([table, key]); return table === 'archive' ? archive : tables.get(`${table}/${key}`); },
      write(table, key, value) { tables.set(`${table}/${key}`, value); },
    },
    secrets: (name) => (name === 'known-secrets' ? '[]' : undefined),
  };
}

async function receiptRun(name, readsAs) {
  const a = await admittedHarness(name);
  const t = transports({ log: Buffer.from(LOG).toString('base64'), exitStatus: 1 });
  const { rt } = await loaded(a, { transports: t });
  const asked = [];
  rt.provide('read', {
    provider: (q, m) => { asked.push([q, m]); return { answer: readsAs, distribution: [[readsAs, 1]], usage: { input: 900, output: 80 } }; },
    model: 'cheap-tier-placeholder',
  });
  rt.handle('tool.verify', rt.handlerExports('src/handlers/verify.mjs').verify);
  const id = 'receipt:t:1';
  await rt.create('harness.Receipt', { id });
  await rt.dispatch(id, 'Open', { log: await rt.putContent(LOG), flagged: false });
  for (let i = 0; i < 3; i++) await rt.advance(8);
  return { rt, id, t, asked };
}

test('E3.4 gate 1: a receipt the verifier accepts completes ok: Verified, and the handler ran once', { timeout: 300_000 }, async () => {
  const { rt, id, t, asked } = await receiptRun('e3-verify-ok', receipt(['error TS2322: Type string is not assignable to type number.']));
  try {
    assert.equal(asked.length, 1, 'the cheaper reader was asked once');
    assert.equal((await rt.getState(id)).state.st, 'Verified');
    assert.equal(t.reads.filter(([tb]) => tb === 'archive').length, 1);
  } finally {
    await rt.close();
  }
});

test('E3.4 gate 1: a receipt whose quote is not in the log is a permanent error that completes as Refused (Rejected), with no retry', { timeout: 300_000 }, async () => {
  const { rt, id, t } = await receiptRun('e3-verify-refused', receipt(['an invented line']));
  try {
    const st = (await rt.getState(id)).state.st;
    assert.equal(st, 'Rejected', `the receipt state is ${st}`);
    // no retry: the handler read the archive once. A retry would read it again.
    assert.equal(t.reads.filter(([tb]) => tb === 'archive').length, 1, `the handler ran ${t.reads.filter(([tb]) => tb === 'archive').length} times: the runtime retried a permanent error`);
    // more worker passes change nothing and call nothing
    for (let i = 0; i < 4; i++) await rt.worker.tick();
    assert.equal(t.reads.filter(([tb]) => tb === 'archive').length, 1, 'a later pass retried it');
    assert.equal((await rt.getState(id)).state.st, 'Rejected');
  } finally {
    await rt.close();
  }
});
