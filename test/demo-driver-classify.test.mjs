// DB6 item 9 (corrected classify()): test classify(control, run) on synthetic inputs and recorded logs,
// and format(result) on the amount field. DB6 item 8 (confirmed driver). E (webhook timeout).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { classify, format, replay, REQUEST } from '../demo/driver/replay.mjs';

const DOUBLES = fileURLToPath(new URL('./fixtures/demo/doubles/', import.meta.url));
let TEMP_BASE;

test.before(() => {
  TEMP_BASE = mkdtempSync(join(tmpdir(), '.temp-classify-'));
});

test.after(() => {
  try { rmSync(TEMP_BASE, { recursive: true }); } catch { /* might be already gone */ }
});

// ---- A. Synthetic test cases for classify() ----

test('A1: control not driven => O3', () => {
  const control = {
    driven: false,
    numbers: { posts: [], refunds: 0, amountRefunded: {}, amount: {} },
  };
  const run = {
    driven: true,
    numbers: { posts: [], refunds: 0, amountRefunded: {}, amount: {} },
  };
  const result = classify(control, run);
  assert.equal(result.outcome, 'O3');
  assert.match(result.reason, /could not be driven/);
});

test('A2: control with 0 POSTs => O3', () => {
  const control = {
    driven: true,
    numbers: { posts: [], refunds: 0, amountRefunded: { ch_demo_1001: 0 }, amount: { ch_demo_1001: 10000 } },
  };
  const run = {
    driven: true,
    numbers: { posts: [], refunds: 0, amountRefunded: {}, amount: {} },
  };
  const result = classify(control, run);
  assert.equal(result.outcome, 'O3');
});

test('A3: control with 2 POSTs => O3', () => {
  const control = {
    driven: true,
    numbers: {
      posts: [
        { status: 200, replayed: false, fault: null },
        { status: 200, replayed: false, fault: null },
      ],
      refunds: 2,
      amountRefunded: { ch_demo_1001: 8000 },
      amount: { ch_demo_1001: 10000 },
    },
  };
  const run = {
    driven: true,
    numbers: { posts: [], refunds: 0, amountRefunded: {}, amount: {} },
  };
  const result = classify(control, run);
  assert.equal(result.outcome, 'O3');
});

test('A4: fault run not driven => O3', () => {
  const control = {
    driven: true,
    numbers: {
      posts: [{ status: 200, replayed: false, fault: null }],
      refunds: 1,
      amountRefunded: { ch_demo_1001: 4000 },
      amount: { ch_demo_1001: 10000 },
    },
  };
  const run = {
    driven: false,
    numbers: { posts: [], refunds: 0, amountRefunded: {}, amount: {} },
  };
  const result = classify(control, run);
  assert.equal(result.outcome, 'O3');
});

test('A5: fault run with 0 POSTs => O3', () => {
  const control = {
    driven: true,
    numbers: {
      posts: [{ status: 200, replayed: false, fault: null }],
      refunds: 1,
      amountRefunded: { ch_demo_1001: 4000 },
      amount: { ch_demo_1001: 10000 },
    },
  };
  const run = {
    driven: true,
    numbers: { posts: [], refunds: 0, amountRefunded: {}, amount: {} },
  };
  const result = classify(control, run);
  assert.equal(result.outcome, 'O3');
});

test('A6: fault run with 1 POST (status 200, replayed false, fault reset) and refunds 0 => O3 with "no refund took effect"', () => {
  const control = {
    driven: true,
    numbers: {
      posts: [{ status: 200, replayed: false, fault: null }],
      refunds: 1,
      amountRefunded: { ch_demo_1001: 4000 },
      amount: { ch_demo_1001: 10000 },
    },
  };
  const run = {
    driven: true,
    numbers: {
      posts: [{ status: 200, replayed: false, fault: 'reset' }],
      refunds: 0,
      amountRefunded: { ch_demo_1001: 0 },
      amount: { ch_demo_1001: 10000 },
    },
  };
  const result = classify(control, run);
  assert.equal(result.outcome, 'O3');
  assert.match(result.reason, /no refund took effect/);
  assert.doesNotMatch(result.reason, /refunds twice/);
});

test('A7: two POSTs with status 200, replayed false each, refunds 2 => O1', () => {
  const control = {
    driven: true,
    numbers: {
      posts: [{ status: 200, replayed: false, fault: null }],
      refunds: 1,
      amountRefunded: { ch_demo_1001: 4000 },
      amount: { ch_demo_1001: 10000 },
    },
  };
  const run = {
    driven: true,
    numbers: {
      posts: [
        { status: 200, replayed: false, fault: 'reset' },
        { status: 200, replayed: false, fault: null },
      ],
      refunds: 2,
      amountRefunded: { ch_demo_1001: 8000 },
      amount: { ch_demo_1001: 10000 },
    },
  };
  const result = classify(control, run);
  assert.equal(result.outcome, 'O1');
});

