// S463 (PS6.4, PS15.5, PT certificate, ruled 2026-10-10): a rejected completion of the application's own intent is a
// finding in the channel's generated configuration, PL5409 COMPLETION_REJECTED, as a rejected receipt is PL5406. In the
// machine check a completion is an ordinary action (PS4.4), so the failed one is still there after a rejection, and a
// liveness property under fairness checks CLEAN; at run time a rejected completion consumes its intent. A machine's
// liveness therefore assumes that no completion of the program's own intents is rejected: the certificate says so, and
// the finding discharges it.
//
// Written from the specification text (4bb168bc) with the S456 fixtures as the model (test/fixtures/channel-completions).
// The writer's first version had a require that no run could pass and a certificate test that read a string; the
// release session replaced the fixtures and the assertions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@poly/lang';
import { admit, checkFile, resolveUses } from '@poly/check';
import { checkConfiguration } from '@poly/ref';
import { ROOT } from './helpers.mjs';
import { admitted, makeKey, project } from './runtime-helpers.mjs';

const FIX = join(ROOT, 'test', 'fixtures', 'rejected-completion');
const STD = join(FIX, 'std');
const OUT = join(ROOT, '.poly', 'test-rejected-completion');

const all = (r) => [...(r.diagnostics ?? []), ...(r.machines ?? []).flatMap((m) => m.diagnostics ?? []), ...(r.configurations ?? []).flatMap((c) => c.diagnostics ?? [])];
const text = (r) => `${r.verdict} ${r.error ?? ''} ${JSON.stringify(all(r).map((d) => `${d.code} ${d.message}`))}`;
const support = (r) => r.configurations.find((c) => c.configuration === 'support');
const agent = (r) => r.machines.find((m) => m.machine.endsWith('Agent'));

