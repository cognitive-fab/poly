// The code review of M6, part A (workflows): each finding, reproduced by a script under .poly/review-m6-a, is a test
// here that failed before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@poly/lang';
import { checkModule } from '@poly/core';
import { printModule } from '@poly/embed';
import { checkFile, checkProject, admit } from '@poly/check';
import { ROOT } from './helpers.mjs';
import { makeKey, project } from './runtime-helpers.mjs';

const SRC = readFileSync(join(ROOT, 'conformance', 'm6', 'brief.poly'), 'utf8');
const BASE = join(ROOT, '.poly', 'test-review-m6-a');
const START = 'action Start(date: string check { "2026-10-04", "2026-10-05" })';
const PAT = '"^\\\\d{4}-\\\\d{2}-\\\\d{2}$"';
const codes = (src) => { const r = parse(src); assert.ok(r.module, JSON.stringify(r.diagnostics)); return [...r.diagnostics, ...checkModule(r.module).diagnostics].map((d) => d.code); };
const fresh = (name) => { const d = join(BASE, name); rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); return d; };

test('review A-F1: a workflow name that is not a name is refused, and nothing outside the build is touched', async () => {
  const root = fresh('traversal');
  const victim = join(root, 'victim');
  mkdirSync(victim, { recursive: true });
  writeFileSync(join(victim, 'keep.txt'), 'user data\n');
  const m = parse(SRC).module;
  m.decls.find((d) => d.kind === 'Workflow').name = '../../../victim';
  writeFileSync(join(root, 'brief.ts'), printModule(m));
  const r = await checkFile(join(root, 'brief.ts'), { root });
  assert.equal(r.verdict, 'REFUSED');
  assert.ok(r.diagnostics.some((d) => d.code === 'PL1201' && /workflow name/.test(d.message)), JSON.stringify(r.diagnostics.map((d) => d.message)));
  assert.deepEqual(readdirSync(victim), ['keep.txt']);
});

test('review A-F2: every declared value of a key field is tested, ranges in full, enums by member, and an empty value is refused', () => {
  assert.ok(codes(SRC.replace(START, 'action Start(date: 0..10000)').replace(PAT, '"^\\\\d{1,4}$"')).includes('PL6802'), 'the last value of a large range');
  assert.ok(codes(SRC.replace('enum Phase', 'enum Day { Mon, Tue }\n\nenum Phase').replace(START, 'action Start(date: Day)').replace(PAT, '"^\\\\d+$"')).includes('PL6802'), 'an enum field');
  assert.ok(!codes(SRC.replace('enum Phase', 'enum Day { Mon, Tue }\n\nenum Phase').replace(START, 'action Start(date: Day)').replace(PAT, '"^(Mon|Tue)$"')).includes('PL6802'), 'an enum field its pattern accepts');
  assert.ok(codes(SRC.replace(START, 'action Start(date: string check { "", "2026-10-05" })').replace(PAT, '"^.*$"')).includes('PL6802'), 'an empty value');
});

test('review A-F3: a key field given two patterns is refused', () => {
  assert.ok(codes(SRC.replace(PAT, PAT + ', date matches "^.*$"')).includes('PL6802'));
});

test('review A-F4: two workflows that map one effect kind to different tools are refused, as polyflow refuses them', () => {
  const wf = SRC.slice(SRC.indexOf('workflow daily-brief'));
  const second = wf.replace('workflow daily-brief', 'workflow weekly-brief').replace('-> slack_send target "#cs"', '-> email_send target "team@example.com"');
  assert.ok(codes(SRC + '\n' + second).includes('PL6803'));
  assert.ok(!codes(SRC + '\n' + wf.replace('workflow daily-brief', 'workflow weekly-brief')).includes('PL6803'), 'the same mapping in two workflows is fine');
});

test('review A-F4, A-F5: across a project, workflows share one library: a name twice or a kind mapped two ways is refused', async () => {
  const key = makeKey('review-m6-a-project');
  const dir = project('review-m6-a-project', ['conformance/m6/brief.poly'], key, 'test-review-m6-a');
  writeFileSync(join(dir, 'src', 'brief2.poly'), SRC.replace('module brief', 'module brief2').replace('target "#cs"', 'target "#all-company"'));
  const r = await checkProject(dir, { root: dir });
  assert.notEqual(r.verdict, 'CLEAN');
  const ds = r.files.flatMap((f) => f.diagnostics);
  assert.ok(ds.some((d) => d.code === 'PL1002' && /workflow daily-brief/.test(d.message)), JSON.stringify(ds.map((d) => d.message)));
  writeFileSync(join(dir, 'src', 'brief2.poly'), SRC.replace('module brief', 'module brief2').replace('workflow daily-brief', 'workflow other-brief').replace('target "#cs"', 'target "#all-company"'));
  const r2 = await checkProject(dir, { root: dir });
  assert.ok(r2.files.flatMap((f) => f.diagnostics).some((d) => d.code === 'PL6803' && /brief\.post/.test(d.message)));
});

test('review A-F6: a renamed workflow leaves no descriptor behind, and a leftover directory does not stop a valid workflow\'s stage', async () => {
  const root = fresh('stale');
  const file = join(root, 'brief.poly');
  writeFileSync(file, SRC);
  await checkFile(file, { root });
  writeFileSync(file, SRC.replace('workflow daily-brief', 'workflow morning-brief'));
  const r = await checkFile(file, { root });
  assert.equal(r.verdict, 'CLEAN');
  assert.deepEqual(readdirSync(join(root, '.poly', 'build', 'workflows')), ['morning-brief']);
  mkdirSync(join(root, '.poly', 'build', 'workflows', 'old'), { recursive: true });
  writeFileSync(join(root, '.poly', 'build', 'workflows', 'old', 'polyflow.workflow.json'), JSON.stringify({ name: 'renamed', contract: '../../brief.Brief/contract.json' }));
  writeFileSync(file, SRC);
  const r2 = await checkFile(file, { root });
  assert.equal(r2.verdict, 'CLEAN', r2.error);
  // S175: the workflow stage is retired; the machine's own effects stage is the one the leftover must not stop.
  assert.equal(r2.machines[0].stages.find((s) => s.stage === 'effects')?.verdict, 'CLEAN');
});

test('review A-F7: a workflow in a module with a dotted name is admitted', async () => {
  const key = makeKey('review-m6-a-dotted');
  const dir = project('review-m6-a-dotted', ['conformance/m6/brief.poly'], key, 'test-review-m6-a');
  writeFileSync(join(dir, 'src', 'brief.poly'), SRC.replace('module brief', 'module ops.brief'));
  const a = await admit(dir);
  assert.deepEqual(a.certificate.poly.workflows.map((w) => w.machine), ['ops.brief.Brief']);
  assert.ok(existsSync(a.certificatePath));
});
