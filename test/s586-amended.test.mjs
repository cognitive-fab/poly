// S586 as amended on the owner's rulings (e7f19a8f): RT20 (poly-ref's read-back of poly.risk, and the broken
// certificate drop-risk-item caught at admission), RT21 (a never item's verdict in poly.risk and in the report), RT22
// (an unknown outcome's resolution: the first accepted step after it dispatched from outside with claims, by action
// and seq), RT23 (an escalation on unknown input counted under onUnknown and escalated and followed like any other; a
// refusal on unknown input under onUnknown and refused), RT24 (a run matched by the machine-version form of PT34.4
// item 2 only, and no store path in the report). Written by a separate writer from the amended specification alone,
// before the code that meets it (rule 7a).
//
// The store is the amended desk's (test/fixtures/s586/risk-desk-amended.mjs), beside RT10's, which is unchanged.
// Left open by the text, so asserted loosely and said so where it is: which item drop-risk-item leaves out (the refusal
// must name one of the project's items); whether a resolution's seq is the step's own seq or its ledger event's (either
// is accepted); whether a certificate whose signature no longer holds is still matched against (RT24's tampered copy
// asserts only that its runs are not counted).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { admit, AdmitError, CERTIFICATE_FAULTS } from '@poly/check';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';
import { CERTIFICATE_FAULT_LIST, RISK_CERTIFICATE_FAULTS } from './toolchain-faults.mjs';
import { copyStore, eventsOf } from './fixtures/s586/risk-desk.mjs';
import { RUNS2, STAFF, desk2Project, desk2Scenario } from './fixtures/s586/risk-desk-amended.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const OUT = join(ROOT, '.poly', 'test-s586-report', 'out-amended');
mkdirSync(OUT, { recursive: true });

const poly = (...args) => {
  const r = spawnSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { exit: r.status, stdout: r.stdout, out: `${r.stdout}${r.stderr}` };
};
const reportArgs = (s, { db = s.db, certificates = [s.certificate], extra = [] } = {}) =>
  ['report', 'risks', '--db', db, '--build', s.build, ...certificates.flatMap((c) => ['--certificate', c]), '--trust', `${s.trust.ledger.id}=${s.trust.ledger.file}`, '--trust', `${s.trust.admission.id}=${s.trust.admission.file}`, ...extra];
function reportJson(s, o = {}) {
  const r = poly(...reportArgs(s, { ...o, extra: [...(o.extra ?? []), '--format', 'json'] }));
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* reported below */ }
  assert.ok(json, `poly report risks --format json printed JSON (exit ${r.exit}): ${r.out.slice(0, 3000)}`);
  return json;
}
function reportMd(s, o = {}) {
  const r = poly(...reportArgs(s, { ...o, extra: [...(o.extra ?? []), '--format', 'md'] }));
  assert.ok(r.stdout.trim().length > 0, `poly report risks --format md printed a report (exit ${r.exit}): ${r.out.slice(0, 3000)}`);
  return r.stdout;
}
const riskOf = (j, id) => (j.risks ?? []).find((r) => r.id === id);
const itemOf = (j, risk, item) => riskOf(j, risk)?.items.find((i) => i.id === item);
const scopeOf = (j, scope) => (j.scopes ?? []).find((x) => x.scope === scope);

let built;
const tagged = () => (built ??= desk2Scenario({ tagged: true }));

// ── Guards: what the amended desk's store holds (they pass before the amended code) ─────────────────────────────

