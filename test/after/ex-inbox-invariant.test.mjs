// IT4.4, IAC10 (M7, the defect the loop found): the invariant the person stated in place of the mined count is not vacuous.
//   draft-created-once: made implies (status != Drafted && status != Enveloping && status != Proposed && status != Uncertain)
// Once a draft has been created for certain, the to-do never returns to a status from which a createDraft can be proposed.
// The fixed inbox (a made flag, set by Created and DraftFound, which Enveloped checks) holds it; the same inbox with one
// handler that takes a Created to-do back to Drafted violates it, with a witness. Why a mutation and not the unfixed inbox:
// the unfixed inbox has no way to tell an ambiguous failure from a definite one (both are NotCreated), so the invariant
// cannot be stated over it; its own violation is the count witness recorded in decisions-m7.md. Two checks of the inbox, run
// alone (one heavy job at a time). Written by the implementer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkProject } from '@poly/check';
import { makeKey, project, signPolicies } from '../runtime-helpers.mjs';
import { DRAFT, POLICY, SOURCE } from '../ex-inbox-helpers.mjs';

export const INVARIANT = 'invariant draft-created-once: made implies (status != Drafted && status != Enveloping && status != Proposed && status != Uncertain)';
const NL = SOURCE.includes('\r\n') ? '\r\n' : '\n';

function withInvariant(source, extra = '') {
  const at = `  terminal status in { Done, Dismissed }${NL}`;
  assert.equal(source.split(at).length, 2, 'one place for the invariant: after the Todo\'s terminal statuses');
  return source.replace(at, () => `${at}${NL}  ${INVARIANT}${NL}${extra}`);
}
const REOPEN = ['  action Reopen()', '  on Reopen {', '    require status == Created else reject "not-created"', "    status' = Drafted", '  }', ''].join(NL) + NL;

async function check(name, source) {
  const dir = project(name, [], makeKey(name), 'test-ex-inbox');
  writeFileSync(join(dir, 'src', 'inbox.poly'), source);
  writeFileSync(join(dir, 'src', 'inbox.policy.poly'), POLICY);
  cpSync(join(DRAFT, 'prices'), join(dir, 'src', 'prices'), { recursive: true });
  cpSync(join(DRAFT, 'maps'), join(dir, 'src', 'maps'), { recursive: true });
  const cfg = JSON.parse(readFileSync(join(dir, 'poly.json'), 'utf8'));
  writeFileSync(join(dir, 'poly.json'), JSON.stringify({ ...cfg, credentials: { gmail_draft: { store: 'kms' }, gmail_read: { store: 'kms' } } }, null, 2));
  await signPolicies(dir);
  return JSON.stringify(await checkProject(dir));
}

test('IAC10: the fixed inbox holds the invariant, and an inbox that takes a created to-do back to Drafted violates it with a witness', { timeout: 3_600_000 }, async () => {
  const held = await check('ex-inbox-invariant-holds', withInvariant(SOURCE));
  assert.ok(!held.includes('draft-created-once'), 'the invariant is not reported violated');
  assert.match(held, /"verdict":"CLEAN"|CLEAN/, 'the control: the fixed inbox with the invariant checks CLEAN');
  const broken = await check('ex-inbox-invariant-broken', withInvariant(SOURCE.replace(/\r\n/g, '\n').replace('  on Finish {', REOPEN.replace(/\r\n/g, '\n') + '  on Finish {').split('\n').join(NL)));
  assert.ok(broken.includes('draft-created-once'), 'the mutation violates the invariant');
  assert.ok(broken.includes('Reopen'), 'the witness names the step that undoes it');
});
