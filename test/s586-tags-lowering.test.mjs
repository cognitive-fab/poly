// S586 (PT34.1, PT34.3, PT12.5, PS8.10): tags in the build. RT5 (the toolchain fault catalog-unpinned is caught), RT6
// (the lowered document carries each tagged obligation's tags as PT34.3 writes them and no `tags` field for an untagged
// one; the certificate carries poly.risk), RT7 (policy-tag-dropped and policy-tag-moved are caught by translation
// validation), RT8 (a signature made before the tags is PL6409), RT9 (PS8.10 on poly-ref's decision table). RT9 on a
// replayed journal is in test/s586-report.test.mjs, beside the stores it reads. Written by a separate writer from the
// specification and the catalogs alone, before any code (rule 7a).
//
// Left open by the specification, so not asserted: whether the `.unknown` companion of a tagged rule carries the rule's
// tags (only the obligation named after the item is checked), and whether poly.risk writes a risk as `mit:7.3` or as
// `risk:mit:7.3` (the prefix is set aside before comparing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '@poly/lang';
import { admit, AdmitError, checkFile, checkProject, policySubjects } from '@poly/check';
import { lowerPolicyScope, POLICY_FAULTS } from '@poly/lower';
import { policyFacts, validatePolicy, checkNever, decide } from '@poly/ref';
import { polyaxionPeer, loadPolyaxion, policyEngine } from '@poly/runtime';
import { ROOT } from './helpers.mjs';
import { makeKey, project, signPolicies } from './runtime-helpers.mjs';
import { CATALOG_FAULTS, POLICY_FAULT_SOURCES } from './toolchain-faults.mjs';
import { untag } from './fixtures/s586/risk-desk.mjs';

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const ORDERS_POLICY = read('conformance/m5/orders.policy.poly');
const PINS = JSON.parse(read('std/PINS.json')).files;
const CATALOG_FILES = { mit: 'mit-ai-risk.json', nist: 'nist-ai-rmf.json', iso: 'iso-42001.json' };
const peer = polyaxionPeer();
const skip = peer.ok ? false : `not run: ${peer.reason}`;

// conformance/m5/orders.policy.poly with tags: a machine obligation with a risk and two controls (written out of order),
// a rule with none, a never statement with a risk, and a recalled item with both.
const TAGGED_POLICY = ORDERS_POLICY
  .replace('obligation reserve-before-charge "Charge only after stock has been reserved." machine {', 'obligation reserve-before-charge "Charge only after stock has been reserved."\n    mitigates "mit:7.3"\n    implements "nist:MANAGE-2.4", "iso:A.9.2"\n    machine {')
  .replace('never no-fee-when-cancelled "No irreversible effect is ever allowed for a cancelled order.":', 'never no-fee-when-cancelled "No irreversible effect is ever allowed for a cancelled order." mitigates "mit:6.1":')
  .replace(/\n}\s*$/, '\n  recalled style "Keep the fee notice short." mitigates "mit:3.1" implements "iso:A.6.2.8"\n}\n');
const EXPOSURE = ['mit:2.1', 'mit:7.3'];

function ordersProject(name, policyText, exposure) {
  const dir = project(name, ['conformance/m5/orders.poly'], makeKey(name), 'test-s586-lowering');
  writeFileSync(join(dir, 'src', 'orders.policy.poly'), policyText);
  if (exposure) {
    const pj = join(dir, 'poly.json');
    writeFileSync(pj, JSON.stringify({ ...JSON.parse(readFileSync(pj, 'utf8')), exposure: { risks: exposure } }, null, 2));
  }
  return dir;
}
const documentOf = (dir) => JSON.parse(readFileSync(join(dir, '.poly', 'build', 'policies', 'orders.policy.json'), 'utf8'));
const obligation = (doc, id) => doc.obligations.find((o) => o.id === id);
const bare = (tags) => (tags ?? []).map((t) => String(t).replace(/^(risk|control):/, ''));
const policyReports = (r) => [...(r.policies ?? []), ...(r.files ?? []).flatMap((f) => f.policies ?? [])];
const diagnosticsOf = (r) => [...(r.diagnostics ?? []), ...(r.machines ?? []).flatMap((m) => m.diagnostics ?? []), ...(r.files ?? []).flatMap((f) => [...(f.diagnostics ?? []), ...(f.machines ?? []).flatMap((m) => m.diagnostics ?? [])]), ...policyReports(r).flatMap((p) => p.diagnostics ?? [])];

