// M6 step 3: the workflow lowering (PT10, S164, S165). poly check writes each workflow's polyflow.workflow.json under
// .poly/build/workflows/<name>/, naming the machine's lowered files, and always writes the machine's
// effect-invariants.mjs. Since M8a (S175) a workflow runs on poly-runtime, each work order through the gate (S173):
// polyflow's admission no longer runs in poly check, a workflow's machine is checked by poly's own stages, and the
// certificate lists each workflow as run on poly-runtime and gated.
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
  // S175: no stage runs polyflow's admission; the machine's own stages decide it.
  assert.ok(!r.machines[0].stages.some((s) => /polyflow/.test(s.engine ?? '') || s.stage === 'workflow'), JSON.stringify(r.machines[0].stages));
  assert.equal(r.machines[0].stages.find((s) => s.stage === 'effects')?.verdict, 'CLEAN');
});

test('S175: a workflow longer than polyflow\'s old admission bound is decided by poly\'s own effects stage, over every path', async () => {
  const r = await checkFile(join(ROOT, 'conformance', 'm6', 'long.poly'), { root: OUT });
  assert.equal(r.verdict, 'CLEAN', JSON.stringify(r.machines[0].diagnostics));
  assert.equal(r.machines[0].stages.find((s) => s.stage === 'effects')?.verdict, 'CLEAN');
  assert.ok(!r.machines[0].stages.some((s) => s.stage === 'workflow'));
});

test('S175: the certificate lists every workflow as run on poly-runtime and gated, with no ungated limit, and certifies its descriptor', async () => {
  const key = makeKey('workflow-cert');
  const dir = project('workflow-cert', ['conformance/m6/brief.poly'], key);
  const a = await admit(dir);
  assert.deepEqual(a.certificate.poly.workflows, [{ name: 'daily-brief', machine: 'brief.Brief', runtime: 'poly-runtime', gated: true, descriptor: '.poly/build/workflows/daily-brief/polyflow.workflow.json' }]);
  assert.ok(a.certificate.artefacts['.poly/build/workflows/daily-brief/polyflow.workflow.json']);
  assert.ok(!a.certificate.poly.limits.some((l) => /ungated|polyflow/.test(l)), JSON.stringify(a.certificate.poly.limits));
});

// Polywatch on step 3: a stage an earlier stage stopped is listed as not run, never left out (review P7). Since S175 a
// workflow's machine has no stage of its own, so its effects stage is the one listed.
test('S165: when an earlier stage stops, a workflow machine\'s effects stage is listed as not run', async () => {
  const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
  const dir = join(ROOT, '.poly', 'test-workflow-notrun');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'brief.poly'), readFileSync(BRIEF, 'utf8').replace("    phase' = Posted\n", "    phase' = Posted\n    nothing' = 1\n"));
  const r = await checkFile(join(dir, 'brief.poly'), { root: dir });
  assert.equal(r.verdict, 'REFUSED');
  const stage = r.machines[0].stages.find((s) => s.stage === 'effects');
  assert.equal(stage?.status, 'not-run', JSON.stringify(r.machines[0].stages));
});

// Polywatch on step 3: a workflow descriptor rewritten after the check ran is refused at admission, as a machine's
// artefact is (review A1): certified bytes must be the checked bytes.
test('S164: a descriptor rewritten after the check is refused at admission, not certified', async () => {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { AdmitError } = await import('@poly/check');
  const key = makeKey('workflow-race');
  const dir = project('workflow-race', ['conformance/m6/brief.poly'], key);
  const f = join(dir, '.poly', 'build', 'workflows', 'daily-brief', 'polyflow.workflow.json');
  const tamper = () => writeFileSync(f, readFileSync(f, 'utf8').replace('"slack_send"', '"shell_exec"'));
  await assert.rejects(admit(dir, { afterCheck: tamper }), (e) => e instanceof AdmitError && /polyflow\.workflow\.json.*not the bytes the check checked/.test(e.message));
});

// S172 (decisions-m6.md): polyflow admits only a workflow whose machine has at least one path property, so poly check
// refuses one with none, at the workflow's line, with PL6804; before the code, such a check ended in ERROR.
test('S172: a workflow whose machine declares no path property is PL6804 and REFUSED, at the workflow line', async () => {
  const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
  const dir = join(ROOT, '.poly', 'test-workflow-unchecked');
  mkdirSync(dir, { recursive: true });
  const src = readFileSync(BRIEF, 'utf8').replace('  path property one-post: count("brief.post") <= 1\n\n', '');
  writeFileSync(join(dir, 'brief.poly'), src);
  const r = await checkFile(join(dir, 'brief.poly'), { root: dir });
  assert.equal(r.verdict, 'REFUSED', r.error ?? '');
  const d = r.diagnostics.find((x) => x.code === 'PL6804');
  assert.ok(d, JSON.stringify(r.diagnostics));
  assert.equal(d.at.line, src.split('\n').findIndex((l) => l.startsWith('workflow daily-brief')) + 1);
  assert.match(d.message, /polyflow admits only workflows whose machine has at least one path property/);
  assert.equal(d.fixes?.length ?? 0, 0);
});
