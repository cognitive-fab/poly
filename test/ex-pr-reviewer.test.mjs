// PR-reviewer example tests: light checks (node:test).
// The tests are written from docs/examples/pr-reviewer.md alone, before any code exists.
// Rule 7a: The tests verify the spec without reading the program files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from '@poly/lang';
import { commandNamed } from '@poly/check';
import { decide, initialSigma, policyFacts, proposalTable } from '@poly/ref';
import { ROOT } from './helpers.mjs';
import { checkExample, expectedOf, mismatch } from './examples-expected.mjs';

const EX_DIR = join(ROOT, 'examples', 'pr-reviewer');
const PROGRAM = join(EX_DIR, 'pr-reviewer.poly');
const DEFECT = join(EX_DIR, 'pr-reviewer-defect.poly');

// ── light checks ──

test('the program, checked with its policy, is CLEAN with Review and Budget instances printed', async () => {
  const report = await checkExample(PROGRAM, ROOT, 'ex-pr-reviewer-clean');
  const expected = expectedOf(PROGRAM);
  assert.ok(expected, 'the program\'s first line declares its expected verdict');
  const m = mismatch(expected, report);
  assert.equal(m, null, m);
  assert.equal(report.verdict, 'CLEAN');

  // Verify that the policy is paired with the program (per spec).
  const policies = report.policies ?? [];
  assert.ok(policies.some((p) => p.scope === 'reviewer'), 'the policy is paired with the program with scope reviewer');

  // Verify the instances are printed: Review and Budget machines.
  const machines = report.machines ?? [];
  const review = machines.find((m) => m.machine === 'Review');
  const budget = machines.find((m) => m.machine === 'review_spend.Budget');
  assert.ok(review, 'machine Review is present');
  assert.ok(budget, 'machine review_spend.Budget is present');

  for (const mach of [review, budget]) {
    const inst = mach.instance;
    assert.ok(inst, `instance is present for ${mach.machine}`);
    assert.ok(inst.domains && Array.isArray(inst.domains), `instance has domains array for ${mach.machine}`);
    assert.ok(typeof inst.states === 'number', `instance has states count for ${mach.machine}`);
  }

  console.log(`pr-reviewer instances: Review over ${review.instance.domains.join('; ')}; ${review.instance.states} states`);
  console.log(`pr-reviewer budget: review_spend.Budget over ${budget.instance.domains.join('; ')}; ${budget.instance.states} states`);
});

test('the defect is FINDINGS with exactly PL4001, named never-merges, with a 5-step witness ending in Labelled', async () => {
  const report = await checkExample(DEFECT, ROOT, 'ex-pr-reviewer-defect');
  const expected = expectedOf(DEFECT);
  assert.ok(expected, 'the defect\'s first line declares expected FINDING PL4001');
  const m = mismatch(expected, report);
  assert.equal(m, null, m);
  assert.equal(report.verdict, 'FINDINGS');

  // Find the PL4001 diagnostic.
  const machines = report.machines ?? [];
  const allDiags = machines.flatMap((m) => m.diagnostics ?? []);
  const pl4001 = allDiags.find((d) => d.code === 'PL4001');
  assert.ok(pl4001, `PL4001 not found; found: ${allDiags.map((d) => d.code).join(', ')}`);
  assert.equal(pl4001.name, 'PATH_PROPERTY', 'the finding is a path property violation');
  assert.ok(pl4001.property, 'the property is named');
  assert.equal(pl4001.property, 'never-merges', 'the property is never-merges');

  // Check the witness: 5 steps.
  assert.ok(pl4001.witness, 'the diagnostic has a witness');
  assert.equal(pl4001.witness.length, 5, `witness length is 5; got ${pl4001.witness.length}`);
  assert.equal(pl4001.witness.trace.length, 5, 'witness.trace.length === 5');

  // Verify the last step is Labelled (which emits merge).
  const actions = pl4001.witness.trace.map((s) => s.action);
  assert.equal(actions[4], 'Labelled', 'the last step is Labelled');
});