// ── RT6: tags in the lowered document and poly.risk in the certificate (PT34.3) ─────────────────────────────────

let taggedBuild;
async function admittedTagged() {
  if (taggedBuild) return taggedBuild;
  const dir = ordersProject('s586-tagged-build', TAGGED_POLICY, EXPOSURE);
  await signPolicies(dir);
  const r = await admit(dir);
  taggedBuild = { dir, r };
  return taggedBuild;
}

test('RT6: a tagged obligation carries "tags" in the lowered document, risks first, then controls, each in the formatter\'s order and prefixed risk: or control: (PT34.3)', { skip, timeout: 600_000 }, async () => {
  const { dir } = await admittedTagged();
  const doc = documentOf(dir);
  assert.deepEqual(obligation(doc, 'orders-governance.reserve-before-charge')?.tags, ['risk:mit:7.3', 'control:iso:A.9.2', 'control:nist:MANAGE-2.4'], JSON.stringify(doc.obligations.map((o) => [o.id, o.tags])));
});

test('RT6: an untagged obligation is lowered with no tags field, never tags: [] (PT34.3)', { skip, timeout: 600_000 }, async () => {
  const { dir } = await admittedTagged();
  const o = obligation(documentOf(dir), 'orders-governance.orders-irreversible');
  assert.ok(o, 'the rule is lowered');
  assert.equal(Object.hasOwn(o, 'tags'), false, JSON.stringify(o));
});

test('RT6: the certificate of a project that opts in records poly.risk with its catalogs, its exposure and every item of every scope (PT34.3)', { skip, timeout: 600_000 }, async () => {
  const { r } = await admittedTagged();
  const risk = r.certificate.poly.risk;
  assert.ok(risk, `poly.risk is recorded: ${Object.keys(r.certificate.poly).join(', ')}`);
  // Each catalog as its file says it is, with the digest std/PINS.json pins for it.
  assert.ok(Array.isArray(risk.catalogs) && risk.catalogs.length >= 1, JSON.stringify(risk.catalogs));
  for (const c of risk.catalogs) {
    const file = CATALOG_FILES[c.catalog];
    assert.ok(file, `a known catalog: ${JSON.stringify(c)}`);
    const doc = JSON.parse(read(`std/catalogs/${file}`));
    assert.deepEqual({ catalog: c.catalog, version: c.version, digest: c.digest }, { catalog: doc.catalog, version: doc.version, digest: PINS[`catalogs/${file}`] });
  }
  assert.ok(risk.catalogs.some((c) => c.catalog === 'mit' && c.version === 'Version 4 (2025-12-04)'), 'the MIT catalog, Version 4');
  assert.deepEqual([...risk.exposure].sort(), EXPOSURE);
  assert.deepEqual(Object.keys(risk.items).sort(), ['orders-governance.no-fee-when-cancelled', 'orders-governance.orders-irreversible', 'orders-governance.reserve-before-charge', 'orders-governance.style']);
  const shape = Object.fromEntries(Object.entries(risk.items).map(([id, x]) => [id, { scope: x.scope, kind: x.kind, risks: bare(x.risks), controls: bare(x.controls) }]));
  assert.deepEqual(shape, {
    'orders-governance.reserve-before-charge': { scope: 'orders', kind: 'machine', risks: ['mit:7.3'], controls: ['iso:A.9.2', 'nist:MANAGE-2.4'] },
    'orders-governance.orders-irreversible': { scope: 'orders', kind: 'rule', risks: [], controls: [] },
    'orders-governance.no-fee-when-cancelled': { scope: 'orders', kind: 'never', risks: ['mit:6.1'], controls: [] },
    'orders-governance.style': { scope: 'orders', kind: 'recalled', risks: ['mit:3.1'], controls: ['iso:A.6.2.8'] },
  });
});

// A guard, which holds before S586 is built: a build that does not opt in has no poly.risk, and no obligation of its
// document has a tags field.
test('RT6 guard: a build that does not opt in has no poly.risk, and its obligations no tags field (PT34.3)', { skip, timeout: 600_000 }, async () => {
  const dir = ordersProject('s586-untagged-build', ORDERS_POLICY);
  await signPolicies(dir);
  const r = await admit(dir);
  assert.equal(r.certificate.poly.risk, undefined);
  assert.deepEqual(documentOf(dir).obligations.filter((o) => Object.hasOwn(o, 'tags')).map((o) => o.id), []);
});

// ── RT8: the tags are in the signed subject (PT8.6, PT12.5) ───────────────────────────────────────────────────

