// PR-reviewer end-to-end test over recorded traffic.
// Tests the machine through its agent and recorded providers with no network or model calls.
// Rule 7a: Written from spec alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { copyFileSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { replayRuntime, replaySessions, admit } from '@poly/check';
import { ROOT } from '../helpers.mjs';
import { loadExample, recordingEgress } from '../ex-kit.mjs';
import { makeKey, project, signPolicies } from '../runtime-helpers.mjs';
import { acceptFindings } from '../ex-kit.mjs';
import { load } from '@poly/runtime';

const EX_DIR = join(ROOT, 'examples', 'pr-reviewer');

/**
 * Admits a pr-reviewer example as a project. Unlike admitExample, this copies host/agent.ts
 * as src/handlers.ts (the workflow uses an agent bridge, not a handler). Returns what loaded needs.
 */
async function admitPrReviewer(program, policy, tag, { accept = false } = {}) {
  const key = makeKey(`ex-${tag}`);
  const p = project(`ex-${tag}`, [], key, 'test-examples-e2e');

  // Copy the program and policy files.
  copyFileSync(join(EX_DIR, program), join(p, 'src', program));
  copyFileSync(join(EX_DIR, policy), join(p, 'src', policy));

  // Copy host/agent.ts as src/handlers.ts (the agent bridge is certified as handlers).
  copyFileSync(join(EX_DIR, 'host', 'agent.ts'), join(p, 'src', 'handlers.ts'));

  // Copy the prices directory.
  cpSync(join(EX_DIR, 'prices'), join(p, 'src', 'prices'), { recursive: true });

  // Sign and admit.
  await signPolicies(p);
  // The seeded defect has a finding; it runs only as an owner who accepted it would run it (PT12.5).
  if (accept) await acceptFindings(p);
  const r = await admit(p);
  return { dir: p, key, build: join(p, '.poly', 'build'), certificate: r.certificatePath, trust: { [key.id]: key.publicKey }, report: r.report };
}

let cachedAdmissionClean;
/** One admission for the whole file: each test loads its own runtime from the same certified build. */
const admittedClean = () => (cachedAdmissionClean ??= admitPrReviewer('pr-reviewer.poly', 'pr-reviewer.policy.poly', 'pr-reviewer-clean'));

let cachedAdmissionDefect;
const admittedDefect = () => (cachedAdmissionDefect ??= admitPrReviewer('pr-reviewer-defect.poly', 'pr-reviewer-defect.policy.poly', 'pr-reviewer-defect', { accept: true }));

test('pr-reviewer: admission checks the program and policy; the example admits', { timeout: 60_000 }, async () => {
  const a = await admittedClean();
  assert.ok(a.dir);
  assert.ok(a.report);
  assert.equal(a.report.verdict, 'CLEAN', JSON.stringify(a.report.diagnostics));
});

test('pr-reviewer: defect admission; admits FINDINGS PL4001', { timeout: 60_000 }, async () => {
  const a = await admittedDefect();
  assert.ok(a.report);
  assert.equal(a.report.verdict, 'FINDINGS', JSON.stringify(a.report.diagnostics));
  const allDiags = (a.report.files ?? []).flatMap((f) => [...f.machines, ...(f.configurations ?? []), ...(f.policies ?? [])].flatMap((m) => m.diagnostics ?? []));
  assert.ok(allDiags.some((d) => d.code === 'PL4001'), 'defect has PL4001');
});

test('pr-reviewer: main path - PR 1 issues orders in sequence, ends Done, with comment and label recorded', { timeout: 120_000 }, async () => {
  const { recordedAgent, recordedGithub, loadAnswers } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href + `?t=${Date.now()}`);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admittedClean();
  const egress = recordingEgress();
  const { rt, clock } = await loadExample(a, { transports: egress.transports });
  try {
    // Set up the agent and github providers.
    const agent = recordedAgent(answers);
    const github = recordedGithub(answers);
    const { perform } = await import(pathToFileURL(join(EX_DIR, 'host', 'agent.ts')).href + `?t=${Date.now()}`);

    // Create a run for PR 1.
    const id = '1';
    await rt.create('reviewer.Review', { id, creation: { action: 'Start', data: { pr: 1 } } });

    // Drive the workflow: each open order is performed and reported.
    const tools = [];
    for (let k = 0; k < 10; k++) {
      await rt.tick();
      const [order] = await rt.workOrders(id);
      if (!order) break;
      tools.push(order.tool);
      const report = await perform(order, { github: github.github, reviewer: agent.reviewer });
      await rt.reportWorkOrder(order.orderId, report);
    }

    // Verify the sequence of tools: gh_diff, reviewer, gh_comment, gh_label.
    assert.deepEqual(tools, ['gh_diff', 'reviewer', 'gh_comment', 'gh_label'], `tool sequence is gh_diff, reviewer, gh_comment, gh_label; got ${tools.join(', ')}`);

    // Check the final state: Done.
    const state = (await rt.getState(id)).state;
    assert.equal(state.phase, 'Done', `final phase is Done; got ${state.phase}`);
    assert.equal(state.number, 1, 'number is 1');
    assert.equal(state.outcome, 'Good', 'outcome is Good (from recorded review)');

    // Verify the recorded calls: comment and label were posted.
    assert.ok(github.calls.some((c) => c.method === 'comment'), 'github.comment was called');
    assert.ok(github.calls.some((c) => c.method === 'label'), 'github.label was called');
    // Verify lgtm label was set (Good verdict).
    assert.ok(github.calls.some((c) => c.method === 'label' && Object.values(c).includes('lgtm')), 'label lgtm was set for Good verdict');

    // No merge was issued.
    assert.ok(!github.calls.some((c) => c.method === 'merge'), 'github.merge was not called');
  } finally {
    await rt.close();
  }
});