test('guard: the amended desk\'s store holds escalations and a refusal on unknown input, two exhausted cases, and a step with claims on one of them', { timeout: 900_000 }, async () => {
  const s = await tagged();
  const vs = eventsOf(s.db, 'verdict').map((e) => ({ ...e.body, run: e.run }));
  const unknownEscalations = vs.filter((v) => v.outcome === 'escalated' && String(v.reason).includes('desk2.refund-while-clerk-works.unknown'));
  assert.deepEqual(unknownEscalations.map((v) => v.run).sort(), [RUNS2.unknownApproved, RUNS2.unknownOpen, RUNS2.unknownTimedOut].sort());
  assert.ok(vs.some((v) => v.run === RUNS2.unknownApproved && v.outcome === 'approved'), 'approved');
  assert.ok(vs.some((v) => v.run === RUNS2.unknownTimedOut && v.reason === 'escalation-timeout'), 'timed out');
  assert.ok(vs.some((v) => v.run === RUNS2.unknownRefused && v.outcome === 'denied' && String(v.reason).includes('desk2.wire-while-clerk-works.unknown')), 'refused on unknown input');
  assert.deepEqual([s.steps[`${RUNS2.resolved}:Note`].stepKind, s.steps[`${RUNS2.unresolved}:Note`].stepKind, s.steps[`${RUNS2.resolved}:Resolve`].stepKind], ['accepted', 'accepted', 'accepted']);
  const v = poly('journal', 'verify', '--db', s.db, '--trust', `${s.trust.ledger.id}=${s.trust.ledger.file}`);
  assert.equal(v.exit, 0, v.out);
});

// ── RT20: the read-back of poly.risk (PT34.3) ─────────────────────────────────────────────────────────────

test('RT20: drop-risk-item is a broken certificate writer of poly admit, listed in toolchain-faults.mjs beside the others (PT34.3)', () => {
  assert.ok(CERTIFICATE_FAULT_LIST.includes('drop-risk-item'));
  assert.deepEqual(RISK_CERTIFICATE_FAULTS, ['drop-risk-item']);
  assert.ok(CERTIFICATE_FAULTS.includes('drop-risk-item'), `poly-check's CERTIFICATE_FAULTS: ${CERTIFICATE_FAULTS.join(', ')}`);
});

test('RT20 guard: the amended desk is admitted, and its poly.risk lists every item of its scope', { timeout: 600_000 }, async () => {
  const { dir } = await desk2Project({ tagged: true, name: 's586-rt20-good' });
  const r = await admit(dir);
  assert.deepEqual(Object.keys(r.certificate.poly.risk?.items ?? {}).sort(), ['desk2.no-ping', 'desk2.no-ping-allowed', 'desk2.refund-while-clerk-works', 'desk2.wire-while-clerk-works']);
});

test('RT20: a certificate whose poly.risk leaves an item out (drop-risk-item) is refused at admission by the read-back, naming the item, and nothing is left behind (PT34.3)', { timeout: 600_000 }, async () => {
  const { dir } = await desk2Project({ tagged: true, name: 's586-rt20-fault' });
  await assert.rejects(admit(dir, { fault: 'drop-risk-item' }), (e) => e instanceof AdmitError && /read-back/.test(e.message) && /desk2\.(no-ping|no-ping-allowed|refund-while-clerk-works|wire-while-clerk-works)\b/.test(e.message), 'refused, naming the item');
  assert.equal(existsSync(join(dir, '.poly', 'certificate.json')), false, 'no certificate is written');
});

// ── RT21: a never item's verdict (PT34.3, PT34.4 item 4) ─────────────────────────────────────────────────

test('RT21: a never item carries its verdict in poly.risk: proved, for a never the rule beside it makes hold (PT34.3)', { timeout: 900_000 }, async () => {
  const s = await tagged();
  const item = s.cert.poly.risk?.items?.['desk2.no-ping-allowed'];
  assert.equal(item?.kind, 'never', JSON.stringify(item));
  assert.equal(item.verdict, 'proved', JSON.stringify(item));
  for (const [id, x] of Object.entries(s.cert.poly.risk.items)) if (x.kind !== 'never') assert.equal(Object.hasOwn(x, 'verdict'), false, `${id} is no never item`);
});