test('the program\'s policy with no-merge changed to allow gives PL6503 NEVER_VIOLATED over the clean program', async () => {
  // Create a temporary directory with the modified policy.
  const tmpRoot = join(ROOT, '.poly', `pr-reviewer-allow-merge-${Date.now()}`);
  mkdirSync(join(tmpRoot, 'src'), { recursive: true });

  // Copy the program unchanged.
  const program = readFileSync(PROGRAM, 'utf8');
  writeFileSync(join(tmpRoot, 'src', 'pr-reviewer.poly'), program);

  // Copy and modify the policy: change "require false" to "require true" in no-merge obligation.
  const policyPath = join(EX_DIR, 'pr-reviewer.policy.poly');
  let policy = readFileSync(policyPath, 'utf8');
  const noMergeStart = policy.indexOf('no-merge');
  assert.ok(noMergeStart >= 0, 'no-merge obligation exists in policy');
  const blockEnd = policy.indexOf('\n  }\n', noMergeStart);
  assert.ok(blockEnd > noMergeStart, 'no-merge obligation block found');
  const before = policy.slice(0, noMergeStart);
  const block = policy.slice(noMergeStart, blockEnd + 5);
  const after = policy.slice(blockEnd + 5);
  const modifiedBlock = block.replace(/require\s+false/, 'require true');
  assert.notEqual(modifiedBlock, block, 'the mutation must change the policy');
  const modifiedPolicy = before + modifiedBlock + after;
  writeFileSync(join(tmpRoot, 'src', 'pr-reviewer.policy.poly'), modifiedPolicy);

  // Copy prices directory.
  cpSync(join(EX_DIR, 'prices'), join(tmpRoot, 'src', 'prices'), { recursive: true });

  // Check the modified policy.
  const report = await checkExample(join(tmpRoot, 'src', 'pr-reviewer.poly'), tmpRoot, 'ex-pr-reviewer-allow-merge');
  const allDiags = [...(report.diagnostics ?? []), ...report.machines.flatMap((m) => m.diagnostics ?? [])];
  const pl6503 = allDiags.find((d) => d.code === 'PL6503');
  assert.ok(pl6503, `PL6503 not found; found: ${allDiags.map((d) => d.code).join(', ')}`);
  assert.equal(pl6503.name, 'NEVER_VIOLATED', 'the finding is a never statement violation');
});

test('the defect program\'s policy: decision table denies every github.merge, allows github.comment in Commenting phase only', async () => {
  // Parse the defect program with its policy.
  const defectSrc = readFileSync(DEFECT, 'utf8');
  const policyPath = join(EX_DIR, 'pr-reviewer-defect.policy.poly');
  const policySrc = readFileSync(policyPath, 'utf8');

  const program = parse(defectSrc).module;
  const policyModule = parse(policySrc).module;
  assert.ok(program && policyModule, 'program and policy parse');

  const scope = { scope: 'reviewer', policies: policyModule.decls.filter((d) => d.kind === 'Policy') };
  const { rows } = proposalTable(scope, policyFacts([program]));

  // Test github.merge: every row should be denied.
  const mergeRows = rows.filter((x) => x.effect?.kind === 'github.merge');
  assert.ok(mergeRows.length > 0, 'table proposes github.merge');
  for (const row of mergeRows) {
    const d = decide(scope, initialSigma(scope), row);
    assert.equal(d.decision, 'deny', `merge should be denied: ${JSON.stringify(d)}`);
  }

  // Test github.comment: allowed in Commenting phase, denied elsewhere.
  const commentRows = rows.filter((x) => x.effect?.kind === 'github.comment');
  assert.ok(commentRows.length > 0, 'table proposes github.comment');

  // Separate by phase. We need to grep for how the phase is carried in the row.
  const inCommenting = commentRows.filter((row) => {
    // The decision context should carry the phase in row.held or row.context or similar.
    // Check all properties for 'Commenting'.
    const str = JSON.stringify(row);
    return str.includes('Commenting');
  });
  const notInCommenting = commentRows.filter((row) => !JSON.stringify(row).includes('Commenting'));

  assert.ok(inCommenting.length > 0, 'some github.comment proposals are in Commenting phase');
  assert.ok(notInCommenting.length > 0, 'some github.comment proposals are not in Commenting phase');

  for (const row of inCommenting) {
    const d = decide(scope, initialSigma(scope), row);
    assert.equal(d.decision, 'allow', `comment in Commenting should be allowed: ${JSON.stringify(d)}`);
  }

  for (const row of notInCommenting) {
    const d = decide(scope, initialSigma(scope), row);
    assert.equal(d.decision, 'deny', `comment outside Commenting should be denied: ${JSON.stringify(d)}`);
  }
});