test('pr-reviewer: PR 2 with Bad verdict sets needs-work label', { timeout: 120_000 }, async () => {
  const { recordedAgent, recordedGithub, loadAnswers } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href + `?t=${Date.now()}`);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admittedClean();
  const egress = recordingEgress();
  const { rt, clock } = await loadExample(a, { transports: egress.transports });
  try {
    const agent = recordedAgent(answers);
    const github = recordedGithub(answers);
    const { perform } = await import(pathToFileURL(join(EX_DIR, 'host', 'agent.ts')).href + `?t=${Date.now()}`);

    const id = '2';
    await rt.create('reviewer.Review', { id, creation: { action: 'Start', data: { pr: 2 } } });

    const tools = [];
    for (let k = 0; k < 10; k++) {
      await rt.tick();
      const [order] = await rt.workOrders(id);
      if (!order) break;
      tools.push(order.tool);
      const report = await perform(order, { github: github.github, reviewer: agent.reviewer });
      await rt.reportWorkOrder(order.orderId, report);
    }

    const state = (await rt.getState(id)).state;
    assert.equal(state.phase, 'Done');
    assert.equal(state.outcome, 'Bad', 'outcome is Bad (from recorded review of PR 2)');

    // Verify needs-work label was set (Bad verdict).
    assert.ok(github.calls.some((c) => c.method === 'label' && Object.values(c).includes('needs-work')), 'label needs-work was set for Bad verdict');
  } finally {
    await rt.close();
  }
});

// Corrected by the implementer after the code existed: a work order spends its order cap whatever usage it reports (the budget
// bounds by reservation, K15), so the writer's "10000 steps" case did not exhaust anything. The month cap does: 0.45 holds two
// reviews of 0.20 and the first order of a third.
test('pr-reviewer: budget refusal - a third review in the month is denied by the month cap and ends Failed', { timeout: 120_000 }, async () => {
  const { recordedAgent, recordedGithub, loadAnswers } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));
  const a = await admittedClean();
  const egress = recordingEgress();
  const { rt } = await loadExample(a, { transports: egress.transports });
  try {
    const agent = recordedAgent(answers);
    const github = recordedGithub(answers);
    const { perform } = await import(pathToFileURL(join(EX_DIR, 'host', 'agent.ts')).href);
    const deps = { github: github.github, reviewer: agent.reviewer };
    const drive = async (id) => {
      const tools = [];
      for (let k = 0; k < 10; k++) {
        await rt.tick();
        const [order] = await rt.workOrders(id);
        if (!order) break;
        tools.push(order.tool);
        await rt.reportWorkOrder(order.orderId, await perform(order, deps));
      }
      return tools;
    };
    for (const pr of [1, 2]) {
      await rt.create('reviewer.Review', { id: `m${pr}`, creation: { action: 'Start', data: { pr } } });
      assert.deepEqual(await drive(`m${pr}`), ['gh_diff', 'reviewer', 'gh_comment', 'gh_label']);
      assert.equal((await rt.getState(`m${pr}`)).state.phase, 'Done');
    }
    await rt.create('reviewer.Review', { id: 'm3', creation: { action: 'Start', data: { pr: 3 } } });
    // The third review gets its diff (0.05 fits the month's last 0.05) and no more.
    assert.deepEqual(await drive('m3'), ['gh_diff']);
    const denied = (await rt.chain('m3')).filter((e) => e.kind === 'verdict' && e.body.outcome === 'denied');
    assert.deepEqual(denied.map((e) => [e.body.effectKind, e.body.reason]), [['agent.review', 'budget']]);
    assert.equal((await rt.getState('m3')).state.phase, 'Failed');
    assert.ok(!github.calls.some((c) => c.method === 'comment' && c.number === 3), 'no comment was posted for pull request 3');
  } finally {
    await rt.close();
  }
});

