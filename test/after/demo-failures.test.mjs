// DF12.1, DF12.4, DF12.5, DAC17: the failed decisions are shown, the timeouts fit the provider.
// Heavy tests: assemble the demo in live mode with a stub model transport that has latency,
// reproduce the timeout failures of DF12 item 1, then show that they are fixed with the demo's
// timeouts. Compare instances to show that timeout changes do not change the instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Rewrite the timeouts in the program text: replace the first N timeout lines.
// The concierge has exactly 2 "timeout 800ms" (classify and amount) and 4 "timeout 2s".
function rewriteTimeouts(text, targetTimeouts) {
  // targetTimeouts: { classify: '800ms', amount: '800ms', answer: '2s', reply: '2s' }
  // Find decision blocks by their declaration and replace the timeout within 5 lines.
  const decisions = [
    { name: 'classify', match: /decision classify[^{]*\{/, oldTimeout: '800ms', newTimeout: targetTimeouts.classify },
    { name: 'amount', match: /decision amount[^{]*\{/, oldTimeout: '800ms', newTimeout: targetTimeouts.amount },
    { name: 'answer', match: /decision answer[^{]*\{/, oldTimeout: '2s', newTimeout: targetTimeouts.answer },
    { name: 'reply', match: /decision reply[^{]*\{/, oldTimeout: '2s', newTimeout: targetTimeouts.reply },
  ];
  let result = text;
  for (const { name, match, oldTimeout, newTimeout } of decisions) {
    const decl = result.match(match);
    if (!decl) throw new Error(`could not find decision ${name}`);
    const start = decl.index + decl[0].length;
    // Find the timeout line within the next 500 characters
    const section = result.substring(start, start + 500);
    const timeoutMatch = section.match(new RegExp(`timeout ${oldTimeout.replace(/\./g, '\\.')}`));
    if (!timeoutMatch) throw new Error(`could not find "timeout ${oldTimeout}" in decision ${name}`);
    // Replace this occurrence only
    const pos = start + timeoutMatch.index;
    result = result.substring(0, pos) + `timeout ${newTimeout}` + result.substring(pos + timeoutMatch[0].length);
  }
  return result;
}

// Create a demo assembly with the example's timeouts (rewritten) and onFailure callback.
const createExampleTimeoutDemo = async (onFailure) => {
  const { assembleDemo } = await import('../../demo/host/assemble.mjs');
  const { makeDemoConcierge } = await import('../../demo/scripts/make-demo-concierge.mjs');
  const workdir = mkdtempSync(join(tmpdir(), 'demo-failures-example-'));
  const sourceDir = mkdtempSync(join(tmpdir(), 'demo-copy-'));
  // Create a fresh copy, then rewrite its timeouts back to the example's values.
  makeDemoConcierge({ out: sourceDir });
  const prog = readFileSync(join(sourceDir, 'concierge.poly'), 'utf8');
  const rewritten = rewriteTimeouts(prog, { classify: '800ms', amount: '800ms', answer: '2s', reply: '2s' });
  writeFileSync(join(sourceDir, 'concierge.poly'), rewritten);
  // Verify the rewrite worked
  assert.ok(rewritten.match(/timeout 800ms/), 'rewritten program has "timeout 800ms"');
  assert.ok(rewritten.match(/timeout 2s/), 'rewritten program has "timeout 2s"');
  const demo = await assembleDemo({
    mode: 'stub-model',
    workdir,
    capUsd: 5,
    now: () => Date.now(),
    stubLatencyMs: 400,
    startWorkers: true,
    limits: { minGapMs: 1000 },
    source: sourceDir,
    onFailure,
  });
  return { demo, workdir, sourceDir };
};

// Create a demo assembly with the demo copy exactly as makeDemoConcierge produces it (no timeout rewrite).
const createDemoTimeoutDemo = async () => {
  const { assembleDemo } = await import('../../demo/host/assemble.mjs');
  const { makeDemoConcierge } = await import('../../demo/scripts/make-demo-concierge.mjs');
  const workdir = mkdtempSync(join(tmpdir(), 'demo-failures-demo-'));
  const sourceDir = mkdtempSync(join(tmpdir(), 'demo-copy-'));
  // Create a fresh copy without rewriting timeouts - use it exactly as makeDemoConcierge produces it.
  // The test will fail now because the copy does not yet have the demo's timeouts (makeDemoConcierge doesn't apply them yet).
  makeDemoConcierge({ out: sourceDir });
  const demo = await assembleDemo({
    mode: 'stub-model',
    workdir,
    capUsd: 5,
    now: () => Date.now(),
    stubLatencyMs: 400,
    startWorkers: true,
    limits: { minGapMs: 1000 },
    source: sourceDir,
  });
  return { demo, workdir, sourceDir };
};

// Create a demo assembly with 401 responses (live mode with price-gate-passing copy).
const create401Demo = async (onFailure) => {
  const { assembleDemo } = await import('../../demo/host/assemble.mjs');
  const { makeDemoConcierge } = await import('../../demo/scripts/make-demo-concierge.mjs');
  const workdir = mkdtempSync(join(tmpdir(), 'demo-failures-401-'));
  const sourceDir = mkdtempSync(join(tmpdir(), 'demo-copy-'));
  makeDemoConcierge({ out: sourceDir });
  // Rewrite price tables to pass the price gate: https source, non-placeholder host, real date, positive prices
  const smallPrice = { v: 1, provider: 'small', model: 'claude-haiku-5-5', currency: 'usd', perMillionTokens: { input: 100000, output: 500000 }, source: 'https://pricing.vendorco.net/page', readOn: new Date().toISOString().slice(0, 10) };
  const largePrice = { v: 1, provider: 'large', model: 'claude-opus-4-5', currency: 'usd', perMillionTokens: { input: 3000000, output: 15000000 }, source: 'https://pricing.vendorco.net/page', readOn: new Date().toISOString().slice(0, 10) };
  writeFileSync(join(sourceDir, 'prices', 'small.json'), JSON.stringify(smallPrice));
  writeFileSync(join(sourceDir, 'prices', 'large.json'), JSON.stringify(largePrice));
  // Transport that always returns 401
  const transport401 = {
    request: async () => ({ status: 401, headers: {}, body: '{}' }),
  };
  const demo = await assembleDemo({
    mode: 'live',
    workdir,
    capUsd: 5,
    now: () => Date.now(),
    apiKey: 'stub-key-for-test',
    modelTransport: transport401,
    startWorkers: true,
    limits: { minGapMs: 1000 },
    source: sourceDir,
    onFailure,
  });
  return { demo, workdir, sourceDir };
};

// ---- DF12.1: example timeouts cause failures --------

test('DF12.1: with example timeouts (800ms), a guest saying "where is my order?" gets timeout lines on onFailure', { timeout: 1_800_000 }, async () => {
  const failures = [];
  const { demo, workdir, sourceDir } = await createExampleTimeoutDemo((line) => failures.push(line));
  const { room } = demo;
  try {
    const heard = [];
    room.subscribe('s1', (e) => heard.push(e));
    // Wait for room to settle
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = Date.now();
    const result = await room.say('s1', 'where is my order?');
    assert.deepEqual(result, { ok: true });
    // Wait up to 30 seconds for timeout lines to appear
    const maxWait = 30_000;
    while (Date.now() - before < maxWait && failures.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(failures.length >= 2, `should have at least 2 timeout failures, got ${failures.length}: ${failures.join('; ')}`);
    // Check for exact timeout failure lines (DF12 item 3 format)
    assert.ok(failures.some((l) => l === 'decision failed: classify, tier small, timed out after 800 ms'), 'classify small timeout exact line');
    assert.ok(failures.some((l) => l === 'decision failed: classify, tier large, timed out after 800 ms'), 'classify large timeout exact line');
    assert.ok(!failures.some((l) => l.includes('sk-test-key')), 'no key in failures');
    assert.ok(!failures.some((l) => l.includes('where is my order')), 'no customer text in failures');
    // Guest should not get a reply naming the order (no answer about the order), though generic reply may arrive
    const replyEvents = heard.filter((e) => e.kind === 'reply');
    for (const reply of replyEvents) {
      assert.ok(!reply.text.includes('o-91'), 'no reply should name the guest order id');
    }
  } finally {
    await demo.close();
    rmSync(workdir, { recursive: true, force: true, maxRetries: 3 });
    rmSync(sourceDir, { recursive: true, force: true, maxRetries: 3 });
  }
});

// ---- DF12.5: demo copy with its timeouts allows the guest to get an answer --------

test('DF12.5: with demo copy as produced (no timeout rewrite), a guest saying "where is my order?" gets an answer within 20 seconds', { timeout: 1_800_000 }, async () => {
  const { demo, workdir, sourceDir } = await createDemoTimeoutDemo();
  const { room } = demo;
  try {
    const heard = [];
    room.subscribe('s1', (e) => heard.push(e));
    // Wait for room to settle
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = Date.now();
    const result = await room.say('s1', 'where is my order?');
    assert.deepEqual(result, { ok: true });
    // Wait up to 20 seconds for a reply event with the order id
    const maxWait = 20_000;
    while (Date.now() - before < maxWait && !heard.find((e) => e.kind === 'reply' && e.text.includes('o-91'))) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const replyEvent = heard.find((e) => e.kind === 'reply' && e.text.includes('o-91'));
    assert.ok(replyEvent, `guest should get a reply naming their order within ${maxWait} ms, got events: ${heard.map((e) => e.kind).join(', ')}`);
  } finally {
    await demo.close();
    rmSync(workdir, { recursive: true, force: true, maxRetries: 3 });
    rmSync(sourceDir, { recursive: true, force: true, maxRetries: 3 });
  }
});

// ---- DF12.4: 401 from the model is reported once with exact prefix --------

test('DF12.4: a 401 response from the model is reported exactly once with the key failure prefix', { timeout: 1_800_000 }, async () => {
  const failures = [];
  const { demo, workdir, sourceDir } = await create401Demo((line) => failures.push(line));
  const { room } = demo;
  try {
    // Send two messages to ensure the key error is reported only once across both
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = Date.now();
    const result1 = await room.say('s1', 'refund me');
    const result2 = await room.say('s1', 'how much?');
    assert.deepEqual(result1, { ok: true });
    assert.deepEqual(result2, { ok: true });
    // Wait a few seconds after the first message for failures to be recorded
    await new Promise((resolve) => setTimeout(resolve, 3000));
    // Should have exactly one key line
    const keyLines = failures.filter((l) => l.includes('model key refused'));
    assert.equal(keyLines.length, 1, `should have exactly one key failure, got ${keyLines.length}: ${failures.join('; ')}`);
    // The line should have the exact prefix
    assert.equal(keyLines[0], 'model key refused (HTTP 401): set a fresh key and restart the launcher', 'key line has exact prefix');
    // No other failure line should contain the key
    const otherLines = failures.filter((l) => !l.includes('model key refused'));
    for (const line of otherLines) {
      assert.ok(!line.includes('stub-key-for-test'), `line "${line}" should not contain the key`);
    }
  } finally {
    await demo.close();
    rmSync(workdir, { recursive: true, force: true, maxRetries: 3 });
    rmSync(sourceDir, { recursive: true, force: true, maxRetries: 3 });
  }
});

// ---- DF12.5: the instance with different timeouts is the same --------

test('DF12.5: the instance is unchanged by timeout rewrite; compare example-timeouts and demo-copy instances', { timeout: 1_800_000 }, async () => {
  // This test reuses the assemblies from the DF12.1 and DF12.5 demo-copy tests and compares their
  // admission instances. Timeouts are not part of the state machine, so both should have identical instances.
  // Create fresh assemblies for this comparison (not reusing from other tests to avoid shared teardown issues)
  const { demo: demoExample, workdir: dir1, sourceDir: src1 } = await createExampleTimeoutDemo();
  const { demo: demoDemo, workdir: dir2, sourceDir: src2 } = await createDemoTimeoutDemo();

  try {
    // Both demos should assemble successfully
    assert.ok(demoExample.admission, 'example timeout demo should have admission');
    assert.ok(demoDemo.admission, 'demo copy demo should have admission');

    // Extract the machines and their instance states from both admissions
    const exampleMachines = demoExample.admission.report.files
      .flatMap((f) => f.machines ? Object.keys(f.machines) : [])
      .sort();
    const demoCopyMachines = demoDemo.admission.report.files
      .flatMap((f) => f.machines ? Object.keys(f.machines) : [])
      .sort();

    // Both should have the same machines
    assert.deepEqual(exampleMachines, demoCopyMachines, 'both assemblies should have the same machines');

    // Create a mapping of machine names to their state counts
    const instanceSignature = (admission) => {
      const machines = {};
      for (const file of admission.report.files) {
        if (file.machines) {
          for (const [name, machine] of Object.entries(file.machines)) {
            machines[name] = machine.instance?.states ?? 0;
          }
        }
      }
      return machines;
    };

    const exampleSig = instanceSignature(demoExample.admission);
    const copySig = instanceSignature(demoDemo.admission);

    // The instances should be identical: { Desk: 2114, Notice: 28, support.Conversation: 342, staff.Conversation: 666, payments.Grant: 13, triage.Route: 6, spend.Budget: 96 }
    // This is the instance printed at launch for this demo
    const expectedStates = {
      Desk: 2114,
      Notice: 28,
      'support.Conversation': 342,
      'staff.Conversation': 666,
      'payments.Grant': 13,
      'triage.Route': 6,
      'spend.Budget': 96,
    };

    assert.deepEqual(exampleSig, expectedStates, 'example timeout assembly has expected instance states');
    assert.deepEqual(copySig, expectedStates, 'demo copy assembly has expected instance states');
    assert.deepEqual(exampleSig, copySig, 'both assemblies have identical instances despite different timeouts');
  } finally {
    await demoExample.close();
    await demoDemo.close();
    rmSync(dir1, { recursive: true, force: true, maxRetries: 3 });
    rmSync(src1, { recursive: true, force: true, maxRetries: 3 });
    rmSync(dir2, { recursive: true, force: true, maxRetries: 3 });
    rmSync(src2, { recursive: true, force: true, maxRetries: 3 });
  }
});