test('A8: two POSTs with status 200 and replayed false (inconsistent: more than one successful refund) => O1', () => {
  const control = {
    driven: true,
    numbers: {
      posts: [{ status: 200, replayed: false, fault: null }],
      refunds: 1,
      amountRefunded: { ch_demo_1001: 4000 },
      amount: { ch_demo_1001: 10000 },
    },
  };
  const run = {
    driven: true,
    numbers: {
      posts: [
        { status: 200, replayed: false, fault: 'reset', key: 'key-A' },
        { status: 200, replayed: false, fault: null, key: 'key-A' },
      ],
      refunds: 1,
      amountRefunded: { ch_demo_1001: 4000 },
      amount: { ch_demo_1001: 10000 },
    },
  };
  const result = classify(control, run);
  assert.equal(result.outcome, 'O1');
});

test('A9: two POSTs, second replayed true, refunds 1 => O2 with reason mentioning 2 POSTs and replayed', () => {
  const control = {
    driven: true,
    numbers: {
      posts: [{ status: 200, replayed: false, fault: null, key: 'key-A' }],
      refunds: 1,
      amountRefunded: { ch_demo_1001: 4000 },
      amount: { ch_demo_1001: 10000 },
    },
  };
  const run = {
    driven: true,
    numbers: {
      posts: [
        { status: 200, replayed: false, fault: 'reset', key: 'key-A' },
        { status: 200, replayed: true, fault: null, key: 'key-A' },
      ],
      refunds: 1,
      amountRefunded: { ch_demo_1001: 4000 },
      amount: { ch_demo_1001: 10000 },
    },
  };
  const result = classify(control, run);
  assert.equal(result.outcome, 'O2');
  assert.match(result.reason, /\b2\b/);
  assert.match(result.reason, /replayed/);
  assert.doesNotMatch(result.reason, /refunds twice/);
});

test('A10: one POST, refunds 1 => O2', () => {
  const control = {
    driven: true,
    numbers: {
      posts: [{ status: 200, replayed: false, fault: null }],
      refunds: 1,
      amountRefunded: { ch_demo_1001: 4000 },
      amount: { ch_demo_1001: 10000 },
    },
  };
  const run = {
    driven: true,
    numbers: {
      posts: [{ status: 200, replayed: false, fault: 'reset' }],
      refunds: 1,
      amountRefunded: { ch_demo_1001: 4000 },
      amount: { ch_demo_1001: 10000 },
    },
  };
  const result = classify(control, run);
  assert.equal(result.outcome, 'O2');
});

test('A11: amount with multiple charges, sum over asked => O2 with amount.over true', () => {
  const control = {
    driven: true,
    numbers: {
      posts: [{ status: 200, replayed: false, fault: null }],
      refunds: 1,
      amountRefunded: { ch_demo_1001: 3000, ch_demo_1002: 2000 },
      amount: { ch_demo_1001: 3000, ch_demo_1002: 2000 },
    },
  };
  const run = {
    driven: true,
    numbers: {
      posts: [{ status: 200, replayed: false, fault: 'reset' }],
      refunds: 1,
      amountRefunded: { ch_demo_1001: 3000, ch_demo_1002: 2000 },
      amount: { ch_demo_1001: 3000, ch_demo_1002: 2000 },
    },
  };
  const result = classify(control, run);
  assert.equal(result.outcome, 'O2');
  assert.ok(result.amount);
  assert.equal(result.amount.asked, REQUEST.amount);
  assert.equal(result.amount.refunded, 5000);
  assert.equal(result.amount.over, true);
});

test('A12: classify always carries amount for cases that reach fault run', () => {
  const control = {
    driven: true,
    numbers: {
      posts: [{ status: 200, replayed: false, fault: null }],
      refunds: 1,
      amountRefunded: { ch_demo_1001: 4000 },
      amount: { ch_demo_1001: 10000 },
    },
  };
  const run = {
    driven: true,
    numbers: {
      posts: [{ status: 200, replayed: false, fault: null }],
      refunds: 1,
      amountRefunded: { ch_demo_1001: 4000 },
      amount: { ch_demo_1001: 10000 },
    },
  };
  const result = classify(control, run);
  assert.ok(result.amount, 'result should have amount field');
  assert.equal(result.amount.asked, REQUEST.amount);
  assert.equal(result.amount.refunded, 4000);
});

// ---- B. Recorded second-pass logs ----

