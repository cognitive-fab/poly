// Step 12 (DF10, DAC15): the spend cap in stub mode with a fake meter. The demo assembled with a
// controlled meter and small cap shows that the room is killed when the cap is reached, that the
// formatter follows each reply, and that the stub mode needs no key and no price gate pass.
// Heavy: admission takes minutes; copy the way demo-concierge-e2e.test.mjs assembles the demo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleDemo, LaunchRefused } from '../../demo/host/assemble.mjs';

const fakeMeter = () => {
  let spent = 0;
  let callCount = 0;
  let capUsdValue = 1;
  let reached = false;
  return {
    spentUsd: () => spent,
    calls: () => callCount,
    capUsd: capUsdValue,
    capReached: () => reached,
    reserve: (req) => {
      callCount++;
      return { id: `res-${callCount}` };
    },
    settle: (res, resp) => {
      if (resp instanceof Error) {
        spent += 0.01;
      } else if (resp.status === 200) {
        spent += 0.001;
      }
      if (spent >= capUsdValue) reached = true;
    },
    setSpent: (val) => { spent = val; },
    setCap: (val) => { capUsdValue = val; },
    setReached: (val) => { reached = val; },
  };
};

test('DF10.1: assembleDemo in stub mode without capUsd throws LaunchRefused', { timeout: 1_800_000 }, async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'demo-spend-stub-'));
  try {
    await assert.rejects(
      () => assembleDemo({ mode: 'stub-model', workdir }),
      (e) => e instanceof LaunchRefused && /cap|usd/i.test(e.message)
    );
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('DF10: stub mode needs no key and no price gate pass', { timeout: 1_800_000 }, async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'demo-spend-stub-'));
  let t = 1_790_000_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  try {
    const demo = await assembleDemo({
      mode: 'stub-model',
      workdir,
      capUsd: 0.1,
      now: clock.now,
      meter: fakeMeter(),
      limits: { minGapMs: 1000, maxMessages: 3 },
    });
    assert.ok(demo, 'assembled with stub mode and cap, no key');
    await demo.close();
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('DF10.5: when meter becomes capReached the room is killed with spend-cap exactly once', { timeout: 1_800_000 }, async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'demo-spend-stub-'));
  let t = 1_790_000_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const meter = fakeMeter();
  const kills = [];
  try {
    const demo = await assembleDemo({
      mode: 'stub-model',
      workdir,
      capUsd: 0.01,
      now: clock.now,
      meter,
      onKill: (reason) => {
        kills.push(reason);
      },
      limits: { minGapMs: 1000, maxMessages: 3 },
    });
    const { room } = demo;
    const guest = room.join('s1');

    meter.setReached(true);
    clock.advance(1100);
    const result = await room.say('s1', 'refund me');
    assert.deepEqual(result, { ok: false, reason: 'halted' }, 'after kill, room.say returns halted');
    assert.deepEqual(kills, ['spend-cap'], 'room killed with spend-cap exactly once');

    await demo.close();
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('DF10.6: onReply fires after a reply with { session }', { timeout: 1_800_000 }, async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'demo-spend-stub-'));
  let t = 1_790_000_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const meter = fakeMeter();
  const replies = [];
  try {
    const demo = await assembleDemo({
      mode: 'stub-model',
      workdir,
      capUsd: 1,
      now: clock.now,
      meter,
      onReply: ({ session }) => {
        replies.push(session);
      },
      limits: { minGapMs: 1000, maxMessages: 3 },
    });
    const { room } = demo;
    room.join('s1');

    clock.advance(1100);
    await room.say('s1', 'hello');

    assert.ok(replies.length > 0, 'onReply was called');
    assert.ok(replies[0] === 's1', `onReply receives session s1 (got ${replies[0]})`);

    await demo.close();
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('DF10.4, DF10.6: demo.meter is returned', { timeout: 1_800_000 }, async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'demo-spend-stub-'));
  let t = 1_790_000_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const meter = fakeMeter();
  try {
    const demo = await assembleDemo({
      mode: 'stub-model',
      workdir,
      capUsd: 1,
      now: clock.now,
      meter,
      limits: { minGapMs: 1000, maxMessages: 3 },
    });
    assert.equal(demo.meter, meter, 'demo.meter is the fake meter');
    await demo.close();
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});
