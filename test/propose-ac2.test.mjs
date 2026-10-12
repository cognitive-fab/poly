// M7-AC2 (the acceptance criterion of M7.3): a polyness proposal arrives as poly source and is admitted or refused by the pipeline.
// The leg runs real polyness over SYNTHETIC transcripts (test/fixtures/m7/make-transcripts.mjs, written from the history of
// polyness's own verified-push example: fifteen sessions in which twelve verify, add, commit and push). No recorded session
// is used, and the acceptance record says so (reviewer's ruling C6). Written by the implementer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admit, AdmitError } from '@poly/check';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';
import { makeKey, project } from './runtime-helpers.mjs';
import { writeTranscripts } from './fixtures/m7/make-transcripts.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const POLYNESS = process.env.POLY_POLYNESS_DIR ?? join(ROOT, '..', 'polyness');
const poly = (...args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...args], { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; }
};
let tmp; let pin; let n = 0;
before(() => {
  assert.ok(existsSync(join(POLYNESS, 'bin', 'polyness.mjs')), `polyness is expected at ${POLYNESS}`);
  tmp = mkdtempSync(join(tmpdir(), 'poly-ac2-'));
  pin = join(tmp, 'polyness.pin.json');
  assert.equal(poly('propose', '--pin-polyness', '--polyness', POLYNESS, '--polyness-pin', pin).code, 0);
});
after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

/** polyness over synthetic transcripts, then the proposal put into a fresh project as the person would. */
function proposed(variant = 'default') {
  const from = writeTranscripts(join(tmp, `t-${++n}`), variant);
  const out = join(tmp, `proposal-${n}`);
  const r = poly('propose', '--polyness', POLYNESS, '--step', 'git push', '--transcripts', from, '--polyness-pin', pin, '--out', out, '--synthetic');
  assert.equal(r.code, 0, r.out);
  const dir = project(`ac2-${n}`, [], makeKey(`ac2-${n}`));
  copyFileSync(join(out, 'src', 'git_push.poly'), join(dir, 'src', 'git_push.poly'));
  mkdirSync(join(dir, 'proposals'), { recursive: true });
  copyFileSync(join(out, 'proposal.json'), join(dir, 'proposals', 'git-push.json'));
  return { dir, out };
}

test('M7-AC2: the proposal from the verified-push history arrives as poly source and is admitted, and the certificate lists it', async () => {
  const { dir, out } = proposed();
  const r = await admit(dir);
  assert.equal(r.verdict, 'CLEAN');
  const [p] = r.certificate.poly.proposals;
  assert.equal(p.name, 'git-push');
  assert.equal(p.tool.name, 'polyness');
  assert.match(p.evidence, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.parse(readFileSync(join(out, 'proposal.json'), 'utf8')).corpus.kind, 'synthetic', 'the evidence says the corpus was made for the purpose');
  const names = readFileSync(join(dir, 'src', 'git_push.poly'), 'utf8').match(/path property [\w-]+/g);
  assert.equal(names.length, 4, 'four rules arrived as path properties');
});

test('M7-AC2: the careless history (nobody verifies) is admitted too, with no verify rule: the standard is the person\'s own', async () => {
  const { dir } = proposed('careless');
  const r = await admit(dir);
  assert.equal(r.verdict, 'CLEAN');
  assert.ok(!readFileSync(join(dir, 'src', 'git_push.poly'), 'utf8').includes('npm_test'));
});

test('M7-AC2: a rule its own history does not support is refused with its numbers (PL6520), and nothing is admitted', async () => {
  const { dir } = proposed();
  const file = join(dir, 'proposals', 'git-push.json');
  const e = JSON.parse(readFileSync(file, 'utf8'));
  e.rules.find((r) => r.name === 'no-git-push-without-a-passing-verify').support = { holds: 8, of: 16 };
  writeFileSync(file, JSON.stringify(e, null, 2));
  await assert.rejects(admit(dir), (x) => x instanceof AdmitError && /PL6520/.test(x.message) && /no-git-push-without-a-passing-verify/.test(x.message) && /8 of 16/.test(x.message) && /0\.6/.test(x.message));
});

test('M7-AC2: a rule the machine breaks is refused by the ordinary check with a witness (PL4001), evidence or none; a holding rule with no evidence is PL6521', async () => {
  const { dir } = proposed();
  const src = join(dir, 'src', 'git_push.poly');
  const text = readFileSync(src, 'utf8');
  const mark = '  // proposed: at-most-one-git-push-per-run';
  const NL = String.fromCharCode(10);
  writeFileSync(src, text.replace(mark, '  path property contradicted: before("git-push", "git-add")' + NL + mark));
  await assert.rejects(admit(dir), (x) => x instanceof AdmitError && /PL4001/.test(x.message) && /contradicted/.test(x.message), 'the machine breaks it, whatever the evidence');
  const file = join(dir, 'proposals', 'git-push.json');
  const e = JSON.parse(readFileSync(file, 'utf8'));
  e.rules.push({ name: 'contradicted', pattern: 'implies-a-prior', support: { holds: 16, of: 16 }, window: 'run', provenance: 'own' });
  writeFileSync(file, JSON.stringify(e, null, 2));
  await assert.rejects(admit(dir), (x) => x instanceof AdmitError && /PL4001/.test(x.message) && /contradicted/.test(x.message), 'with evidence, the ordinary check still refuses it');
  // The control for PL6521: a rule that holds, with no evidence.
  writeFileSync(src, text.replace(mark, '  path property extra-holding: count("npm-test") <= 1' + NL + mark));
  e.rules.pop();
  writeFileSync(file, JSON.stringify(e, null, 2));
  await assert.rejects(admit(dir), (x) => x instanceof AdmitError && /PL6521/.test(x.message) && /extra-holding/.test(x.message));
});