test('B1: second-pass ts-kept => O2, over true, refunded 10000', () => {
  const log = JSON.parse(readFileSync(
    fileURLToPath(new URL('../docs/demo/step10-replay/second-pass/ts-kept.json', import.meta.url)), 'utf8'
  ));
  const result = classify(log.control, log.run);
  assert.equal(result.outcome, 'O2');
  assert.ok(result.amount);
  assert.equal(result.amount.refunded, 10000);
  assert.equal(result.amount.over, true);
});

test('B2: second-pass poly-kept => O2, over true, refunded 6000', () => {
  const log = JSON.parse(readFileSync(
    fileURLToPath(new URL('../docs/demo/step10-replay/second-pass/poly-kept.json', import.meta.url)), 'utf8'
  ));
  const result = classify(log.control, log.run);
  assert.equal(result.outcome, 'O2');
  assert.doesNotMatch(result.reason, /refunds twice/);
  assert.ok(result.amount);
  assert.equal(result.amount.refunded, 6000);
  assert.equal(result.amount.over, true);
});

test('B3: second-pass poly-pilot-3 => O2, over true, refunded 10000', () => {
  const log = JSON.parse(readFileSync(
    fileURLToPath(new URL('../docs/demo/step10-replay/second-pass/poly-pilot-3.json', import.meta.url)), 'utf8'
  ));
  const result = classify(log.control, log.run);
  assert.equal(result.outcome, 'O2');
  assert.ok(result.amount);
  assert.equal(result.amount.refunded, 10000);
  assert.equal(result.amount.over, true);
});

test('B4: second-pass ts-pilot-2 => O3, run null', () => {
  const log = JSON.parse(readFileSync(
    fileURLToPath(new URL('../docs/demo/step10-replay/second-pass/ts-pilot-2.json', import.meta.url)), 'utf8'
  ));
  const result = classify(log.control, log.run);
  assert.equal(result.outcome, 'O3');
  assert.equal(log.run, null);
});

// ---- B2. First-pass logs all O3 on control ----

test('B5: first-pass poly-pilot-3 control not driven => O3', () => {
  const log = JSON.parse(readFileSync(
    fileURLToPath(new URL('../docs/demo/step10-replay/poly-pilot-3.json', import.meta.url)), 'utf8'
  ));
  const result = classify(log.control, log.run);
  assert.equal(result.outcome, 'O3');
});

test('B6: first-pass poly-kept control not driven => O3', () => {
  const log = JSON.parse(readFileSync(
    fileURLToPath(new URL('../docs/demo/step10-replay/poly-kept.json', import.meta.url)), 'utf8'
  ));
  const result = classify(log.control, log.run);
  assert.equal(result.outcome, 'O3');
});

// ---- C. Old label does not come back ----

test('C1: poly-kept reason does not contain "refunds twice"', () => {
  const log = JSON.parse(readFileSync(
    fileURLToPath(new URL('../docs/demo/step10-replay/second-pass/poly-kept.json', import.meta.url)), 'utf8'
  ));
  const result = classify(log.control, log.run);
  assert.equal(result.outcome, 'O2');
  assert.doesNotMatch(result.reason, /refunds twice/);
});

// ---- D. format() prints amount line ----

test('D1: format prints line with amount, refunded and asked numbers', () => {
  const log = JSON.parse(readFileSync(
    fileURLToPath(new URL('../docs/demo/step10-replay/second-pass/poly-kept.json', import.meta.url)), 'utf8'
  ));
  const result = {
    build: log.build,
    fault: log.fault,
    start: log.start,
    standIn: log.standIn,
    control: log.control,
    run: log.run,
    tests: { status: 'not given' },
    ...classify(log.control, log.run),
  };
  const formatted = format(result);
  assert.match(formatted, /amount/i, 'output should contain word "amount"');
  assert.match(formatted, String(result.amount.refunded), 'output should contain refunded amount');
  assert.match(formatted, String(REQUEST.amount), 'output should contain requested amount');
});

// ---- E. Webhook timeout ----

test('E1: holds-webhook-response double with 500ms timeout => O3 with error timeout', async () => {
  const result = await Promise.race([
    replay({
      build: join(DOUBLES, 'holds-webhook-response'),
      start: 'node server.mjs',
      quietMs: 200,
      maxMs: 1500,
      startMs: 6000,
      webhookMs: 500,
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('test timeout after 20s')), 20000)),
  ]);
  assert.equal(result.outcome, 'O3');
  assert.ok(result.control);
  assert.ok(result.control.webhook);
  assert.deepEqual(result.control.webhook, { error: 'timeout' });
});

test('E2: keys double with 30000ms webhook timeout still gives O2', async () => {
  const result = await replay({
    build: join(DOUBLES, 'keys'),
    start: 'node server.mjs',
    quietMs: 1200,
    maxMs: 8000,
    startMs: 6000,
    webhookMs: 30000,
  });
  assert.equal(result.outcome, 'O2');
});