test('RT8: a tagged policy whose signature was made before its tags is PL6409 POLICY_NOT_SIGNED, and admitted once signed again (PT8.6, PT12.5)', { skip, timeout: 600_000 }, async () => {
  const dir = ordersProject('s586-signed-before', ORDERS_POLICY);
  await signPolicies(dir);
  const [before] = await policySubjects(dir);
  writeFileSync(join(dir, 'src', 'orders.policy.poly'), TAGGED_POLICY);
  const [after] = await policySubjects(dir);
  assert.ok(after, 'the tagged policy lowers, so its scope has a subject to sign');
  // The tags are in the document the person signs (PT34.3), not only in the source file's digest.
  assert.notEqual(after.parts.document, before.parts.document, 'the lowered document changes with its tags');
  await assert.rejects(admit(dir), (e) => e instanceof AdmitError && /PL6409/.test(e.message), 'the signature made before the tags');
  await signPolicies(dir);
  const r = await admit(dir);
  assert.ok(r.certificate.poly.policies.some((p) => p.scope === 'orders'));
});

// ── RT5: catalog-unpinned (PT34.1) ──────────────────────────────────────────────────────────────────────────

test('RT5: catalog-unpinned is in the explicit list of toolchain faults (PT34.1)', () => {
  assert.deepEqual(CATALOG_FAULTS, ['catalog-unpinned']);
});

test('RT5: a catalog whose digest std/PINS.json does not pin is caught as a toolchain fault, and the id it adds names no risk (PT34.1)', { timeout: 600_000 }, async () => {
  // The broken variant: a copy of std whose MIT catalog holds one entry more than the file its pin names. The tag the
  // extra entry would allow must not be accepted from it.
  const std = mkdtempSync(join(tmpdir(), 'poly-s586-std-'));
  try {
    cpSync(join(ROOT, 'std'), std, { recursive: true });
    const file = join(std, 'catalogs', 'mit-ai-risk.json');
    const mit = JSON.parse(readFileSync(file, 'utf8'));
    mit.entries.push({ id: '7.9', label: 'A subdomain no source lists', parent: '7' });
    mit.entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    writeFileSync(file, JSON.stringify(mit, null, 2) + '\n');
    const policy = TAGGED_POLICY.replace('mitigates "mit:6.1":', 'mitigates "mit:7.9":');
    const pinned = ordersProject('s586-catalog-pinned', policy);
    const good = await checkProject(pinned, { root: pinned });
    assert.deepEqual([...new Set(diagnosticsOf(good).map((d) => d.code))], ['PL6506'], 'with the pinned catalog, mit:7.9 is an unknown tag');
    const dir = ordersProject('s586-catalog-unpinned', policy);
    let bad;
    try { bad = await checkProject(dir, { root: dir, std }); } catch (e) { bad = { verdict: 'ERROR', error: String(e.message) }; }
    const text = JSON.stringify(bad);
    assert.notEqual(bad.verdict, 'CLEAN', 'a catalog that is not pinned is never read as clean');
    assert.ok(/catalog-unpinned|mit-ai-risk\.json/.test(text), `the fault names the catalog: ${text.slice(0, 2000)}`);
  } finally { rmSync(std, { recursive: true, force: true }); }
});

// ── RT7: policy-tag-dropped and policy-tag-moved (PT34.3) ───────────────────────────────────────────────────────

const TAG_FAULTS = ['policy-tag-dropped', 'policy-tag-moved'];
const TAG_SOURCE = 'test/fixtures/s586/policy-tags.poly';

test('RT7: the two tag faults are poly-lower\'s policy faults and are listed in toolchain-faults.mjs with their source (PT34.3)', () => {
  for (const f of TAG_FAULTS) {
    assert.ok(POLICY_FAULTS.includes(f), `${f} is one of poly-lower's POLICY_FAULTS: ${POLICY_FAULTS.join(', ')}`);
    assert.deepEqual(POLICY_FAULT_SOURCES[f], [TAG_SOURCE]);
  }
});

