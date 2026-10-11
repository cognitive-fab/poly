// plan-e3.md E3.1, HAC1 (proposals/example-harness.md): each rule of HF3 has a seeded variant that breaks it, and
// `poly check` gives a finding with a witness for each. Written before the module (examples/harness/harness.poly), so
// every test here fails until E3.2 writes it; the failing reason is "the file does not exist".
//
// The contract with the module. A rule's guard is one line of the module, tagged with a trailing `// @HF3.n`. A variant
// replaces that whole line with the line below, and nothing else. A tag must occur exactly once in the module that holds
// it. So the module must write each guard as one line, and the replacement must be valid there: the names it uses are
// the module's own (E3.2 writes them and may change a replacement, recording why in decisions-e3.md).
//
//   rule    where it lives                 the guard (tagged line)                                      expected finding
//   HF3.1   Session.Measured, the gate     compaction at a finished step or at the limit                PL3002
//   HF3.2   Receipt.Show                   shown only when verified and not flagged                     PL3002
//   HF3.3   Observation.Put                a handle is issued after the archive stores                  PL5401 (configuration)
//   HF3.4   Session.Planned                fused only when the classifier said fusable                  PL3002
//   HF3.5   Session.StoreLog               a flagged log is never stored as clean                       PL3002
//   HF3.6   decision agent                 the reservation fits the per-run cap                         PL6845
//   HF3.7   Session.Stepped                a step is not ended on an output cutoff before a reprompt    PL3002
//   HF3.8   Session.Overflowed             overflow tries one compaction first                          PL3002
//   HF3.9   Session.CapReached             a cap saves the work before the trial ends                   PL3002
//   HF3.10  harness.policy.poly            the offline scope denies a network effect                    PL6503
//   HF3.11  host/change-gate.mjs           a change outside the editable surface is refused             (not a poly check)
//
// The statements the guards support (in the module, untagged): `never ... : emit compact() while mode is Working && ctx
// < 14`; `never ... : emit showReceipt() while st != Verified || secret`; the configuration invariant `o is Handled
// implies a is Held`; `never ... : emit fuse() while !fusable`; `never ... : emit storeClean() while secret`;
// `never ... : emit endStep() while stop == Length && reprompts < 1`; `never ... : emit endTrial() while attempts == 0`;
// `never ... : emit endTrial() while capped && !saved`; and the policy's `never offline-no-network`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';
import { checkExample, expectedOf, mismatch } from './examples-expected.mjs';

const DIR = join(ROOT, 'examples', 'harness');
const PROGRAM = join(DIR, 'harness.poly');
const POLICY = join(DIR, 'harness.policy.poly');
const OUT = join(ROOT, '.poly', 'test-build', 'e3-hac1');

/** Replaces the one line that carries `@tag` with `line`, keeping its indentation. */
function seed(src, tag, line) {
  const lines = src.split('\n');
  const at = lines.map((l, i) => (l.trimEnd().endsWith(`// @${tag}`) ? i : -1)).filter((i) => i >= 0);
  assert.equal(at.length, 1, `the tag @${tag} must mark exactly one line (found ${at.length})`);
  const indent = /^\s*/.exec(lines[at[0]])[0];
  lines[at[0]] = `${indent}${line}`;
  return lines.join('\n');
}

async function checkVariant(name, mutateProgram, mutatePolicy) {
  const dir = join(OUT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'harness.poly'), mutateProgram(readFileSync(PROGRAM, 'utf8')));
  writeFileSync(join(dir, 'harness.policy.poly'), mutatePolicy(readFileSync(POLICY, 'utf8')));
  for (const d of ['maps', 'prices']) if (existsSync(join(DIR, d))) cpSync(join(DIR, d), join(dir, d), { recursive: true });
  return checkExample(join(dir, 'harness.poly'), join(dir, 'root'), `e3-hac1-${name}`);
}

const keep = (s) => s;
const codesOf = (r) => [...new Set([...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...r.configurations.flatMap((c) => c.diagnostics)].map((d) => d.code))].sort();
const findings = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...r.configurations.flatMap((c) => c.diagnostics)];