test('RT21: the report shows a never item with the verdict poly.risk records, and no decisions (PT34.4 items 4 and 9)', { timeout: 900_000 }, async () => {
  const s = await tagged();
  const item = itemOf(reportJson(s), 'mit:6.1', 'desk2.no-ping-allowed');
  assert.equal(item?.verdict, 'proved', JSON.stringify(item));
  assert.ok(Object.values(item.counts).every((n) => n === 0), JSON.stringify(item.counts));
  const md = reportMd(s);
  const line = md.split(/\r?\n/).find((l) => l.includes('desk2.no-ping-allowed'));
  assert.ok(line && /\bproved\b/.test(line), `the never item's line shows its verdict: ${line}`);
});

// ── RT22: the resolution of an unknown outcome (PT34.4 item 5) ───────────────────────────────────────────────

test('RT22: an unknown outcome followed by a step dispatched from outside with claims lists that step\'s action and seq as its resolution; one with no such step lists none', { timeout: 900_000 }, async () => {
  const s = await tagged();
  const j = reportJson(s);
  const outcomes = scopeOf(j, 'riskdesk2')?.unknownOutcomes ?? [];
  const resolved = outcomes.find((o) => o.run === RUNS2.resolved);
  const unresolved = outcomes.find((o) => o.run === RUNS2.unresolved);
  assert.ok(resolved && unresolved, `both exhausted cases are listed under their scope: ${JSON.stringify(outcomes)}`);
  // The step after the outcome that carried no claims (Note) is not the resolution; the person's step (Resolve) is.
  const step = s.steps[`${RUNS2.resolved}:Resolve`];
  const ledgerSeq = eventsOf(s.db, 'step').find((e) => e.run === RUNS2.resolved && e.body.action === 'Resolve')?.seq;
  assert.equal(resolved.resolution?.action, 'Resolve', JSON.stringify(resolved));
  assert.ok([step.seq, ledgerSeq].includes(resolved.resolution.seq), `the step's seq (${step.seq}, ledger ${ledgerSeq}): ${JSON.stringify(resolved.resolution)}`);
  assert.deepEqual(Object.keys(resolved.resolution).sort(), ['action', 'seq'], 'never its data or its claims');
  assert.equal(unresolved.resolution ?? null, null, `a step with no claims is no resolution: ${JSON.stringify(unresolved)}`);
  const md = reportMd(s);
  assert.ok(!md.includes(STAFF) && !JSON.stringify(j).includes(STAFF), 'the claims of the step are not printed');
});

// ── RT23: decisions on unknown input (PT34.4 item 4) ────────────────────────────────────────────────────

test('RT23: an escalation on unknown input counts under onUnknown and escalated, and its approval, timeout and open end count like any other', { timeout: 900_000 }, async () => {
  const s = await tagged();
  const j = reportJson(s);
  const refund = itemOf(j, 'mit:7.3', 'desk2.refund-while-clerk-works');
  assert.deepEqual(refund?.counts, { refused: 0, escalated: 3, approved: 1, timedOut: 1, open: 1, onUnknown: 3 }, JSON.stringify(refund));
  assert.deepEqual(refund.approvedBy, [{ keyId: 'key-ops', name: 'ops', count: 1 }]);
  assert.ok(!(j.runtime ?? []).some((x) => x.reason === 'escalation-timeout'), 'the timeout of an item\'s escalation is the item\'s');
  // Followed like any other: the approved intent's exhausted outcome is listed under the item that sent it to a person.
  assert.ok((refund.unknownOutcomes ?? []).some((o) => o.run === RUNS2.unknownApproved), JSON.stringify(refund.unknownOutcomes));
  assert.ok(!(scopeOf(j, 'riskdesk2')?.unknownOutcomes ?? []).some((o) => o.run === RUNS2.unknownApproved), 'not under the scope');
});