test('pr-reviewer: policy refusal - defect program reaches Merging, gate denies merge, run ends Failed', { timeout: 120_000 }, async () => {
  const { recordedAgent, recordedGithub, loadAnswers } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href + `?t=${Date.now()}`);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admittedDefect();
  const egress = recordingEgress();
  const { rt, clock } = await loadExample(a, { transports: egress.transports });
  try {
    const agent = recordedAgent(answers);
    const github = recordedGithub(answers);
    const { perform } = await import(pathToFileURL(join(EX_DIR, 'host', 'agent.ts')).href + `?t=${Date.now()}`);

    const id = '1';
    await rt.create('reviewer.Review', { id, creation: { action: 'Start', data: { pr: 1 } } });

    const tools = [];
    let mergeWasDenied = false;
    for (let k = 0; k < 15; k++) {
      await rt.tick();
      const [order] = await rt.workOrders(id);
      if (!order) {
        // Check if merge was denied by policy.
        const chain = await rt.chain(id);
        const verdicts = chain.filter((e) => e.kind === 'verdict' && e.body.effectKind === 'github.merge');
        for (const v of verdicts) {
          // The budget is consulted before the policy, so the reason tells which refused: it must not be the budget's.
          if (v.body.outcome === 'denied' && v.body.effectKind === 'github.merge' && v.body.reason !== 'budget') {
            mergeWasDenied = true;
          }
        }
        break;
      }
      tools.push(order.tool);
      const report = await perform(order, { github: github.github, reviewer: agent.reviewer });
      await rt.reportWorkOrder(order.orderId, report);
    }

    // Verify merge was denied by policy.
    assert.ok(mergeWasDenied, 'github.merge was denied by policy');

    // Run should end in Failed.
    const state = (await rt.getState(id)).state;
    assert.equal(state.phase, 'Failed', `defect run ends in Failed after merge denial; got ${state.phase}`);

    // Verify no merge order was issued.
    assert.ok(!tools.includes('gh_merge'), 'no gh_merge order was issued');
  } finally {
    await rt.close();
  }
});

test('pr-reviewer: journal replays with no divergence', { timeout: 120_000 }, async () => {
  const { recordedAgent, recordedGithub, loadAnswers } = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href + `?t=${Date.now()}`);
  const answers = loadAnswers(join(EX_DIR, 'recorded', 'answers.json'));

  const a = await admittedClean();
  const egress = recordingEgress();
  const { rt, clock } = await loadExample(a, { transports: egress.transports });
  try {
    const agent = recordedAgent(answers);
    const github = recordedGithub(answers);
    const { perform } = await import(pathToFileURL(join(EX_DIR, 'host', 'agent.ts')).href + `?t=${Date.now()}`);

    const id = '1';
    await rt.create('reviewer.Review', { id, creation: { action: 'Start', data: { pr: 1 } } });

    // Drive the workflow to completion.
    for (let k = 0; k < 10; k++) {
      await rt.tick();
      const [order] = await rt.workOrders(id);
      if (!order) break;
      const report = await perform(order, { github: github.github, reviewer: agent.reviewer });
      await rt.reportWorkOrder(order.orderId, report);
    }

    // Replay the runtime.
    const replays = await replayRuntime(rt);
    for (const r of replays) {
      assert.deepEqual([r.diagnostics, r.notRun ?? null, r.gateNotRun], [[], null, 0], `divergence in ${r.machine}: ${JSON.stringify(r.diagnostics)}`);
    }

    // Check that reviewer.Review is among the replayed machines.
    const kinds = new Set(replays.map((x) => x.machine));
    assert.ok(kinds.has('reviewer.Review'), `reviewer.Review should be in replayed machines; got ${[...kinds].join(', ')}`);

    // Replay sessions (decisions and policies).
    const sessions = await replaySessions(rt);
    assert.ok(sessions.length > 0, 'there are gate sessions to replay');
    for (const s of sessions) {
      assert.deepEqual([s.diagnostics.length, s.notRun.length], [0, 0], `session divergence: ${JSON.stringify(s.diagnostics)}`);
    }

    console.log(`replay: ${replays.length} runs, ${replays.reduce((n, x) => n + x.rows, 0)} rows; ${sessions.length} gate sessions; divergences: ${replays.reduce((n, x) => n + x.diagnostics.length, 0) + sessions.reduce((n, s) => n + s.diagnostics.length, 0)}`);
  } finally {
    await rt.close();
  }
});
