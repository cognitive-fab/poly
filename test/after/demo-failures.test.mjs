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

// Rewrite the timeouts in the program text: replace whatever timeout is in each decision block with the target.
function rewriteTimeouts(text, targetTimeouts) {
  // targetTimeouts: { classify: '800ms', amount: '800ms', answer: '2s', reply: '2s' }
  // Find decision blocks and replace whatever timeout is there with the target value.
  const decisions = [
    { name: 'classify', match: /decision classify[^{]*\{/ },
    { name: 'amount', match: /decision amount[^{]*\{/ },
    { name: 'answer', match: /decision answer[^{]*\{/ },
    { name: 'reply', match: /decision reply[^{]*\{/ },
  ];
  let result = text;
  for (const { name, match } of decisions) {
    const decl = result.match(match);
    if (!decl) throw new Error(`could not find decision ${name}`);
    const start = decl.index + decl[0].length;
    // Find the end of this decision block (next decision or end of text)
    const nextDeclMatch = result.substring(start).match(/\n\s*decision /);
    const blockEnd = nextDeclMatch ? start + nextDeclMatch.index : result.length;
    // Search for timeout within this specific decision block only
    const block = result.substring(start, blockEnd);
    const timeoutMatch = block.match(/timeout [0-9.]+(ms|s|m)\b/);
    if (!timeoutMatch) throw new Error(`could not find "timeout" in decision ${name}`);
    // Replace this occurrence only
    const pos = start + timeoutMatch.index;
    const newTimeout = targetTimeouts[name];
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
  // Read the copy's price tables to get their models (must match calibration maps' fittedFor)
  const smallOriginal = JSON.parse(readFileSync(join(sourceDir, 'prices', 'small.json'), 'utf8'));
  const largeOriginal = JSON.parse(readFileSync(join(sourceDir, 'prices', 'large.json'), 'utf8'));
  // Rewrite only source and readOn to pass the price gate (keep model as-is to match calibration maps)
  const smallPrice = { ...smallOriginal, source: 'https://pricing.vendorco.net/page', readOn: new Date().toISOString().slice(0, 10) };
  const largePrice = { ...largeOriginal, source: 'https://pricing.vendorco.net/page', readOn: new Date().toISOString().slice(0, 10) };
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
    const guest = room.join('s1');
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
    const guestOrderId = guest.orders[0].id;
    const replyEvents = heard.filter((e) => e.kind === 'reply');
    for (const reply of replyEvents) {
      assert.ok(!reply.text.includes(guestOrderId), `no reply should name the guest order id ${guestOrderId}`);
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
    const guest = room.join('s1');
    const heard = [];
    room.subscribe('s1', (e) => heard.push(e));
    // Wait for room to settle
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = Date.now();
    const result = await room.say('s1', 'where is my order?');
    assert.deepEqual(result, { ok: true });
    // Wait up to 20 seconds for a reply event with the order id
    const guestOrderId = guest.orders[0].id;
    const maxWait = 20_000;
    while (Date.now() - before < maxWait && !heard.find((e) => e.kind === 'reply' && e.text.includes(guestOrderId))) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const replyEvent = heard.find((e) => e.kind === 'reply' && e.text.includes(guestOrderId));
    assert.ok(replyEvent, `guest should get a reply naming their order ${guestOrderId} within ${maxWait} ms, got events: ${heard.map((e) => e.kind).join(', ')}`);
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
    const guest = room.join('s1');
    // Send two messages to ensure the key error is reported only once across both
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result1 = await room.say('s1', 'refund me');
    // Wait for the rate-limit gap to expire (minGapMs: 1000 in assembly limits)
    await new Promise((resolve) => setTimeout(resolve, 1100));
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

  try {
    const { demo: demoDemo, workdir: dir2, sourceDir: src2 } = await createDemoTimeoutDemo();

    try {
      // Both demos should assemble successfully
      assert.ok(demoExample.admission, 'example timeout demo should have admission');
      assert.ok(demoDemo.admission, 'demo copy demo should have admission');

      // Create a mapping of machine names to their state counts
      // report.files[].machines is an array of { machine, instance: { states } }
      const instanceSignature = (admission) => {
        const machines = {};
        for (const file of admission.report.files) {
          if (Array.isArray(file.machines)) {
            for (const m of file.machines) {
              machines[m.machine] = m.instance?.states ?? 0;
            }
          }
        }
        return machines;
      };

      // Extract the machines and their instance states from both admissions
      const exampleMachines = Object.keys(instanceSignature(demoExample.admission)).sort();
      const demoCopyMachines = Object.keys(instanceSignature(demoDemo.admission)).sort();

      // Both should have the same machines
      assert.deepEqual(exampleMachines, demoCopyMachines, 'both assemblies should have the same machines');

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
      await demoDemo.close();
      rmSync(dir2, { recursive: true, force: true, maxRetries: 3 });
      rmSync(src2, { recursive: true, force: true, maxRetries: 3 });
    }
  } finally {
    await demoExample.close();
    rmSync(dir1, { recursive: true, force: true, maxRetries: 3 });
    rmSync(src1, { recursive: true, force: true, maxRetries: 3 });
  }
});

// ---- DF13: the answer request recorded in a live demo has correct fields

test('DF13.1: a guest saying "where is my order?" triggers an answer request with correct fields', { timeout: 1_800_000 }, async () => {
  const { assembleDemo } = await import('../../demo/host/assemble.mjs');
  const { makeDemoConcierge } = await import('../../demo/scripts/make-demo-concierge.mjs');
  const { TASKS } = await import('../../demo/host/live-providers.mjs');
  const { stubTransport } = await import('../../demo/host/stub-model.mjs');
  const workdir = mkdtempSync(join(tmpdir(), 'demo-failures-df13-'));
  const sourceDir = mkdtempSync(join(tmpdir(), 'demo-copy-df13-'));

  // Create a fresh copy with price tables that pass the price gate
  makeDemoConcierge({ out: sourceDir });
  const smallOriginal = JSON.parse(readFileSync(join(sourceDir, 'prices', 'small.json'), 'utf8'));
  const largeOriginal = JSON.parse(readFileSync(join(sourceDir, 'prices', 'large.json'), 'utf8'));
  const smallPrice = { ...smallOriginal, source: 'https://pricing.vendorco.net/page', readOn: new Date().toISOString().slice(0, 10) };
  const largePrice = { ...largeOriginal, source: 'https://pricing.vendorco.net/page', readOn: new Date().toISOString().slice(0, 10) };
  writeFileSync(join(sourceDir, 'prices', 'small.json'), JSON.stringify(smallPrice));
  writeFileSync(join(sourceDir, 'prices', 'large.json'), JSON.stringify(largePrice));

  // Create a transport that records request bodies
  const recordedBodies = [];
  const recordingTransport = {
    async request(r) {
      try {
        recordedBodies.push(JSON.parse(r.body));
      } catch {
        // body is not JSON, skip recording
      }
      return stubTransport().request(r);
    },
  };

  const demo = await assembleDemo({
    mode: 'stub-model',
    workdir,
    capUsd: 5,
    now: () => Date.now(),
    startWorkers: true,
    limits: { minGapMs: 1000 },
    source: sourceDir,
    modelTransport: recordingTransport,
  });

  const { room } = demo;
  try {
    const guest = room.join('s1');
    const heard = [];
    room.subscribe('s1', (e) => heard.push(e));

    // Wait for room to settle
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = Date.now();
    const result = await room.say('s1', 'where is my order?');
    assert.deepEqual(result, { ok: true });

    // Wait up to 30 seconds for a reply event with the guest's order id
    const guestOrderId = guest.orders[0].id;
    const maxWait = 30_000;
    while (Date.now() - before < maxWait && !heard.find((e) => e.kind === 'reply' && e.text.includes(guestOrderId))) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const replyEvent = heard.find((e) => e.kind === 'reply' && e.text.includes(guestOrderId));
    assert.ok(replyEvent, `guest should get a reply naming their order ${guestOrderId} within ${maxWait} ms`);

    // Find the answer request in recorded bodies
    const answerRequest = recordedBodies.find((body) => {
      const system = body.system || '';
      const userMsg = body.messages?.[0]?.content || '';
      return system.includes(TASKS.answer) || userMsg.includes(TASKS.answer);
    });

    assert.ok(answerRequest, 'should have recorded an answer request');

    // Check the structure and content
    const keys = Object.keys(answerRequest).sort();
    assert.deepEqual(keys, ['max_tokens', 'messages', 'model', 'system', 'temperature'].sort(), `wrong keys: ${keys}`);
    assert.equal(answerRequest.model, smallPrice.model, `model should be ${smallPrice.model}`);
    assert.ok(Number.isInteger(answerRequest.max_tokens) && answerRequest.max_tokens > 0, `max_tokens should be whole number above 0, got ${answerRequest.max_tokens}`);
    assert.equal(answerRequest.temperature, 0.3, `temperature should be 0.3, got ${answerRequest.temperature}`);
    assert.ok(typeof answerRequest.system === 'string' && answerRequest.system.length > 0, 'system should be non-empty string');
    assert.ok(Array.isArray(answerRequest.messages) && answerRequest.messages.length > 0, 'messages should be non-empty array');

    // Check the user message content
    const userMsg = answerRequest.messages[0];
    assert.ok(userMsg.content.includes(TASKS.answer) || answerRequest.system.includes(TASKS.answer), 'should contain task sentence');
    assert.ok(userMsg.content.includes('where is my order'), 'should contain customer message');
    assert.ok(userMsg.content.includes(guestOrderId), `should contain guest order id ${guestOrderId}`);

    // Check for no null values
    const jsonStr = JSON.stringify(answerRequest);
    assert.ok(!jsonStr.includes('"null"'), 'should have no null values');

    // Check all numbers are finite
    const checkFinite = (val) => {
      if (typeof val === 'number') assert.ok(Number.isFinite(val), `${val} is not finite`);
      if (Array.isArray(val)) val.forEach(checkFinite);
      if (typeof val === 'object' && val !== null) Object.values(val).forEach(checkFinite);
    };
    checkFinite(answerRequest);
  } finally {
    if (demo) await demo.close();
    rmSync(workdir, { recursive: true, force: true, maxRetries: 3 });
    rmSync(sourceDir, { recursive: true, force: true, maxRetries: 3 });
  }
});
