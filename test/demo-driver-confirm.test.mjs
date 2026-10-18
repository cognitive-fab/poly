// DB6 item 8 (one confirmation turn): test needsConfirmation() and confirm doubles with replay driver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import * as driver from '../demo/driver/replay.mjs';

const DOUBLES = fileURLToPath(new URL('./fixtures/demo/doubles/', import.meta.url));
const TEMP_BASE = mkdtempSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', '.temp-confirm-'));

// Clean up temp dir after all tests
process.on('exit', () => {
  try { rmSync(TEMP_BASE, { recursive: true }); } catch { /* might be already gone */ }
});

// ---- A. Tests for needsConfirmation(reply) ----

test('A1: needsConfirmation exists and is exported', () => {
  assert.ok(typeof driver.needsConfirmation === 'function', 'needsConfirmation should be exported');
});

test('A2: needsConfirmation returns true for uppercase YES word', () => {
  assert.equal(driver.needsConfirmation('Reply YES to confirm or NO to cancel.'), true);
  assert.equal(driver.needsConfirmation('Say YES'), true);
  assert.equal(driver.needsConfirmation('YES!'), true);
});

test('A3: needsConfirmation returns false for lowercase or mixed-case yes', () => {
  assert.equal(driver.needsConfirmation('yes'), false);
  assert.equal(driver.needsConfirmation('Yes'), false);
});

test('A4: needsConfirmation returns false when YES is not a whole word', () => {
  assert.equal(driver.needsConfirmation('YESTERDAY'), false);
});

test('A5: needsConfirmation returns true for confirm (case-insensitive)', () => {
  assert.equal(driver.needsConfirmation('Please CONFIRM'), true);
  assert.equal(driver.needsConfirmation('confirmation needed'), true);
  assert.equal(driver.needsConfirmation('Confirm?'), true);
});

test('A6: needsConfirmation returns false for cases where neither YES nor confirm match', () => {
  assert.equal(driver.needsConfirmation('Reply Y to proceed'), false);
  assert.equal(driver.needsConfirmation(''), false);
  assert.equal(driver.needsConfirmation('ORD-1001 has no item "(THE". Items: BLENDER-1, CUPS-4.'), false);
});

test('A7: needsConfirmation handles non-string and undefined', () => {
  assert.equal(driver.needsConfirmation(null), false);
  assert.equal(driver.needsConfirmation(undefined), false);
  assert.equal(driver.needsConfirmation(123), false);
  assert.equal(driver.needsConfirmation({}), false);
});

test('A8: needsConfirmation on recorded first replies from ts-kept', async () => {
  const result = JSON.parse(readFileSync(
    fileURLToPath(new URL('../docs/demo/step10-replay/ts-kept.json', import.meta.url)), 'utf8'
  ));
  const reply = result.control.numbers.reply[0];
  assert.equal(driver.needsConfirmation(reply), true, `reply: "${reply}"`);
});

test('A9: needsConfirmation on recorded first replies from ts-pilot-2', async () => {
  const result = JSON.parse(readFileSync(
    fileURLToPath(new URL('../docs/demo/step10-replay/ts-pilot-2.json', import.meta.url)), 'utf8'
  ));
  const reply = result.control.numbers.reply[0];
  assert.equal(driver.needsConfirmation(reply), false, `reply: "${reply}"`);
});

test('A10: needsConfirmation on recorded first replies from poly-kept', async () => {
  const result = JSON.parse(readFileSync(
    fileURLToPath(new URL('../docs/demo/step10-replay/poly-kept.json', import.meta.url)), 'utf8'
  ));
  const reply = result.control.numbers.reply[0];
  assert.equal(driver.needsConfirmation(reply), true, `reply: "${reply}"`);
});

test('A11: needsConfirmation on recorded first replies from poly-pilot-3', async () => {
  const result = JSON.parse(readFileSync(
    fileURLToPath(new URL('../docs/demo/step10-replay/poly-pilot-3.json', import.meta.url)), 'utf8'
  ));
  const reply = result.control.numbers.reply[0];
  assert.equal(driver.needsConfirmation(reply), true, `reply: "${reply}"`);
});

// ---- Helper to parse log and run through replay ----

function parseLogs(logContent) {
  const lines = logContent.trim().split('\n').map((l) => JSON.parse(l));
  const segments = [[]];
  for (const line of lines) {
    if (line.ev === 'start' && segments[segments.length - 1].length > 0) {
      segments.push([]);
    }
    segments[segments.length - 1].push(line);
  }
  return segments;
}

async function driveWithLog(doubleName, logFile) {
  const result = await driver.replay({
    build: join(DOUBLES, doubleName),
    start: `node server.mjs "${logFile}"`,
    quietMs: 1200,
    maxMs: 8000,
    startMs: 6000,
  });
  const logContent = readFileSync(logFile, 'utf8');
  const segments = parseLogs(logContent);
  return { result, segments };
}

