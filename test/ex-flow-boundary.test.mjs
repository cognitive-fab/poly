// docs/examples/language-findings.md, "Where the static check stops" (finding 17): one test for each claim about what the
// check follows for taint and what only the gate enforces. The fixtures are test/fixtures/flow-boundary/*.poly, small
// programs over one audience and one owned source, so each claim is shown on the smallest program that holds it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile, checkProject } from '@poly/check';
import { parse } from '@poly/lang';
import { policyFacts, proposalTable } from '@poly/ref';
import { ROOT } from './helpers.mjs';
import { makeKey, project, signPolicies } from './runtime-helpers.mjs';

const FIX = (f) => join(ROOT, 'test', 'fixtures', 'flow-boundary', f);
const text = (f) => readFileSync(FIX(f), 'utf8');

/** Every diagnostic of a project report, whatever it belongs to (a machine, a configuration, a policy). */
const diagnosticsOf = (r) => (r.files ?? []).flatMap((f) => [...f.machines, ...(f.configurations ?? []), ...(f.policies ?? [])].flatMap((m) => m.diagnostics ?? []));

/** The check of a program with a policy beside it, as a project, the policy signed as a person signs it. */
async function withPolicy(name, program, policy) {
  const dir = project(name, [], makeKey(name), 'test-flow-boundary');
  writeFileSync(join(dir, 'src', 'fb.poly'), program);
  writeFileSync(join(dir, 'src', 'fb.policy.poly'), policy);
  await signPolicies(dir);
  const r = await checkProject(dir, { root: dir });
  return { verdict: r.verdict, codes: [...new Set(diagnosticsOf(r).map((d) => d.code))].sort(), diagnostics: diagnosticsOf(r), report: r };
}

/** A policy of the scope "fb_input" (a scope is the module it governs) with the given obligations and statements. */
const policy = (body) => `module fb_policy\n\npolicy fb {\n  scope "fb_input"\n${body}\n}\n`;
const GATE_BY_PHASE = `  obligation summarize-while-summing "The decision runs only while the briefing is summing." rule {
    when proposal.kind == "effect" && effect.kind == "decision.summarize"
    require machine("fb_input.Briefing").phase == Summing else deny
    on unknown deny
  }`;
const RETRIEVAL_ONLY = `  obligation retrieve-while-reading "A retrieval runs only while the briefing is reading." rule {
    when proposal.kind == "effect" && effect.kind == "source.notes.retrieve"
    require machine("fb_input.Briefing").phase == Reading else deny
    on unknown deny
  }`;
const DENIES = `  obligation external-audience "The external provider is given nothing above customer." rule {
    when proposal.kind == "effect" && effect.kind == "decision.summarize" && !(effect.taint.class in { "public", "customer" })
    require false else deny
    on unknown deny
  }`;
const NEVER =`  never notes-to-external "Notes never reach the external provider.": allow when effect.kind == "decision.summarize" && effect.taint.class == "owner"`;

// FOLLOWED -----------------------------------------------------------------------------------------------------------

test('claim 1, followed: the flow rule follows a taint from a source through a retrieval and a decision\'s answer to an effect below it, PL6831 with a 3-step witness (PS17.3)', async () => {
  const r = await checkFile(FIX('leak.poly'), { root: join(ROOT, '.poly', 'test-flow-boundary') });
  const codes = [...new Set([...(r.diagnostics ?? []), ...r.machines.flatMap((m) => m.diagnostics)].map((d) => d.code))];
  assert.equal(r.verdict, 'FINDINGS');
  assert.deepEqual(codes, ['PL6831']);
  const d = r.machines.flatMap((m) => m.diagnostics).find((x) => x.code === 'PL6831');
  assert.equal(d.witness.length, 3);
  assert.deepEqual(d.witness.trace.map((s) => s.action), ['Open', 'Read', 'Written']);
});

test('claim 2, followed: a message carrying a tainted Content to a machine no configuration holds with the sender is PL6838, inconclusive, never a silent clean (S322)', async () => {
  const r = await checkFile(FIX('send-taint.poly'), { root: join(ROOT, '.poly', 'test-flow-boundary') });
  const diags = [...(r.diagnostics ?? []), ...r.machines.flatMap((m) => m.diagnostics)];
  assert.equal(r.verdict, 'INCONCLUSIVE');
  assert.deepEqual([...new Set(diags.map((d) => d.code))], ['PL6838']);
});