test('poly check --host with root examples/pr-reviewer is CLEAN', { timeout: 120_000 }, async () => {
  // The host check uses host/tsconfig.json at the example root.
  const hostTsConfig = join(EX_DIR, 'host', 'tsconfig.json');
  const r = await commandNamed('check').run({ target: PROGRAM, root: EX_DIR, host: hostTsConfig });
  assert.equal(r.result.verdict, 'CLEAN', JSON.stringify(r.result.host?.diagnostics));
  assert.equal(r.result.host.status, 'ran');
  assert.deepEqual(r.result.host.diagnostics, []);
});

test('a host agent with a wrong args field is PL6836', { timeout: 120_000 }, async () => {
  // Create a temporary broken version of the agent to test PL6836 detection.
  const tmpRoot = join(tmpdir(), `poly-test-pr-reviewer-host-${Date.now()}`);
  mkdirSync(join(tmpRoot, 'host'), { recursive: true });

  // Copy the correct agent and tsconfig.
  const agent = join(EX_DIR, 'host', 'agent.ts');
  const tsConfig = join(EX_DIR, 'host', 'tsconfig.json');
  let agentSrc = readFileSync(agent, 'utf8');

  // Break a type the bridge takes from types.d.ts: the label effect's verdict field. (order.args is a plain record, so a wrong
  // key in it is no type error; the generated Effects type is what the compiler holds the bridge to.)
  const broken = agentSrc.split("['verdict']").join("['verdikt']");
  assert.notEqual(broken, agentSrc, 'the mutation must change the file');
  writeFileSync(join(tmpRoot, 'host', 'agent.ts'), broken);
  writeFileSync(join(tmpRoot, 'host', 'tsconfig.json'), readFileSync(tsConfig, 'utf8'));

  // Also copy the program to tmpRoot.
  writeFileSync(join(tmpRoot, 'pr-reviewer.poly'), readFileSync(PROGRAM, 'utf8'));

  // Copy prices directory.
  cpSync(join(EX_DIR, 'prices'), join(tmpRoot, 'prices'), { recursive: true });

  // Run the host check on the broken agent.
  const r = await commandNamed('check').run({ target: join(tmpRoot, 'pr-reviewer.poly'), root: tmpRoot, host: join(tmpRoot, 'host', 'tsconfig.json') });

  // Every diagnostic should be PL6836.
  assert.ok(r.result.host.diagnostics.length > 0, 'there are diagnostics for the broken agent');
  const allCodes = r.result.host.diagnostics.map((d) => d.code);
  assert.ok(allCodes.every((c) => c === 'PL6836'), `all codes should be PL6836; got ${allCodes.join(', ')}`);
});

test('the agent perform: each tool reports as specified; gh_merge returns ok:false; error from deps returns ok:false', async () => {
  // Cache-bust the import with a timestamp to reload the module.
  const tag = `t=${Date.now()}`;
  const agentModule = await import(pathToFileURL(join(EX_DIR, 'host', 'agent.ts')).href + `?${tag}`);
  const recordedModule = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href + `?${tag}`);
  const { perform } = agentModule;

  // Set up recorded dependencies.
  const answersFile = join(EX_DIR, 'recorded', 'answers.json');
  const answers = recordedModule.loadAnswers(answersFile);
  const { github, reviewer } = {
    github: recordedModule.recordedGithub(answers).github,
    reviewer: recordedModule.recordedAgent(answers).reviewer,
  };
  const deps = { github, reviewer };

  // Test gh_diff tool.
  const diffOrder = { tool: 'gh_diff', kind: 'github.diff', args: { pr: 1 } };
  const diffReport = await perform(diffOrder, deps);
  assert.equal(diffReport.ok, true, 'gh_diff reports ok:true');
  assert.deepEqual(diffReport.usage, { step: 1000 }, 'gh_diff usage is step:1000');

  // Test gh_reviewer tool (review tool).
  const reviewOrder = { tool: 'reviewer', kind: 'agent.review', args: { pr: 1 } };
  const reviewReport = await perform(reviewOrder, deps);
  assert.equal(reviewReport.ok, true, 'reviewer reports ok:true');
  assert.ok(typeof reviewReport.result.verdict === 'string', 'reviewer result has verdict');
  assert.ok(typeof reviewReport.usage.step === 'number', 'reviewer usage has step count');

  // Test gh_comment tool.
  const commentOrder = { tool: 'gh_comment', kind: 'github.comment', args: { pr: 1, verdict: 'Good' } };
  const commentReport = await perform(commentOrder, deps);
  assert.equal(commentReport.ok, true, 'gh_comment reports ok:true');
  assert.deepEqual(commentReport.usage, { step: 1000 }, 'gh_comment usage is step:1000');

  // Test gh_label tool.
  const labelOrder = { tool: 'gh_label', kind: 'github.label', args: { pr: 1, verdict: 'Good' } };
  const labelReport = await perform(labelOrder, deps);
  assert.equal(labelReport.ok, true, 'gh_label reports ok:true');
  assert.deepEqual(labelReport.usage, { step: 1000 }, 'gh_label usage is step:1000');

  // Test gh_merge tool: should return ok:false since the bridge has no merge.
  const mergeOrder = { tool: 'gh_merge', kind: 'github.merge', args: { pr: 1 } };
  const mergeReport = await perform(mergeOrder, deps);
  assert.equal(mergeReport.ok, false, 'gh_merge returns ok:false');

  // Test unknown tool: should return ok:false.
  const unknownOrder = { tool: 'unknown_tool', kind: 'unknown.kind', args: {} };
  const unknownReport = await perform(unknownOrder, deps);
  assert.equal(unknownReport.ok, false, 'unknown tool returns ok:false');

  // Test error from deps: fake a throwing github.diff.
  const faultyDeps = {
    github: { diff: async () => { throw new Error('network error'); } },
    reviewer: deps.reviewer,
  };
  const faultyOrder = { tool: 'gh_diff', kind: 'github.diff', args: { pr: 1 } };
  const faultyReport = await perform(faultyOrder, faultyDeps);
  assert.equal(faultyReport.ok, false, 'error from deps returns ok:false');
});

