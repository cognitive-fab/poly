// The merge of M10 and M11 (PT10k, PS17.4, PS18.4): the checks before the policy run in one order, the memory check
// (the flow rule and freshness), the budget's fit, the grant check, the mandate, then the policy, and the first that
// refuses decides. The memory check and the budget's fit never meet on one intent: the memory check reads an intent's
// Content and Items, the budget's fit reads a tier's call, and a tier's call carries only its tier number. The one
// intent that could have met both, a routed decision over a body, is refused at check since F1 of the review of the
// merge was ruled (PL6839, PS18.2), so the program this test ran at the merge is no longer admitted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile } from '@poly/check';
import { ROOT, TEST_STD } from './helpers.mjs';
import { admittedDesk, DESK, FIX } from './routing-helpers.mjs';

const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.replace(from, to); };

test('PT10k, PS18.2: a routed decision over a body, which alone could meet the memory check and the budget, is refused PL6839', { timeout: 300_000 }, async () => {
  let src = swap(DESK, 'enum Branch', 'audience { public < customer }\n\nenum Branch');
  src = swap(src, '  action Received(text: string check { "where is my refund" })', '  action Received(text: string check { "where is my refund" }, note: Content)');
  src = swap(src, '  on Received(text) {', '  on Received(text, note) {');
  src = swap(src, '    decide classify(text)', '    decide classify(text, note)');
  src = swap(src, '  decision classify(text: string) -> Branch {', '  decision classify(text: string, note: Content) -> Branch {');
  src = swap(src, '  cap usd 0.5 per run', '  cap usd 0.127 per run');
  await assert.rejects(admittedDesk('merge-order', src), /not admitted: the verdict is REFUSED/);
  const d = join(ROOT, '.poly', 'test-merge-order');
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  for (const x of ['prices', 'maps']) cpSync(join(FIX, x), join(d, x), { recursive: true });
  writeFileSync(join(d, 'desk.poly'), src);
  const r = await checkFile(join(d, 'desk.poly'), { root: d, std: TEST_STD });
  const codes = [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics)].map((x) => x.code);
  assert.deepEqual([...new Set(codes)], ['PL6839'], JSON.stringify(codes));
});