for (const fault of TAG_FAULTS) {
  test(`RT7: ${fault} changes the tags of the lowered document as its name says (PT34.3)`, () => {
    const mod = parse(read(TAG_SOURCE)).module;
    assert.ok(mod, 'the tagged source parses');
    const pols = mod.decls.filter((d) => d.kind === 'Policy');
    const tagsOf = (doc) => Object.fromEntries(doc.obligations.filter((o) => o.tags).map((o) => [o.id, o.tags]));
    const good = tagsOf(lowerPolicyScope('pf', pols, 'test'));
    assert.deepEqual(good, {
      'pf-policy.high-blocks': ['risk:mit:7.3', 'control:nist:MANAGE-2.4'],
      'pf-policy.ping-first': ['risk:mit:2.2', 'risk:mit:6.1', 'control:iso:A.6.2.8'],
    });
    const bad = tagsOf(lowerPolicyScope('pf', pols, 'test', fault));
    const all = (t) => Object.values(t).flat().sort();
    if (fault === 'policy-tag-dropped') assert.ok(all(bad).length < all(good).length, `a tag is missing: ${JSON.stringify(bad)}`);
    else {
      assert.notDeepEqual(bad, good, 'a tag is on another obligation');
      assert.ok(Object.entries(bad).some(([id, tags]) => tags.some((t) => !(good[id] ?? []).includes(t))), `a tag on an obligation whose source does not name it: ${JSON.stringify(bad)}`);
    }
  });

  // The policy-tv stage reads the document back and compares each obligation's tags with its source's. The fault is
  // injected through checkFile's options: PT34.3 does not name the hook, and `policyFault`, after the existing
  // `refFault`, is this writer's name for it.
  test(`RT7: ${fault} is caught by the policy-tv stage with PL2501, and the unbroken lowering is not (PT34.3)`, { skip, timeout: 600_000 }, async () => {
    const root = join(ROOT, '.poly', 'test-s586-lowering', `tv-${fault}`);
    const good = await checkFile(join(ROOT, TAG_SOURCE), { root });
    const goodTv = policyReports(good).find((p) => p.scope === 'pf')?.stages.find((s) => s.stage === 'policy-tv');
    assert.equal(goodTv?.verdict, 'CLEAN', `the unbroken lowering's read-back agrees: ${JSON.stringify(policyReports(good).map((p) => p.stages))}`);
    const bad = await checkFile(join(ROOT, TAG_SOURCE), { root, policyFault: fault });
    const p = policyReports(bad).find((x) => x.scope === 'pf');
    const tv = p?.stages.find((s) => s.stage === 'policy-tv');
    assert.notEqual(tv?.verdict, 'CLEAN', `the read-back catches ${fault}: ${JSON.stringify(p?.stages)}`);
    assert.ok((p?.diagnostics ?? []).some((d) => d.code === 'PL2501'), JSON.stringify(p?.diagnostics));
  });
}

// ── RT9: PS8.10 on poly-ref's decision table ────────────────────────────────────────────────────────────────

/** A decision, a state or a row as JSON, with any tag left out, so only what decides is compared. */
const plain = (v) => JSON.stringify(v, (k, x) => (['tags', 'mitigates', 'implements', 'risks', 'controls'].includes(k) ? undefined : x));

async function tableOf(text) {
  const r = parse(text);
  assert.deepEqual(r.diagnostics.map((d) => `${d.code} ${d.message}`), [], 'the source parses');
  const pols = r.module.decls.filter((d) => d.kind === 'Policy');
  const scope = { scope: pols[0].scope, policies: pols };
  const facts = policyFacts([r.module]);
  const px = await loadPolyaxion();
  const engine = policyEngine(px, px.compileToTriple(lowerPolicyScope(scope.scope, pols, 'test')).plan);
  const rows = [];
  const evaluate = (s, sigma, row) => { const d = decide(s, sigma, row); rows.push(plain([sigma, row, d])); return d; };
  const tv = validatePolicy(scope, facts, engine, { evaluate });
  const never = [];
  const nv = checkNever(scope, facts, () => ({}), { evaluate: (s, sigma, row) => { const d = decide(s, sigma, row); never.push(plain([sigma, row, d])); return d; } });
  return { rows, never, mismatch: tv.mismatch, neverResult: plain(nv) };
}

test('RT9: PS8.10 on the decision table: the tagged and the untagged policies give, for every row, the same outcome, reason and witness, and the same never verdict (PT34.3)', { skip, timeout: 600_000 }, async () => {
  const text = read(TAG_SOURCE);
  assert.notEqual(untag(text), text, 'the untagged variant differs from the source');
  const tagged = await tableOf(text);
  const untagged = await tableOf(untag(text));
  assert.equal(tagged.mismatch, null, 'the tagged lowering agrees with PS8');
  assert.ok(tagged.rows.length > 0, 'rows were decided');
  assert.deepEqual(tagged.rows, untagged.rows);
  assert.deepEqual(tagged.never, untagged.never);
  assert.equal(tagged.neverResult, untagged.neverResult);
});