test('HAC1 control: the harness module is CLEAN with its policy, and no rule is vacuous', async () => {
  const e = expectedOf(PROGRAM);
  assert.deepEqual(e, { verdict: 'CLEAN', codes: [] }, 'the module states its expected verdict on its first line');
  const r = await checkExample(PROGRAM, join(OUT, 'base-root'), 'e3-hac1-base');
  assert.equal(mismatch(e, r), null, codesOf(r).join(' '));
  assert.deepEqual((r.warnings ?? []).filter((w) => /vacuous/i.test(`${w.code} ${w.message}`)), [], 'a rule the instance never exercises is a finding, not a pass');
});

// [tag, rule, the replacement line, expected code, where the witness is required, file to mutate]
const VARIANTS = [
  ['HF3.1', 'compaction in the middle of a plan step', 'require mode is Working || mode is Finished else reject "mid-step"', 'PL3002', true, 'program'],
  ['HF3.2', 'a receipt the verifier did not pass is shown', 'require st is Verified || st is Rejected else reject "not-verified"', 'PL3002', true, 'program'],
  ['HF3.3', 'a handle issued before the archive holds the output', 'on Put { require st is Empty else reject "not-empty"  st\' = Full  send arch <- Store(from: self) }', 'PL5401', true, 'program'],
  ['HF3.4', 'a command fused without the classifier\'s word', 'require mode is Acting else reject "not-acting"', 'PL3002', true, 'program'],
  ['HF3.5', 'a flagged log stored as clean', 'require mode is Observing else reject "not-observing"', 'PL3002', true, 'program'],
  ['HF3.6', 'a reservation above the task\'s cap', 'prices "prices/main.json" max input tokens 100000 max tokens 8000000 budget task', 'PL6845', false, 'program'],
  ['HF3.7', 'a step ended on an output cutoff', 'require mode is Observing else reject "not-observing"', 'PL3002', true, 'program'],
  ['HF3.8', 'a trial ended on overflow with no compaction tried', 'emit endTrial()', 'PL3002', true, 'program'],
  ['HF3.9', 'a trial ended at a cap without saving the work', 'emit endTrial()', 'PL3002', true, 'program'],
  ['HF3.10', 'an offline run that allows a network effect', 'when proposal.kind == "decision"', 'PL6503', true, 'policy'],
];

for (const [tag, what, line, code, witness, file] of VARIANTS) {
  test(`HAC1 ${tag}: ${what} is ${code}${witness ? ' with a witness' : ''}`, async () => {
    const r = await checkVariant(tag, file === 'program' ? (s) => seed(s, tag, line) : keep, file === 'policy' ? (s) => seed(s, tag, line) : keep);
    assert.equal(r.verdict, 'FINDINGS', `${tag}: ${r.verdict} ${codesOf(r).join(' ')}`);
    assert.deepEqual(codesOf(r), [code], `${tag} must give exactly ${code}`);
    if (witness) {
      const w = findings(r).filter((d) => d.code === code).map((d) => d.witness).filter(Boolean);
      assert.ok(w.length > 0, `${tag}: no witness`);
      assert.ok(w.every((x) => (x.trace?.length ?? x.length ?? 0) > 0), `${tag}: an empty witness`);
    }
  });
}

// HF3.11 is not a property of a machine: the loop must not change its own rules or its signed policy. The gate that
// refuses a change outside the editable surface is host code (plan-e3.md S557), so its test is a unit test.
test('HAC1 HF3.11: a change to a rule file, the policy or a path outside the editable surface is refused', async () => {
  const { checkChange } = await import(join(DIR, 'host', 'change-gate.mjs'));
  const ok = checkChange({ root: DIR, changed: ['editable/prompts/system.md', 'editable/skills/fix-tests.md', 'editable/thresholds.poly'] });
  assert.equal(ok.accepted, true, JSON.stringify(ok));
  for (const file of ['harness.poly', 'harness.policy.poly', 'host/change-gate.mjs', 'prices/main.json', '../harness/harness.poly', 'editable/../harness.poly']) {
    const r = checkChange({ root: DIR, changed: ['editable/prompts/system.md', file] });
    assert.equal(r.accepted, false, `${file} was accepted`);
    assert.ok(r.refused.some((x) => x.file === file && x.reason.length > 0), `${file}: no reason given`);
  }
});