test('RT23: a refusal on unknown input counts under onUnknown and refused', { timeout: 900_000 }, async () => {
  const s = await tagged();
  const wire = itemOf(reportJson(s), 'mit:4.3', 'desk2.wire-while-clerk-works');
  assert.deepEqual(wire?.counts, { refused: 1, escalated: 0, approved: 0, timedOut: 0, open: 0, onUnknown: 1 }, JSON.stringify(wire));
});

// ── RT24: the machine-version form, and no store path (PT34.4 items 2, 6, 8, 9) ────────────────────────────────

const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

test('RT24 guard: each step\'s machineVersion is the first twelve hexadecimal digits of its machine\'s certified next.cjs digest (PT34.4 item 2)', { timeout: 900_000 }, async () => {
  const s = await tagged();
  const versions = new Set(Object.entries(s.cert.artefacts).filter(([p]) => p.endsWith('/next.cjs')).map(([, d]) => String(d).replace(/^sha256:/, '').slice(0, 12)));
  // The runs item 2 matches: those with a gate record (an intent's own run, intent:*, is the runtime's OutboxIntent).
  const gated = new Set(eventsOf(s.db, 'verdict').map((e) => e.run));
  const steps = eventsOf(s.db, 'step').filter((e) => gated.has(e.run));
  assert.ok(steps.length > 0);
  for (const e of steps) assert.ok(versions.has(e.body.machineVersion), `${e.run} seq ${e.seq}: ${e.body.machineVersion} in ${[...versions]}`);
});

test('RT24: a certificate whose certified next.cjs digests are another machine\'s matches no run, though its module digests are the same (PT34.4 item 2)', { timeout: 900_000 }, async () => {
  const s = await tagged();
  const cert = JSON.parse(readFileSync(s.certificate, 'utf8'));
  for (const p of Object.keys(cert.artefacts)) if (p.endsWith('/next.cjs')) cert.artefacts[p] = sha(`another ${p}`);
  const other = join(OUT, 'certificate-next-changed.json');
  writeFileSync(other, JSON.stringify(cert, null, 2));
  const j = reportJson(s, { certificates: [other] });
  assert.equal(j.store.counted, 0, 'no run is counted');
  for (const id of [RUNS2.unknownApproved, RUNS2.resolved]) assert.ok(JSON.stringify(j.unidentified).includes(id), `${id} is not identified: ${JSON.stringify(j.unidentified)}`);
});

test('RT24: the report, in both formats, holds no store path, and is the same for the same store at another path (PT34.4 items 6, 8, 9)', { timeout: 900_000 }, async () => {
  const s = await tagged();
  const forms = (p) => { const a = String(p); return [...new Set([a, a.split('\\').join('/'), a.split('/').join('\\'), a.split('\\').join('\\\\'), relative(ROOT, a), relative(ROOT, a).split(sep).join('/')])]; };
  const j = reportJson(s);
  const md = reportMd(s);
  const text = JSON.stringify(j);
  assert.equal(Object.hasOwn(j.store, 'path'), false, `store has no path: ${Object.keys(j.store)}`);
  for (const f of forms(s.db)) {
    assert.ok(!text.includes(f), `the JSON holds the store path ${f}`);
    assert.ok(!md.includes(f), `the Markdown holds the store path ${f}`);
  }
  // The same store at another path, given as a relative path: the same bytes in both formats.
  const dir = join(OUT, 'elsewhere');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const moved = copyStore(s.db, join(dir, 'moved.db'));
  const rel = relative(ROOT, moved).split(sep).join('/');
  assert.equal(poly(...reportArgs(s, { db: rel, extra: ['--format', 'json'] })).stdout, poly(...reportArgs(s, { extra: ['--format', 'json'] })).stdout);
  const mdMoved = poly(...reportArgs(s, { db: rel, extra: ['--format', 'md'] })).stdout;
  assert.equal(mdMoved, md);
  assert.ok(!mdMoved.includes(rel) && !mdMoved.includes('moved.db'), 'no store path in the moved report');
});
