// S586 as amended on the owner's rulings of 2026-11-05 (1ebb0b7e): RT25 (the report holds no certificate path), RT26
// (a certified never is proved, and the broken certificate never-not-proved is caught by poly-ref's read-back at
// admission), RT27 (the report's exits: 0 over a kept store fully counted, 2 when the certificate its runs need is not
// given or the ledger key is not trusted, and the same exit from the registry's command that serves poly_report_risks).
// Written by a separate writer from the amended specification alone, before the code that meets it (rule 7a).
//
// The kept store is docs/examples/risk-report/airline-desk (PT34.5), read in place and never written: the report writes
// nothing to a store (PT34.4), which test/s586-examples.test.mjs checks byte for byte.
//
// Left open by the text, and how this file reads it:
//   - "when the certificate its runs need is not given": the syntax of PT34.4 makes --certificate required, so the runs'
//     certificate is left out by giving another one, the refunds desk's kept certificate; with no --certificate at all
//     the command is a usage error, which this file does not assert;
//   - "poly_report_risks returns the same exit": the tool's output is the report's JSON (RT17), whose fields (item 9)
//     hold no exit, so the exit is read where the registry returns it, the outcome of the command the tool serves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { admit, AdmitError, CERTIFICATE_FAULTS, COMMANDS } from '@poly/check';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';
import { CERTIFICATE_FAULT_LIST, RISK_CERTIFICATE_FAULTS } from './toolchain-faults.mjs';
import { desk2Project } from './fixtures/s586/risk-desk-amended.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const KEPT = join(ROOT, 'docs', 'examples', 'risk-report', 'airline-desk');
const OTHER_CERTIFICATE = join(ROOT, 'docs', 'examples', 'risk-report', 'concierge', 'certificate.json');
const rel = (p) => relative(ROOT, p).split(sep).join('/');

/** The kept store's paths and keys, absolute or relative to the repository's root. */
function kept({ absolute }) {
  const at = (p) => (absolute ? p : rel(p));
  const trust = JSON.parse(readFileSync(join(KEPT, 'trust.json'), 'utf8'));
  const ids = Object.keys(trust);
  const ledgerId = ids.find((id) => /ledger/.test(id));
  assert.ok(ledgerId, `trust.json names the ledger key: ${ids}`);
  return {
    db: at(join(KEPT, 'store.db')), build: at(join(KEPT, 'build')), certificate: at(join(KEPT, 'certificate.json')),
    trust: Object.fromEntries(ids.map((id) => [id, at(join(KEPT, trust[id]))])), ledgerId,
  };
}
const args = (k, { certificates = [k.certificate], trust = k.trust, format = 'json' } = {}) =>
  ['report', 'risks', '--db', k.db, '--build', k.build, ...certificates.flatMap((c) => ['--certificate', c]), ...Object.entries(trust).flatMap(([id, f]) => ['--trust', `${id}=${f}`]), '--format', format];
function poly(argv, cwd = ROOT) {
  const r = spawnSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...argv], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { exit: r.status, stdout: r.stdout, out: `${r.stdout}${r.stderr}` };
}
/** Every spelling a path takes in printed text and in JSON. */
const forms = (p) => { const a = String(p); return [...new Set([a, a.split('\\').join('/'), a.split('/').join('\\'), a.split('\\').join('\\\\'), rel(a), rel(a).split('/').join('\\')])]; };

// ── RT25: no certificate path (PT34.4 items 6, 8, 9) ──────────────────────────────────────────────────────

