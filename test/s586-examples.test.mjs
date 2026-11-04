// S586 (PT34.5, RT14, RT16): the two examples of the risk report. The refunds desk's policy is tagged and its demo copy
// equal; the airline-style desk is new, with at least three tagged obligations and an exposure; each example's kept
// store regenerates its report.md and report.json byte for byte. Written by a separate writer from the specification
// and the catalogs alone, before any code (rule 7a).
//
// PT34.5 keeps "the resulting store, the certificate and the trust file" under docs/examples/risk-report/<example>/,
// with report.md and report.json beside them, and names no file. This test finds them by kind: the one store file
// (`.db`, `.sqlite` or `.sqlite3`), the certificates (`*certificate*.json`), the trust file (`*trust*.json`, mapping
// each key id to a public key file beside it, as poly.json's run.trust does, or to the key itself), and the build the
// certificate certifies (a `build` directory), which `--build` needs and PT34.5 does not list. The report is run from
// the repository's root with each path written from there, since the header prints the store it read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const KEPT = join(ROOT, 'docs', 'examples', 'risk-report');
const EXAMPLES = ['concierge', 'airline-desk'];
const rel = (p) => relative(ROOT, p).split(sep).join('/');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const TAG = /"\s+(mitigates|implements)\s+"/;

/** The obligations of a policy text that carry a mitigates clause, by name. */
const taggedObligations = (text) => [...text.matchAll(/obligation ([a-z0-9-]+) "[^"]*"\s+mitigates\s+"/g)].map((m) => m[1]);

/** The files PT34.5 keeps for an example, found by kind. */
function kept(example) {
  const dir = join(KEPT, example);
  assert.ok(existsSync(dir), `${rel(dir)} exists`);
  const files = readdirSync(dir);
  const stores = files.filter((f) => /\.(db|sqlite|sqlite3)$/.test(f));
  assert.equal(stores.length, 1, `one kept store in ${rel(dir)}: ${files.join(', ')}`);
  const certificates = files.filter((f) => /certificate.*\.json$/.test(f));
  assert.ok(certificates.length >= 1, `a certificate in ${rel(dir)}`);
  const trustFile = files.find((f) => /trust.*\.json$/.test(f));
  assert.ok(trustFile, `a trust file in ${rel(dir)}`);
  assert.ok(existsSync(join(dir, 'build')) && statSync(join(dir, 'build')).isDirectory(), `the build the certificate certifies, in ${rel(dir)}/build`);
  for (const f of ['report.md', 'report.json']) assert.ok(files.includes(f), `${f} in ${rel(dir)}`);
  return { dir, store: join(dir, stores[0]), certificates: certificates.map((c) => join(dir, c)), trust: JSON.parse(readFileSync(join(dir, trustFile), 'utf8')), build: join(dir, 'build') };
}

/** The --trust arguments of a trust file: a key id to a file beside it (`file:` or a bare path), or to the key itself. */
function trustArgs(k, tmp) {
  return Object.entries(k.trust).flatMap(([id, where]) => {
    const v = String(where);
    if (v.includes('BEGIN PUBLIC KEY')) { const f = join(tmp, `${id}.pub.pem`); writeFileSync(f, v); return ['--trust', `${id}=${f}`]; }
    return ['--trust', `${id}=${rel(join(k.dir, v.replace(/^file:/, '')))}`];
  });
}

