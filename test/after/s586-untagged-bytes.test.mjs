// S586, RT15: for every policy in examples/, demo/ and conformance/ that has no tag, the lowered document, its digest,
// the signed subject and `poly check`'s output are byte-identical to v1.5.1's. Written by a separate writer from the
// specification alone, before any code (rule 7a).
//
// How v1.5.1's bytes were obtained: from the tag itself. A detached worktree of v1.5.1 was built with its own packages
// (test/fixtures/s586/record-v151.mjs says how), and test/fixtures/s586/untagged-policies.mjs recorded every policy
// source there into test/fixtures/s586/v1.5.1-untagged.json. This test records the same on the tree under test and
// compares, record for record. The comparison covers each scope's document as lowerPolicyScope gives it, and, for a
// policy with its program beside it, the document `poly check` writes and its SHA-256, the subject of each scope
// (policySubjects, PT12.5), the text `poly check` prints with its exit code, and the report it writes (the stages'
// timings left out). Paths are written relative to the repository.
//
// It runs in the serial group (test/after/, ruled 2026-10-10), since it checks the concierge and the inbox with their
// whole pipelines. A guard: it holds on the tree before S586 is built, and must hold after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ROOT } from '../helpers.mjs';
import { policySources, recordPolicy, tagged } from '../fixtures/s586/untagged-policies.mjs';

const BASELINE = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 's586', 'v1.5.1-untagged.json'), 'utf8'));
const byFile = new Map(BASELINE.records.map((r) => [r.file, r]));
const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
// RT15 is about the policies v1.5.1 had: an untagged policy written since (a defect variant of a new example, say) has
// no v1.5.1 bytes to equal, and is listed rather than failed.
const untaggedNow = policySources().filter((f) => !tagged(readFileSync(join(ROOT, f), 'utf8')));
const untagged = untaggedNow.filter((f) => byFile.has(f));

test('RT15: every untagged policy source that v1.5.1 had is the source it was recorded on', (t) => {
  const added = untaggedNow.filter((f) => !byFile.has(f));
  if (added.length) t.diagnostic(`untagged and new since v1.5.1, so not compared: ${added.join(', ')}`);
  assert.ok(untagged.length > 0, 'sources are compared');
  for (const f of untagged) assert.equal(sha(readFileSync(join(ROOT, f))), byFile.get(f).sourceDigest, `${f} is the source v1.5.1 was recorded on`);
});

for (const file of untagged) {
  test(`RT15: ${file}: the lowered document, its digest, the signed subject and poly check's output are v1.5.1's`, { timeout: 1_800_000 }, async () => {
    const want = byFile.get(file);
    assert.ok(want, 'recorded at v1.5.1');
    const got = await recordPolicy(file);
    assert.deepEqual(got.lowered, want.lowered, 'the document of each scope');
    if (want.project) {
      assert.deepEqual(got.documents, want.documents, 'the document poly check writes, by its SHA-256');
      assert.deepEqual(got.subjects, want.subjects, 'the signed subject of each scope');
      assert.equal(got.report, want.report, 'the report poly check writes');
    }
    assert.equal(got.exit, want.exit, 'the exit code');
    assert.equal(got.output, want.output, 'the text poly check prints');
  });
}