let n = 0;
async function check(file) {
  const d = join(OUT, `case-${n++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'm.poly'), readFileSync(join(FIX, file), 'utf8'));
  return checkFile(join(d, 'm.poly'), { root: d, std: STD });
}

test('S463, PS15.5: a require that rejects the decision\'s ok completion is PL5409 in the configuration, with a witness that ends at the rejected step', { timeout: 300_000 }, async () => {
  const r = await check('require.poly');
  assert.ok(!r.error, text(r));
  const found = support(r).diagnostics.filter((d) => d.code === 'PL5409');
  assert.equal(found.length, 1, `one finding, for the action Answered: ${text(r)}`);
  assert.match(found[0].message, /Answered/, found[0].message);
  assert.match(found[0].message, /unsure/, 'the reason of the rejection');
  const last = found[0].witness.trace.at(-1);
  assert.equal(last.action, 'Answered');
  assert.match(String(last.verdict), /^rejected/);
  assert.ok(found[0].witness.length >= 3, 'the path from the start to the rejected step');
  assert.equal(support(r).verdict, 'FINDINGS', text(r));
  assert.equal(r.verdict, 'FINDINGS', text(r));
});

test('S463, PS15.5: the if variant is CLEAN, with no PL5409', { timeout: 300_000 }, async () => {
  const r = await check('if.poly');
  assert.ok(!r.error, text(r));
  assert.ok(!all(r).some((d) => d.code === 'PL5409'), text(r));
  assert.equal(r.verdict, 'CLEAN', text(r));
});

test('S463, PS6.4, PS15.5: the machine check of the require variant with a liveness property is CLEAN, and the configuration finds the rejected completion that the property assumes away', { timeout: 300_000 }, async () => {
  // The control: the same machine without the require is CLEAN in both.
  const ok = await check('if-live.poly');
  assert.ok(!ok.error, text(ok));
  assert.equal(agent(ok).verdict, 'CLEAN', text(ok));
  assert.equal(ok.verdict, 'CLEAN', text(ok));
  assert.ok(agent(ok).stages.some((s) => s.stage === 'liveness' && s.status === 'ran'), 'the liveness property ran');
  // The require variant: the machine is CLEAN, because the failed completion is still offered after a rejection and
  // fairness takes it (PS4.4); only the configuration, which consumes the intent as the runtime does, reports it.
  const r = await check('require-live.poly');
  assert.ok(!r.error, text(r));
  assert.ok(agent(r).stages.some((s) => s.stage === 'liveness' && s.status === 'ran'), 'the liveness property ran');
  assert.equal(agent(r).verdict, 'CLEAN', `the machine: ${JSON.stringify(agent(r).diagnostics.map((d) => d.code))}`);
  assert.ok(support(r).diagnostics.some((d) => d.code === 'PL5409'), text(r));
  assert.equal(r.verdict, 'FINDINGS', text(r));
});

test('S463, PS15.5: a completion rejected terminal, because the application has ended, is no finding', { timeout: 300_000 }, async () => {
  const r = await check('terminal.poly');
  assert.ok(!r.error, text(r));
  assert.ok(!all(r).some((d) => d.code === 'PL5409'), text(r));
  // Not vacuous: the configuration does reach the completion Answered rejected terminal, on an ended application.
  const src = readFileSync(join(FIX, 'terminal.poly'), 'utf8');
  const file = join(OUT, 'terminal-ref.poly');
  writeFileSync(file, src);
  const mod = parse(src).module;
  const g = checkConfiguration(mod, 'support', { program: resolveUses(mod, file, undefined, STD).program }).graph;
  const hit = g.edges.filter((e) => e.label.action === 'Answered' && e.label.verdict.kind === 'rejected' && e.label.verdict.reason === 'terminal');
  assert.ok(hit.length > 0, 'a completion that reaches the ended application is explored');
});

/** Admits a fixture of this directory, or a path from the root, with the tests' channel kind found in std. */
async function admitFixture(name, source, opts = {}) {
  const key = makeKey(name);
  const dir = project(name, [source], key, 'test-rejected-completion');
  if (opts.credentials) writeFileSync(join(dir, 'poly.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'poly.json'), 'utf8')), credentials: opts.credentials }, null, 2));
  return (await admit(dir, 'std' in opts ? {} : { std: STD })).certificate.poly;
}
const live = (poly) => (poly.assumptions ?? []).filter((x) => x.id === 'liveness-completions');
const bare = (poly) => poly.limits.filter((l) => /liveness/.test(l));

test('S463, certificate: the liveness assumption is discharged when the generated configuration that covers the machine was checked with no PL5409', { timeout: 300_000 }, async () => {
  const poly = await admitFixture('rc-discharged', 'test/fixtures/rejected-completion/if-live.poly');
  assert.deepEqual(live(poly).map((x) => [x.machine, x.status, x.by]), [['rc.Agent', 'discharged', 'rc.support']], JSON.stringify(poly.assumptions));
  assert.match(live(poly)[0].assumption, /no completion of the program's own decisions and effects is rejected/);
  assert.deepEqual(bare(poly), [], 'the assumption is not a bare limit');
});

test('S463, certificate: the assumption is open when no generated configuration covers the machine', { timeout: 300_000 }, async () => {
  const poly = await admitFixture('rc-open', 'test/fixtures/rejected-completion/machine-live.poly');
  assert.deepEqual(live(poly).map((x) => [x.machine, x.status, x.by]), [['ml.Asker', 'open', null]], JSON.stringify(poly.assumptions));
  assert.deepEqual(bare(poly), []);
});

test('S463, certificate: the std machines of a credential carry the assumption, open while no generated configuration covers them', { timeout: 300_000 }, async () => {
  const poly = await admitFixture('rc-grant', 'test/fixtures/m9/stripe-refund.poly', { credentials: { payments: { store: 'kms' } }, std: null });
  const mine = live(poly);
  assert.ok(mine.length > 0, JSON.stringify(poly.assumptions));
  assert.ok(mine.every((x) => x.status === 'open' && x.by === null), JSON.stringify(mine));
  assert.ok(mine.some((x) => /Grant$/.test(x.machine)), JSON.stringify(mine));
  assert.deepEqual(bare(poly), []);
});

test('S463, certificate: a build without a liveness property states no such assumption', { timeout: 300_000 }, async () => {
  const a = await admitted('rc-plain', ['conformance/m1/records.poly']);
  assert.equal(live(a.cert.poly).length, 0, JSON.stringify(a.cert.poly.assumptions));
  assert.deepEqual(bare(a.cert.poly), []);
});