// ---- B. Driver tests with doubles ----

test('B1: confirms-then-refunds-with-key: control has turns and first reply asks for confirmation', async () => {
  const logFile = join(TEMP_BASE, 'b1.log');
  const { result, segments } = await driveWithLog('confirms-then-refunds-with-key', logFile);

  assert.ok(result.control.driven, `control should be driven: ${result.control.why ?? 'unknown'}`);
  assert.equal(result.control.numbers.posts.length, 1, 'control makes 1 POST');
  assert.equal(result.control.numbers.refunds, 1, 'control makes 1 refund');

  // Check reply contains confirmation request
  const firstReply = result.control.numbers.reply[0];
  assert.equal(driver.needsConfirmation(firstReply), true, `first reply should ask for confirmation: "${firstReply}"`);

  // Check turns field exists if supported
  if (typeof result.control.turns !== 'undefined') {
    assert.ok(Array.isArray(result.control.turns), 'control.turns should be an array');
  }
});

test('B2: confirms-then-refunds-with-key: fault run makes one POST and one refund (O2)', async () => {
  const logFile = join(TEMP_BASE, 'b2.log');
  const { result } = await driveWithLog('confirms-then-refunds-with-key', logFile);

  assert.equal(result.outcome, 'O2', `outcome should be O2: ${result.reason}`);
  assert.equal(result.run.numbers.posts.length, 2, 'fault run makes 2 POSTs (first lost, then retry)');
  assert.equal(result.run.numbers.refunds, 1, 'fault run makes 1 refund total');

  if (typeof result.run.turns !== 'undefined') {
    assert.equal(result.run.turns[1], 'YES', 'second turn should be YES');
  }
});

test('B3: confirms-then-refunds-with-key: both POSTs use same idempotency key', async () => {
  const logFile = join(TEMP_BASE, 'b3.log');
  const { result } = await driveWithLog('confirms-then-refunds-with-key', logFile);

  if (result.run && result.run.numbers.posts.length >= 2) {
    const key1 = result.run.numbers.posts[0].key;
    const key2 = result.run.numbers.posts[1].key;
    assert.equal(key1, key2, 'both POSTs should use the same key');
  }
});

test('B4: confirms-then-refunds-fresh-key: makes 2 refunds (O1)', async () => {
  const logFile = join(TEMP_BASE, 'b4.log');
  const { result } = await driveWithLog('confirms-then-refunds-fresh-key', logFile);

  assert.equal(result.outcome, 'O1', `outcome should be O1: ${result.reason}`);
  assert.equal(result.run.numbers.refunds, 2, 'fresh key double refunds twice');
});

test('B5: confirms-then-refunds-fresh-key: uses different key on each attempt', async () => {
  const logFile = join(TEMP_BASE, 'b5.log');
  const { result } = await driveWithLog('confirms-then-refunds-fresh-key', logFile);

  if (result.run && result.run.numbers.posts.length >= 2) {
    const key1 = result.run.numbers.posts[0].key;
    const key2 = result.run.numbers.posts[1].key;
    assert.notEqual(key1, key2, 'each POST should use a different key');
  }
});

test('B6: confirms-then-refunds-no-key-retries: makes 2 refunds (O1)', async () => {
  const logFile = join(TEMP_BASE, 'b6.log');
  const { result } = await driveWithLog('confirms-then-refunds-no-key-retries', logFile);

  assert.equal(result.outcome, 'O1', `outcome should be O1: ${result.reason}`);
  assert.equal(result.run.numbers.refunds, 2, 'no-key double refunds twice');
});

test('B7: refunds-at-once: makes 1 POST and 1 refund on first message (O2)', async () => {
  const logFile = join(TEMP_BASE, 'b7.log');
  const { result } = await driveWithLog('refunds-at-once', logFile);

  assert.equal(result.outcome, 'O2', `outcome should be O2: ${result.reason}`);
  assert.equal(result.control.numbers.posts.length, 1, 'control makes 1 POST');
  assert.equal(result.control.numbers.refunds, 1, 'control makes 1 refund');

  // No confirmation should be asked
  const firstReply = result.control.numbers.reply[0];
  assert.equal(driver.needsConfirmation(firstReply), false, 'should not ask for confirmation');

  // Turns should be just the request, no YES sent
  if (typeof result.control.turns !== 'undefined') {
    assert.equal(result.control.turns.length, 1, 'only request sent, no confirmation');
  }
});