for (const example of EXAMPLES) {
  test(`RT14: the kept store of ${example} regenerates report.md and report.json byte for byte, and is not changed (PT34.5)`, { timeout: 600_000 }, () => {
    const k = kept(example);
    const tmp = mkdtempSync(join(tmpdir(), 'poly-s586-kept-'));
    try {
      const before = ['', '-wal'].map((x) => (existsSync(`${k.store}${x}`) ? sha(readFileSync(`${k.store}${x}`)) : 'absent')).join(' ');
      for (const [format, file] of [['json', 'report.json'], ['md', 'report.md']]) {
        const out = join(tmp, file);
        const args = ['report', 'risks', '--db', rel(k.store), '--build', rel(k.build), ...k.certificates.flatMap((c) => ['--certificate', rel(c)]), ...trustArgs(k, tmp), '--format', format, '--out', out];
        const r = spawnSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
        assert.ok(existsSync(out), `poly report risks wrote ${file} (exit ${r.status}): ${r.stdout}${r.stderr}`);
        assert.equal(readFileSync(out, 'utf8'), readFileSync(join(k.dir, file), 'utf8'), `${example}/${file} regenerates byte for byte`);
      }
      const after = ['', '-wal'].map((x) => (existsSync(`${k.store}${x}`) ? sha(readFileSync(`${k.store}${x}`)) : 'absent')).join(' ');
      assert.equal(after, before, 'the report writes nothing to the store');
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test(`RT16: every gated run of the kept store of ${example} is matched to its certificate (PT34.4 item 2)`, () => {
    const j = JSON.parse(readFileSync(join(kept(example).dir, 'report.json'), 'utf8'));
    assert.deepEqual([j.unidentified, j.ambiguous], [[], []]);
    assert.ok(j.store.counted > 0, 'runs are counted');
    assert.deepEqual(j.store.notCounted, [], 'every run of a kept store verifies');
  });
}

test('PT34.5: between the two reports, a refusal, an escalation approved, an escalation timed out, a decision on unknown input and an unknown outcome', () => {
  const items = EXAMPLES.flatMap((e) => JSON.parse(readFileSync(join(KEPT, e, 'report.json'), 'utf8')).risks.flatMap((r) => r.items));
  const scopes = EXAMPLES.flatMap((e) => JSON.parse(readFileSync(join(KEPT, e, 'report.json'), 'utf8')).scopes);
  const sum = (k) => items.reduce((n, i) => n + (i.counts?.[k] ?? 0), 0);
  for (const k of ['refused', 'approved', 'timedOut', 'onUnknown']) assert.ok(sum(k) > 0, `${k}: ${sum(k)}`);
  assert.ok([...items, ...scopes].some((x) => (x.unknownOutcomes ?? []).length > 0), 'an unknown outcome');
  // The airline desk carries the rule built to reach its `on unknown` branch at run time.
  const airline = JSON.parse(readFileSync(join(KEPT, 'airline-desk', 'report.json'), 'utf8'));
  assert.ok(airline.risks.flatMap((r) => r.items).some((i) => i.counts?.onUnknown > 0), 'the airline desk decides on unknown input');
});

test('PT34.5: the refunds desk\'s report shows Exposed and not covered', () => {
  const j = JSON.parse(readFileSync(join(KEPT, 'concierge', 'report.json'), 'utf8'));
  assert.ok(j.uncovered.length > 0, JSON.stringify(j.uncovered));
  assert.ok(readFileSync(join(KEPT, 'concierge', 'report.md'), 'utf8').includes('Exposed and not covered'));
});

// ── The examples' sources (PT34.5) ─────────────────────────────────────────────────────────────────────────

test('PT34.5: the concierge\'s policy and its demo copy are equal, and tag their three obligations', () => {
  const example = read('examples/concierge/concierge.policy.poly');
  assert.equal(read('demo/concierge/concierge.policy.poly'), example, 'the copies stay equal');
  assert.deepEqual(taggedObligations(example).sort(), ['customer-decisions', 'large-refund-reviewed', 'staff-decisions']);
});

test('PT34.5: examples/concierge/poly.json declares an exposure with at least one risk no item of the policy names', () => {
  const file = join(ROOT, 'examples', 'concierge', 'poly.json');
  assert.ok(existsSync(file), 'examples/concierge/poly.json');
  const risks = JSON.parse(readFileSync(file, 'utf8')).exposure?.risks ?? [];
  assert.ok(risks.length > 0, 'an exposure');
  const named = [...read('examples/concierge/concierge.policy.poly').matchAll(/mitigates\s+((?:"[^"]*"\s*,\s*)*"[^"]*")/g)].flatMap((m) => [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]));
  assert.ok(risks.some((r) => !named.includes(r)), `a risk no item names: exposure ${risks}, named ${named}`);
});

test('PT34.5: the concierge\'s kept certificate is of the tagged policy, signed again: poly.risk names its three obligations with their risks', () => {
  // Admission refuses a scope whose signature is over another document (PT12.5, RT8), so a certificate whose poly.risk
  // holds the tags certifies a policy signed over them.
  assert.ok(TAG.test(read('examples/concierge/concierge.policy.poly')), 'the policy is tagged');
  const cert = JSON.parse(readFileSync(kept('concierge').certificates[0], 'utf8'));
  const items = cert.poly?.risk?.items ?? {};
  for (const o of ['large-refund-reviewed', 'customer-decisions', 'staff-decisions']) {
    const x = items[`refunds.${o}`];
    assert.ok(x && (x.risks ?? []).length > 0, `refunds.${o} with its risks: ${JSON.stringify(x)}`);
  }
  assert.ok((cert.poly?.policies ?? []).some((p) => p.scope === 'concierge' && p.signature), 'the scope\'s signature is bound');
});

test('PT34.5: examples/airline-desk exists, with a policy of at least three tagged obligations and an exposure', () => {
  const dir = join(ROOT, 'examples', 'airline-desk');
  assert.ok(existsSync(dir), 'examples/airline-desk');
  const policies = readdirSync(dir).filter((f) => f.endsWith('.policy.poly'));
  assert.ok(policies.length >= 1, 'a policy');
  const tagged = policies.flatMap((f) => taggedObligations(readFileSync(join(dir, f), 'utf8')));
  assert.ok(tagged.length >= 3, `three tagged obligations: ${tagged}`);
  const manifest = join(dir, 'poly.json');
  assert.ok(existsSync(manifest), 'examples/airline-desk/poly.json');
  assert.ok((JSON.parse(readFileSync(manifest, 'utf8')).exposure?.risks ?? []).length > 0, 'an exposure');
  // Nothing is copied from the poly-tau2 study: the example's sources name no file of it.
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.poly'))) assert.doesNotMatch(readFileSync(join(dir, f), 'utf8'), /poly-tau2/, f);
});
