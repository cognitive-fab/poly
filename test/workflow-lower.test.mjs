// M6 step 3: the workflow lowering (PT10, S164, S165). poly check writes each workflow's polyflow.workflow.json under
// .poly/build/workflows/<name>/, naming the machine's lowered files, and always writes the machine's
// effect-invariants.mjs, which polyflow imports. The workflow stage runs polyflow's own admission (the vendored
// library's certify, at its bounds), so CLEAN in poly means admitted by polyflow, and a bounded run is INCONCLUSIVE.
// The certificate lists every workflow as ungated: polyflow runtime, so it never reads as covered by the gate (PA0.4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile, admit } from '@poly/check';
import { ROOT } from './helpers.mjs';
import { makeKey, project } from './runtime-helpers.mjs';

const BRIEF = join(ROOT, 'conformance', 'm6', 'brief.poly');
const OUT = join(ROOT, '.poly', 'test-workflow');

test('S165: poly check writes the workflow descriptor beside the machine, naming its lowered files', async () => {
  rmSync(OUT, { recursive: true, force: true });
  const r = await checkFile(BRIEF, { root: OUT });
  assert.equal(r.verdict, 'CLEAN', JSON.stringify(r.machines.flatMap((m) => m.diagnostics)));
  const wfDir = join(OUT, '.poly', 'build', 'workflows', 'daily-brief');
  const d = JSON.parse(readFileSync(join(wfDir, 'polyflow.workflow.json'), 'utf8'));
  assert.equal(d.name, 'daily-brief');
  assert.equal(d.inputAction, 'Start');
  assert.deepEqual(d.tools, { 'brief.fetch': { tool: 'github_search_issues', why: 'gather the day\'s tickets' }, 'brief.post': { tool: 'slack_send', target: '#cs', why: 'publish the brief' } });
  assert.deepEqual(d.key, { template: '{date}', fields: { date: { pattern: '^\\d{4}-\\d{2}-\\d{2}$' } } });
  for (const k of ['contract', 'machine', 'effects', 'manifest', 'effectInvariants', 'invariants']) assert.ok(existsSync(join(wfDir, d[k])), `${k}: ${d[k]}`);
  assert.equal(d.machine, '../../brief.Brief/next.cjs');
  assert.match(readFileSync(join(wfDir, d.effectInvariants), 'utf8'), /effectInvariants/);
  const stage = r.machines[0].stages.find((s) => s.stage === 'workflow');
  assert.equal(stage?.verdict, 'CLEAN', JSON.stringify(r.machines[0].stages));
  assert.match(stage.engine, /polyflow/);
});

test('S165: a workflow longer than polyflow\'s admission bound is INCONCLUSIVE, never CLEAN, and polyflow refuses it', async () => {
  const r = await checkFile(join(ROOT, 'conformance', 'm6', 'long.poly'), { root: OUT });
  const stage = r.machines[0].stages.find((s) => s.stage === 'workflow');
  assert.equal(stage?.verdict, 'INCONCLUSIVE', JSON.stringify(r.machines[0].stages));
  assert.notEqual(r.verdict, 'CLEAN');
  assert.ok(r.machines[0].diagnostics.some((d) => d.code === 'PL3901' && /polyflow/.test(d.message)));
});

test('S164: the certificate lists every workflow as ungated: polyflow runtime, and certifies its descriptor', async () => {
  const key = makeKey('workflow-cert');
  const dir = project('workflow-cert', ['conformance/m6/brief.poly'], key);
  const a = await admit(dir);
  assert.deepEqual(a.certificate.poly.workflows, [{ name: 'daily-brief', machine: 'brief.Brief', runtime: 'polyflow', gated: false, descriptor: '.poly/build/workflows/daily-brief/polyflow.workflow.json' }]);
  assert.ok(a.certificate.artefacts['.poly/build/workflows/daily-brief/polyflow.workflow.json']);
  assert.ok(a.certificate.poly.limits.some((l) => /ungated: polyflow runtime/.test(l) && /daily-brief/.test(l)), JSON.stringify(a.certificate.poly.limits));
});