test('B8: asks-twice: asks twice before refunding, control stays O3', async () => {
  const logFile = join(TEMP_BASE, 'b8.log');
  const { result } = await driveWithLog('asks-twice', logFile);

  // Since it asks twice, the driver only sends ONE YES
  // So the double refunds after the second message but the control
  // sees no refund (because no second confirmation was sent)
  assert.equal(result.outcome, 'O3', `outcome should be O3: ${result.reason}`);
});

test('B9: asks-in-lowercase: replies with lowercase, driver does not send YES', async () => {
  const logFile = join(TEMP_BASE, 'b9.log');
  const { result } = await driveWithLog('asks-in-lowercase', logFile);

  assert.equal(result.outcome, 'O3', `outcome should be O3: ${result.reason}`);

  // Check that the reply does not trigger confirmation
  const firstReply = result.control.numbers.reply[0];
  assert.equal(driver.needsConfirmation(firstReply), false, 'lowercase reply should not trigger confirmation');

  // Turns should be just the request
  if (typeof result.control.turns !== 'undefined') {
    assert.equal(result.control.turns.length, 1, 'only request sent, no YES for lowercase');
  }
});

test('B10: no-reply: never sends reply, driver sends nothing else', async () => {
  const logFile = join(TEMP_BASE, 'b10.log');
  const { result } = await driveWithLog('no-reply', logFile);

  assert.equal(result.outcome, 'O3', `outcome should be O3: ${result.reason}`);

  // No refund should be made
  assert.equal(result.control.numbers.refunds, 0, 'no-reply never refunds');

  // Turns should be just the request
  if (typeof result.control.turns !== 'undefined') {
    assert.equal(result.control.turns.length, 1, 'only request sent, no YES');
  }
});

// ---- C. Log and message verification ----

test('C1: log records inbound messages with correct structure', async () => {
  const logFile = join(TEMP_BASE, 'c1.log');
  const { segments } = await driveWithLog('confirms-then-refunds-with-key', logFile);

  const control = segments[0];
  assert.ok(control.length > 0, 'control segment should have entries');

  // Find message events
  const messages = control.filter((e) => e.ev === 'in');
  assert.ok(messages.length >= 1, 'should have at least one inbound message');

  const msg = messages[0];
  assert.ok(msg.id, 'message should have id');
  assert.ok(msg.from, 'message should have from');
  assert.ok(msg.text, 'message should have text');
});

test('C2: second webhook is from same customer as first', async () => {
  const logFile = join(TEMP_BASE, 'c2.log');
  const { segments } = await driveWithLog('confirms-then-refunds-with-key', logFile);

  const fault = segments[1];
  const messages = fault.filter((e) => e.ev === 'in');

  if (messages.length >= 2) {
    assert.equal(messages[0].from, messages[1].from, 'both messages should be from same customer');
  }
});

test('C3: message IDs are wamid.DEMO.1 and wamid.DEMO.2', async () => {
  const logFile = join(TEMP_BASE, 'c3.log');
  const { segments } = await driveWithLog('confirms-then-refunds-with-key', logFile);

  const fault = segments[1];
  const messages = fault.filter((e) => e.ev === 'in');

  if (messages.length >= 1) {
    assert.equal(messages[0].id, 'wamid.DEMO.1', 'first message should have id wamid.DEMO.1');
  }
  if (messages.length >= 2) {
    assert.equal(messages[1].id, 'wamid.DEMO.2', 'second message should have id wamid.DEMO.2');
  }
});

test('C4: message customer matches order customer', async () => {
  const logFile = join(TEMP_BASE, 'c4.log');
  const { segments } = await driveWithLog('confirms-then-refunds-with-key', logFile);

  const orders = JSON.parse(readFileSync(driver.ORDERS, 'utf8'));
  const order = orders.find((o) => o.order === 'ORD-1001');

  const control = segments[0];
  const messages = control.filter((e) => e.ev === 'in');

  if (messages.length >= 1 && order) {
    assert.equal(messages[0].from, order.customer, 'message from should match order customer');
  }
});

test('C5: fault run first POST after second webhook', async () => {
  const logFile = join(TEMP_BASE, 'c5.log');
  const { segments } = await driveWithLog('confirms-then-refunds-with-key', logFile);

  const fault = segments[1];
  const messages = fault.filter((e) => e.ev === 'in');
  const posts = fault.filter((e) => e.ev === 'post');

  if (messages.length >= 2 && posts.length > 0) {
    const secondMsgIndex = fault.findIndex((e) => e.ev === 'in' && e.id === 'wamid.DEMO.2');
    const firstPostIndex = fault.findIndex((e) => e.ev === 'post');

    if (secondMsgIndex >= 0 && firstPostIndex >= 0) {
      assert.ok(firstPostIndex > secondMsgIndex, 'first POST should come after second webhook');
    }
  }
});