test('RT25: the JSON made from the repository\'s root with relative paths and from another directory with absolute paths has the same bytes, and names a certificate by digest and build id only', { timeout: 300_000 }, () => {
  const here = poly(args(kept({ absolute: false })));
  const cwd = mkdtempSync(join(tmpdir(), 'poly-s586-rt25-'));
  try {
    const there = poly(args(kept({ absolute: true })), cwd);
    assert.ok(here.stdout.length > 0, here.out);
    assert.equal(there.stdout, here.stdout, 'the same bytes');
    const j = JSON.parse(here.stdout);
    assert.ok(j.certificates.length > 0, 'the certificate is listed');
    for (const c of j.certificates) {
      assert.equal(Object.hasOwn(c, 'file'), false, `no file: ${JSON.stringify(c)}`);
      assert.ok(c.digest && c.buildId, `named by digest and build id: ${JSON.stringify(c)}`);
    }
    for (const f of forms(join(KEPT, 'certificate.json'))) assert.ok(!here.stdout.includes(f) && !there.stdout.includes(f), `the JSON holds the certificate path ${f}`);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('RT25: the Markdown names no certificate path, from either directory, and has the same bytes', { timeout: 300_000 }, () => {
  const here = poly(args(kept({ absolute: false }), { format: 'md' }));
  const cwd = mkdtempSync(join(tmpdir(), 'poly-s586-rt25-'));
  try {
    const there = poly(args(kept({ absolute: true }), { format: 'md' }), cwd);
    assert.ok(here.stdout.length > 0, here.out);
    assert.equal(there.stdout, here.stdout, 'the same bytes');
    for (const f of forms(join(KEPT, 'certificate.json'))) assert.ok(!here.stdout.includes(f), `the Markdown names the certificate path ${f}`);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

// RT14 regenerates the kept reports with the code under test and compares bytes, so it passes while the code still
// prints a certificate path. This holds the kept reports themselves to RT25, so they are made again once the code drops it.
test('RT25: the kept reports of both examples name no certificate path', () => {
  for (const example of ['airline-desk', 'concierge']) {
    const dir = join(ROOT, 'docs', 'examples', 'risk-report', example);
    const json = readFileSync(join(dir, 'report.json'), 'utf8');
    const md = readFileSync(join(dir, 'report.md'), 'utf8');
    for (const c of JSON.parse(json).certificates) assert.equal(Object.hasOwn(c, 'file'), false, `${example}: ${JSON.stringify(c)}`);
    for (const f of forms(join(dir, 'certificate.json'))) assert.ok(!json.includes(f) && !md.includes(f), `${example}: a kept report names ${f}`);
  }
});

// ── RT26: a certified never is proved (PT34.3) ────────────────────────────────────────────────────────

test('RT26: never-not-proved is a broken certificate writer of poly admit, listed in toolchain-faults.mjs with the risk faults', () => {
  assert.ok(CERTIFICATE_FAULT_LIST.includes('never-not-proved'));
  assert.ok(RISK_CERTIFICATE_FAULTS.includes('never-not-proved'));
  assert.ok(CERTIFICATE_FAULTS.includes('never-not-proved'), `poly-check's CERTIFICATE_FAULTS: ${CERTIFICATE_FAULTS.join(', ')}`);
});

test('RT26: a never item in an admitted certificate has the verdict proved', { timeout: 600_000 }, async () => {
  const { dir } = await desk2Project({ tagged: true, name: 's586-rt26-good' });
  const r = await admit(dir);
  const nevers = Object.entries(r.certificate.poly.risk?.items ?? {}).filter(([, x]) => x.kind === 'never');
  assert.deepEqual(nevers.map(([id, x]) => [id, x.verdict]), [['desk2.no-ping-allowed', 'proved']]);
});

test('RT26: a certificate whose never item\'s verdict is written as vacuous (never-not-proved) is refused at admission by the read-back, naming the item, and nothing is left behind', { timeout: 600_000 }, async () => {
  const { dir } = await desk2Project({ tagged: true, name: 's586-rt26-fault' });
  await assert.rejects(admit(dir, { fault: 'never-not-proved' }), (e) => e instanceof AdmitError && /read-back/.test(e.message) && /desk2\.no-ping-allowed/.test(e.message), 'refused, naming the never item');
  assert.throws(() => readFileSync(join(dir, '.poly', 'certificate.json')), 'no certificate is written');
});

// ── RT27: the exits (PT34.4) ──────────────────────────────────────────────────────────────────────────

test('RT27: over the kept store with its certificate and both keys trusted, poly report risks exits 0 (CLEAN), every gated run counted', { timeout: 300_000 }, () => {
  const r = poly(args(kept({ absolute: false })));
  assert.equal(r.exit, 0, r.out.slice(0, 2000));
  const j = JSON.parse(r.stdout);
  assert.deepEqual([j.store.notCounted, j.unidentified, j.ambiguous], [[], [], []]);
});

test('RT27: it exits 2 (INCONCLUSIVE) when the certificate its runs need is not given', { timeout: 300_000 }, () => {
  const k = kept({ absolute: false });
  const r = poly(args(k, { certificates: [rel(OTHER_CERTIFICATE)] }));
  assert.equal(r.exit, 2, r.out.slice(0, 2000));
  assert.ok(JSON.parse(r.stdout).unidentified.length > 0, 'its runs are not identified');
});

test('RT27: it exits 2 (INCONCLUSIVE) when the ledger key is not trusted', { timeout: 300_000 }, () => {
  const k = kept({ absolute: false });
  const trust = Object.fromEntries(Object.entries(k.trust).filter(([id]) => id !== k.ledgerId));
  const r = poly(args(k, { trust }));
  assert.equal(r.exit, 2, r.out.slice(0, 2000));
  assert.ok(JSON.parse(r.stdout).store.notCounted.length > 0, 'its runs do not verify');
});

test('RT27: the command poly_report_risks serves returns the same exit in each of the three cases', { timeout: 300_000 }, async () => {
  const cmd = COMMANDS.find((c) => c.mcp === 'poly_report_risks');
  assert.ok(cmd, 'the registry serves poly_report_risks');
  const k = kept({ absolute: true });
  const trust = (t) => Object.entries(t).map(([id, f]) => `${id}=${f}`);
  const cases = [
    [{ certificate: [k.certificate], trust: trust(k.trust) }, 0],
    [{ certificate: [OTHER_CERTIFICATE], trust: trust(k.trust) }, 2],
    [{ certificate: [k.certificate], trust: trust(Object.fromEntries(Object.entries(k.trust).filter(([id]) => id !== k.ledgerId))) }, 2],
  ];
  for (const [input, exit] of cases) {
    const o = await cmd.run({ db: k.db, build: k.build, format: 'json', ...input });
    assert.equal(o.exit, exit, JSON.stringify(input));
  }
});