test('claim 3, followed: regions follow labels, not taint classes: a decision that reads private data and egresses is PL7001 until a rule names it, and a never statement gates nothing (PT8.4, S161)', async () => {
  const program = text('decision-input.poly');
  // A policy that names the retrieval and not the decision: the region is reached at decision.summarize.
  const ungated = await withPolicy('fb-ungated', program, policy(RETRIEVAL_ONLY));
  assert.deepEqual(ungated.codes, ['PL7001']);
  assert.match(ungated.diagnostics.find((d) => d.code === 'PL7001').message, /decision\.summarize/);
  // A never statement over the decision is proved and still does not gate it (review B10).
  const neverOnly = await withPolicy('fb-never-only', program, policy(`${RETRIEVAL_ONLY}\n${NEVER}`));
  assert.ok(neverOnly.codes.includes('PL7001'), `a never gates nothing: ${neverOnly.codes}`);
  // A rule that names it gates it, whatever the rule says about taint: here it reads only the phase.
  const gated = await withPolicy('fb-gated', program, policy(GATE_BY_PHASE));
  assert.deepEqual([gated.verdict, gated.codes], ['CLEAN', []]);
});

// NOT FOLLOWED -------------------------------------------------------------------------------------------------------

test('claim 4, not followed: the owner\'s notes reach an external decision and the check says CLEAN, with no policy and with a policy that gates the decision by phase alone', async () => {
  const r = await checkFile(FIX('decision-input.poly'), { root: join(ROOT, '.poly', 'test-flow-boundary') });
  assert.equal(r.verdict, 'CLEAN', JSON.stringify(r.diagnostics));
  const gated = await withPolicy('fb-gated-again', text('decision-input.poly'), policy(GATE_BY_PHASE));
  assert.deepEqual([gated.verdict, gated.codes], ['CLEAN', []]);
  // The flow rule's own words: it applies to every intent of an effect other than a retrieval, a decision or a remember.
  const ps = readFileSync(join(ROOT, 'docs', '04-semantics.md'), 'utf8');
  assert.match(ps, /for every intent of an effect other than a retrieval, a decision or a `remember`, the recipient may read the taint of every `Content` value of the payload/);
});

test('claim 5, not followed: a decision\'s provider is a string no check and no policy reads; changing it changes no verdict, no diagnostic and no instance', async () => {
  const a = await withPolicy('fb-provider-a', text('decision-input.poly'), policy(GATE_BY_PHASE));
  const b = await withPolicy('fb-provider-b', text('decision-input.poly').replace('provider "external"', 'provider "a-model-in-another-country"'), policy(GATE_BY_PHASE));
  assert.deepEqual([b.verdict, b.codes], [a.verdict, a.codes]);
  const states = (x) => x.report.files.flatMap((f) => f.machines).map((m) => [m.machine, m.instance?.states]);
  assert.deepEqual(states(b), states(a));
  // What a policy can read of a decision's proposal: no provider among the fields of any row of the decision table.
  const program = parse(text('decision-input.poly')).module;
  const scope = { scope: 'fb_input', policies: parse(policy(`${GATE_BY_PHASE}\n${DENIES}`)).module.decls.filter((d) => d.kind === 'Policy') };
  const rows = proposalTable(scope, policyFacts([program])).rows.filter((x) => x.effect?.kind === 'decision.summarize');
  assert.ok(rows.length > 0);
  const fields = new Set(rows.flatMap((x) => Object.keys(x.effect)));
  assert.ok(!fields.has('provider') && !fields.has('model'), `fields: ${[...fields]}`);
  assert.ok(fields.has('taint'), 'a decision is proposed with its taint, once a rule reads it');
});

test('claim 6, not followed: the decision table gives a rule the decision\'s taint classes, and only the gate applies them; the check of the program reads none', async () => {
  // The rule that holds the line is a policy rule over effect.taint.class. Without it the table proposes the owner class to
  // the decision and allows it (the never is violated, PL6503); the program's own check is CLEAN either way (claim 4).
  const allowsOwner = await withPolicy('fb-allows-owner', text('decision-input.poly'), policy(`${GATE_BY_PHASE}\n${NEVER}`));
  assert.ok(allowsOwner.codes.includes('PL6503'), `the policy allows the owner class: ${allowsOwner.codes}`);
  const holds = await withPolicy('fb-denies-owner', text('decision-input.poly'), policy(`${GATE_BY_PHASE}\n${DENIES}\n${NEVER}`));
  assert.deepEqual([holds.verdict, holds.codes], ['CLEAN', []]);
});

// GATE ONLY AT RUN TIME ----------------------------------------------------------------------------------------------

test('claim 7, only the gate: the run-time enforcements named in PT10k are each shown by an existing end-to-end test, which exists and asserts the denial', () => {
  const read = (f) => readFileSync(join(ROOT, 'test', f), 'utf8');
  // The decision denied for a taint above its audience: examples/support-drafts' end-to-end test.
  assert.match(readFileSync(join(ROOT, 'test', 'after', 'ex-support-drafts-e2e.test.mjs'), 'utf8'), /effectKind === 'decision\.summary' && e\.body\.outcome === 'denied'/);
  // The effect's recipient below a taint, denied `audience` before the handler (AC22), and the stale items, denied (S307).
  assert.match(read('memory-enforce.test.mjs'), /AC22 \(run time\): the variant without where owner == customer has its reply denied audience before the handler runs/);
  assert.match(read('memory-enforce.test.mjs'), /S307: with stale deny, the answer over stale orders is denied stale-items/);
});
