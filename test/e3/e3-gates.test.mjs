// plan-e3.md E3.2 ruling 2 (decisions-e3.md): a gate written as an always-taken if is only exercised if both of its
// branches are reached in the checked state space. A branch that is never reached makes its rule vacuous in substance even
// when the checker passes it. For each branch of each gate, this test adds an invariant saying that the branch's
// signature state is unreachable, and requires the checker to violate it with a witness: the branch is reached.
//
// S564: the gate of Context starts a compaction with two intents in one step, the effect startCompaction and the summary
// decision, because a never cannot name a decision. The second half of this file is the lint that they stay in one step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers.mjs';
import { checkExample as checkOne } from '../examples-expected.mjs';
import { heavy } from './e3-lock.mjs';

const checkExample = (...args) => heavy(() => checkOne(...args));

const DIR = join(ROOT, 'examples', 'harness');
const SRC = readFileSync(join(DIR, 'harness.poly'), 'utf8');
const OUT = join(ROOT, '.poly', 'test-build', 'e3-gates');

// [gate, branch, the machine's anchor line (a never of that machine), the invariant that says the branch is unreachable]
const BRANCHES = [
  ['Context.Measured', 'taken (a compaction starts)', '  never compact-at-step-end-or-limit:', 'invariant taken-unreached: compactions == 0'],
  ['Context.Measured', 'declined (nothing starts)', '  never compact-at-step-end-or-limit:', 'invariant declined-unreached: !skipped'],
  ['Context.Overflowed', 'first (one compaction is tried)', '  never compact-at-step-end-or-limit:', 'invariant first-unreached: attempts == 0'],
  ['Context.Overflowed', 'second (the trial ends on overflow)', '  never compact-at-step-end-or-limit:', 'invariant ends-unreached: !(mode is Closed)'],
  ['Turn.Go', 'a cutoff step waits for the reprompt', '  never fuse-needs-the-classifier:', 'invariant waits-unreached: !(mode is Continuing)'],
  ['Turn.Go', 'a fusable call is fused', '  never fuse-needs-the-classifier:', 'invariant fuses-unreached: !(mode is Acting && plan is Fusable)'],
  ['Turn.Go', 'a call that is not fusable runs apart', '  never fuse-needs-the-classifier:', 'invariant apart-unreached: !(mode is Acting && plan is Separate)'],
  ['Turn.StoreLog', 'a clean log is stored', '  never fuse-needs-the-classifier:', 'invariant clean-unreached: !(mode is Checking && !secret)'],
  ['Turn.StoreLog', 'a flagged log is stored redacted', '  never fuse-needs-the-classifier:', 'invariant redacted-unreached: !(mode is Checking && secret)'],
  ['Receipt.Show', 'a verified receipt is shown', '  never only-verified-reach-the-agent:', 'invariant receipt-unreached: !(st is Shown)'],
  ['Receipt.Show', 'the original is shown instead', '  never only-verified-reach-the-agent:', 'invariant original-unreached: !(st is Original)'],
  ['Trial.Close', 'a cap ends the trial', '  never cap-saves-first:', 'invariant cap-end-unreached: !(mode is Stopped && capped)'],
  ['Trial.Close', 'another reason ends the trial', '  never cap-saves-first:', 'invariant other-end-unreached: !(mode is Stopped && !capped)'],
];

function withInvariant(anchor, line) {
  assert.equal(SRC.split(anchor).length, 2, `the anchor ${anchor} must occur once`);
  return SRC.replace(anchor, `  ${line}\n${anchor}`);
}

for (const [gate, branch, anchor, line] of BRANCHES) {
  test(`E3.2 ruling 2: ${gate}, ${branch}, is reached in the checked state space`, async () => {
    const name = `${gate}-${branch}`.replace(/[^A-Za-z0-9]+/g, '-');
    const dir = join(OUT, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'harness.poly'), withInvariant(anchor, line));
    writeFileSync(join(dir, 'harness.policy.poly'), readFileSync(join(DIR, 'harness.policy.poly'), 'utf8'));
    for (const d of ['maps', 'prices']) if (existsSync(join(DIR, d))) cpSync(join(DIR, d), join(dir, d), { recursive: true });
    const r = await checkExample(join(dir, 'harness.poly'), join(dir, 'root'), `e3-gates-${name}`);
    const hits = r.machines.flatMap((m) => m.diagnostics).filter((d) => d.witness && /invariant|unreached/i.test(`${d.property ?? ''} ${d.message}`));
    assert.ok(hits.length > 0, `the invariant "${line}" was not violated, so the branch is never reached: ${r.verdict} ${r.machines.flatMap((m) => m.diagnostics).map((d) => d.code).join(' ')}`);
  });
}

// S564: the intents of one gate step. startCompaction and decide summarise are written in the same handler, and in no
// other, so no path has one without the other. This is a source lint, as S562's is: the checker cannot say it.
/** The handlers of a machine: name and body, from `on Name` to the closing brace at the same indent. */
function handlers(src, machine) {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`machine ${machine} `) || l.startsWith(`service machine ${machine} `));
  const out = [];
  for (let i = start + 1; i < lines.length && lines[i] !== '}'; i++) {
    const m = /^ {2}on (\w+)/.exec(lines[i]);
    if (!m) continue;
    let j = i;
    while (!(lines[j] === '  }' || (j === i && lines[j].trimEnd().endsWith('}')))) j++;
    out.push({ name: m[1], body: lines.slice(i, j + 1).join('\n') });
    i = j;
  }
  return out;
}

test('S564: in Context, the handlers that emit startCompaction are exactly the ones that decide summarise', () => {
  const hs = handlers(SRC, 'Context');
  const starts = hs.filter((h) => h.body.includes('emit startCompaction()')).map((h) => h.name);
  const decides = hs.filter((h) => h.body.includes('decide summarise(')).map((h) => h.name);
  assert.deepEqual(starts, ['Measured', 'Overflowed']);
  assert.deepEqual(decides, starts);
  for (const h of hs.filter((x) => starts.includes(x.name))) {
    const a = h.body.indexOf('emit startCompaction()');
    const b = h.body.indexOf('decide summarise(');
    // the same branch of the gate: no closing brace between them
    const [lo, hi] = a < b ? [a, b] : [b, a];
    assert.ok(!h.body.slice(lo, hi).includes('}'), `${h.name}: the two intents are in different branches`);
  }
});

test('S564: a variant that splits the pair across two steps is caught by the lint', () => {
  const split = SRC.replace(/ {6}emit startCompaction\(\)\n {6}decide summarise\(context: context\)\n( {4}\} else \{\n {6}skipped)/, '      emit startCompaction()\n$1');
  assert.notEqual(split, SRC, 'the seeded split did not apply');
  const hs = handlers(split, 'Context');
  const starts = hs.filter((h) => h.body.includes('emit startCompaction()')).map((h) => h.name);
  const decides = hs.filter((h) => h.body.includes('decide summarise(')).map((h) => h.name);
  assert.notDeepEqual(decides, starts, 'the lint must see that Measured starts without deciding');
});