test('recordedAgent: each pull request is found and recorded; unknown pr throws', async () => {
  const answersFile = join(EX_DIR, 'recorded', 'answers.json');
  const recordedModule = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href + `?t=${Date.now()}`);
  const { loadAnswers, recordedAgent } = recordedModule;

  const answers = loadAnswers(answersFile);
  const { reviewer, asked } = recordedAgent(answers);

  // Test each recorded pull request.
  for (const expectedPr of [1, 2, 3]) {
    const result = await reviewer.review(expectedPr, 'dummy-diff');
    assert.ok(result.verdict, `PR ${expectedPr} has a verdict`);
    assert.ok(typeof result.verdict === 'string', `PR ${expectedPr} verdict is a string`);
    assert.ok(typeof result.comment === 'string', `PR ${expectedPr} comment is a string`);
    assert.ok(typeof result.steps === 'number', `PR ${expectedPr} steps is a number`);
  }

  // Test unknown PR throws.
  await assert.rejects(async () => reviewer.review(999, 'dummy-diff'), /no recorded|unknown/i, 'unknown PR throws');

  // Verify asked records decision and pr, not other fields.
  assert.ok(Array.isArray(asked), 'asked is an array');
  for (const entry of asked) {
    assert.ok('number' in entry, 'asked entry has number');
    assert.ok(!('diff' in entry), 'asked entry does NOT have diff');
  }
});

test('recordedGithub: each method records its calls; the return value is determined by the recorded data', async () => {
  const answersFile = join(EX_DIR, 'recorded', 'answers.json');
  const recordedModule = await import(pathToFileURL(join(EX_DIR, 'host', 'recorded.mjs')).href + `?t=${Date.now()}`);
  const { loadAnswers, recordedGithub } = recordedModule;

  const answers = loadAnswers(answersFile);
  const { github, calls } = recordedGithub(answers);

  // Perform some calls.
  await github.diff(1);
  await github.comment(1, 'Looks good');
  await github.label(1, 'lgtm');

  // Verify calls were recorded with method, number, and other fields.
  assert.ok(Array.isArray(calls), 'calls is an array');
  assert.ok(calls.length >= 3, 'at least 3 calls recorded');

  // Verify each call has method and number fields.
  for (const call of calls) {
    assert.ok('method' in call, 'call has method field');
    assert.ok('number' in call, 'call has number field');
  }

  // Verify the methods match what we called.
  assert.ok(calls.some((c) => c.method === 'diff'), 'diff call recorded');
  assert.ok(calls.some((c) => c.method === 'comment'), 'comment call recorded');
  assert.ok(calls.some((c) => c.method === 'label'), 'label call recorded');
});
