// S586 (PT34.4, PS8.10, PT9.7 rule 2): `poly report risks` and `poly_report_risks`. RT9 on a replayed journal, RT10 (each
// row of PT34.4's table counted from a journal built to contain it), RT11 (what is listed and not counted, and what is
// neither), RT12 (the wording, the four words, no private value), RT13 (the same bytes twice; --period by UTC day),
// RT16 (the policy set computed from the certificate is the recorded one), RT17 (the MCP tool returns the CLI's JSON),
// RT18 (escalate-once counted as an escalation by the runtime), RT19 (the MIT attribution). Written by a separate writer
// from the specification and the catalogs alone, before any code (rule 7a).
//
// The stores are built by test/fixtures/s586/risk-desk.mjs through the runtime, on a store file with a ledger signer,
// signed heads and an anchor, so `poly journal verify` vouches for each run. Each scenario runs tagged or untagged; the
// untagged run, which this tree can admit before S586 is built, is the guard that the store holds what is counted.
//
// Left open by the specification, so not asserted, or asserted loosely and said so where it is:
//   - `--trust <keyId>=<file:pub>` (PT34.4) against `--trust <keyId>=<file>` (PT14): a plain path is passed, once for the
//     ledger key and once for the admission key, since the report verifies the journal as `poly journal verify` does and
//     names each certificate's signer;
//   - the shape of an entry of `notCounted`, `unidentified`, `ambiguous`, `untagged`, `uncovered` and `unknownOutcomes`:
//     an entry is found by the run, item or risk id its JSON holds;
//   - whether a risk id is written `mit:7.3` or `risk:mit:7.3`: the prefix is set aside;
//   - the exit code of the report, which PT34.4 does not state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { admit } from '@poly/check';
import { ACCEPT_TEST_ANCHORS, ROOT } from './helpers.mjs';
import { mcpClient } from './mcp-client.mjs';
import {
  CANARIES, DAY1, DAY2, RUNS, copyStore, deskScenario, escalateOnceScenario, eventsOf, runsOf,
} from './fixtures/s586/risk-desk.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const OUT = join(ROOT, '.poly', 'test-s586-report', 'out');
mkdirSync(OUT, { recursive: true });
const MEANING = 'These counts are evidence that each rule was applied to the decisions recorded in the journal. They are not proof that a risk was removed or reduced.';
const ATTRIBUTION = 'Risk domains and subdomains: MIT AI Risk Repository, Domain Taxonomy, Version 4 (2025-12-04), airisk.mit.edu, licensed under CC BY 4.0.';
const PREFIX = join(ROOT, 'test', 'fixtures', 's586', 'prefix-escalate-once');

const poly = (...args) => {
  const r = spawnSync(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { exit: r.status, stdout: r.stdout, out: `${r.stdout}${r.stderr}` };
};
const trustArgs = (s) => ['--trust', `${s.trust.ledger.id}=${s.trust.ledger.file}`, '--trust', `${s.trust.admission.id}=${s.trust.admission.file}`];
const reportArgs = (s, { db = s.db, certificates = [s.certificate], trust = trustArgs(s), extra = [] } = {}) =>
  ['report', 'risks', '--db', db, '--build', s.build, ...certificates.flatMap((c) => ['--certificate', c]), ...trust, ...extra];

/** `poly report risks --format json`, parsed. */
function reportJson(s, o = {}) {
  const r = poly(...reportArgs(s, { ...o, extra: [...(o.extra ?? []), '--format', 'json'] }));
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* reported below */ }
  assert.ok(json, `poly report risks --format json printed JSON (exit ${r.exit}): ${r.out.slice(0, 3000)}`);
  return json;
}
/** `poly report risks --format md`, as printed. */
function reportMd(s, o = {}) {
  const r = poly(...reportArgs(s, { ...o, extra: [...(o.extra ?? []), '--format', 'md'] }));
  assert.ok(r.stdout.trim().length > 0, `poly report risks --format md printed a report (exit ${r.exit}): ${r.out.slice(0, 3000)}`);
  return r.stdout;
}

const bare = (id) => String(id).replace(/^(risk|control):/, '');
const riskOf = (j, id) => (j.risks ?? []).find((r) => bare(r.id) === id);
const itemOf = (j, risk, item) => riskOf(j, risk)?.items.find((i) => i.id === item);
const holds = (list, id) => JSON.stringify(list ?? []).includes(JSON.stringify(id).slice(1, -1));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const storeBytes = (db) => ['', '-wal'].map((x) => (existsSync(`${db}${x}`) ? sha(readFileSync(`${db}${x}`)) : 'absent')).join(' ');

// ── The stores, built once per process ──────────────────────────────────────────────────────────────────────

const memo = {};
const once = (k, f) => (memo[k] ??= f());
const taggedDesk = () => once('tagged', () => deskScenario({ tagged: true }));
const untaggedDesk = () => once('untagged', () => deskScenario({ tagged: false }));
const taggedOnce = () => once('onceTagged', () => escalateOnceScenario({ tagged: true }));
const untaggedOnce = () => once('onceUntagged', () => escalateOnceScenario({ tagged: false }));

/** The kept store of finding 34's run recorded by the runtime of v1.5.1 (record-prefix-store.mjs). */
function prefixStore() {
  const trust = JSON.parse(readFileSync(join(PREFIX, 'trust.json'), 'utf8'));
  const [ledgerId, admissionId] = Object.keys(trust);
  // The kept store is copied out first, so the test never writes into the fixture.
  const dir = join(OUT, 'prefix');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const db = copyStore(join(PREFIX, 'store.db'), join(dir, 'store.db'));
  return { db, build: join(PREFIX, 'build'), certificate: join(PREFIX, 'certificate.json'), trust: { ledger: { id: ledgerId, file: join(PREFIX, trust[ledgerId]) }, admission: { id: admissionId, file: join(PREFIX, trust[admissionId]) } } };
}

const verdicts = (db) => eventsOf(db, 'verdict').map((e) => ({ ...e.body, run: e.run, eventAt: e.at }));
const ofRun = (vs, run) => vs.filter((v) => v.run === run);

// ── Guards: what the stores hold, read straight from the ledger (they pass before S586 is built) ──────────────

test('guard: the untagged desk store holds every row of PT34.4\'s table, and journal verify vouches for every run', { timeout: 900_000 }, async () => {
  const s = await untaggedDesk();
  const vs = verdicts(s.db);
  const outcomes = (run) => ofRun(vs, run).map((v) => v.outcome);
  const reasons = (run) => ofRun(vs, run).map((v) => String(v.reason ?? ''));
  assert.ok(outcomes(RUNS.refused).includes('denied') && reasons(RUNS.refused).some((r) => r.includes('desk.no-wire')), `refused by an item: ${JSON.stringify(ofRun(vs, RUNS.refused))}`);
  assert.ok(reasons(RUNS.untaggedRefused).some((r) => r.includes('desk.no-ping')), 'refused by the item that names no risk');
  assert.ok(reasons(RUNS.unknown).some((r) => r.includes('desk.mail-while-clerk-works.unknown')), `decided on unknown input: ${JSON.stringify(ofRun(vs, RUNS.unknown))}`);
  assert.ok(outcomes(RUNS.allowed).includes('allowed'), 'allowed');
  for (const id of [RUNS.approved, RUNS.approvedExhausted]) {
    assert.ok(outcomes(id).includes('escalated') && reasons(id).some((r) => r.includes('desk.refund-reviewed')), `${id} sent to a person: ${JSON.stringify(ofRun(vs, id))}`);
    assert.ok(outcomes(id).includes('approved'), `${id} approved`);
  }
  assert.ok(reasons(RUNS.timedOut).includes('escalation-timeout'), `timed out: ${JSON.stringify(ofRun(vs, RUNS.timedOut))}`);
  assert.deepEqual(outcomes(RUNS.open), ['escalated'], 'left open');
  assert.ok(ofRun(vs, RUNS.stale).some((v) => v.outcome === 'denied' && v.reason === 'stale-allow'), `refused by the runtime: ${JSON.stringify(ofRun(vs, RUNS.stale))}`);
  assert.deepEqual(ofRun(vs, RUNS.noGate), [], 'no gate record');
  assert.ok(runsOf(s.db).includes(RUNS.noGate), 'the run with no gate record has a chain');
  assert.deepEqual(s.exhausted, { [RUNS.exhausted]: true, [RUNS.approvedExhausted]: true }, 'the exhausted completions');
  // The policy set is recorded on the gate's own decisions (allowed, escalated, denied by a rule), not on a settle or an
  // approval; every recorded one is the same.
  const sets = vs.filter((v) => Object.hasOwn(v, 'policySet')).map((v) => v.policySet);
  assert.ok(sets.length > 0 && vs.filter((v) => v.outcome === 'allowed').every((v) => typeof v.policySet === 'string'), 'the gate records name their policy set');
  assert.equal(new Set(sets).size, 1, 'one policy set');
  const days = new Set(vs.map((v) => new Date(v.eventAt ?? 0).toISOString().slice(0, 10)));
  assert.ok(days.has(DAY1) && days.has(DAY2), `events on both days: ${[...days]}`);
  const v = poly('journal', 'verify', '--db', s.db, '--trust', `${s.trust.ledger.id}=${s.trust.ledger.file}`);
  assert.equal(v.exit, 0, v.out);
});

test('guard: the untagged escalate-once store holds a denial escalate-once with gateDecision "escalate" and escalatedBy "stale-items" (PT9.7 rule 2)', { timeout: 900_000 }, async () => {
  const s = await untaggedOnce();
  const denied = verdicts(s.db).find((v) => v.outcome === 'denied');
  assert.deepEqual([denied?.reason, denied?.gateDecision, denied?.escalatedBy], ['escalate-once', 'escalate', 'stale-items'], JSON.stringify(denied));
  const v = poly('journal', 'verify', '--db', s.db, '--trust', `${s.trust.ledger.id}=${s.trust.ledger.file}`);
  assert.equal(v.exit, 0, v.out);
});

test('guard: the kept store of v1.5.1 holds a denial escalate-once with no escalatedBy, and verifies', () => {
  const s = prefixStore();
  const denied = verdicts(s.db).find((v) => v.outcome === 'denied');
  assert.equal(denied?.reason, 'escalate-once', JSON.stringify(denied));
  assert.equal(denied.escalatedBy, undefined, 'recorded before finding 34\'s fix');
  const v = poly('journal', 'verify', '--db', s.db, '--trust', `${s.trust.ledger.id}=${s.trust.ledger.file}`);
  assert.equal(v.exit, 0, v.out);
});

// ── RT9: PS8.10 on a replayed journal ──────────────────────────────────────────────────────────────────────

test('RT9: PS8.10 on the journal: the tagged desk makes the same decisions as the untagged one, and its sessions replay with no divergence', { timeout: 900_000 }, async () => {
  const u = await untaggedDesk();
  const t = await taggedDesk();
  const key = (v) => [v.run, v.effectKind, v.outcome, String(v.reason ?? ''), v.sseq ?? null, v.eventAt ?? null];
  assert.deepEqual(verdicts(t.db).map(key), verdicts(u.db).map(key));
  const r = poly('journal', 'replay', '--db', t.db, '--build', t.build, '--certificate', t.certificate, '--trust', `${t.trust.admission.id}=${t.trust.admission.file}`);
  assert.doesNotMatch(r.out, /PL9001/, r.out);
});

// ── RT10: what is counted (PT34.4 item 4) ───────────────────────────────────────────────────────────────────

test('RT10: each row of PT34.4\'s table is counted from the journal: refused, sent to a person and how it ended, on unknown input, allowed per scope, refused by the runtime', { timeout: 900_000 }, async () => {
  const s = await taggedDesk();
  const j = reportJson(s);
  // Refused: the wire is refused once, and credited to one item only, though two items would refuse it.
  const noWire = itemOf(j, 'mit:2.1', 'desk.no-wire');
  const checked = itemOf(j, 'mit:4.3', 'desk.wire-checked');
  assert.ok(noWire && checked, `both wire items are reported: ${JSON.stringify(j.risks?.map((r) => [r.id, r.items.map((i) => i.id)]))}`);
  assert.equal(noWire.counts.refused + checked.counts.refused, 1, 'one item per refusal');
  // Sent to a person: four refunds, two approved, one timed out, one open at the end of the period.
  const refund = itemOf(j, 'mit:7.3', 'desk.refund-reviewed');
  assert.deepEqual(refund?.counts, { refused: 0, escalated: 4, approved: 2, timedOut: 1, open: 1, onUnknown: 0 });
  assert.ok(holds(refund.controls, 'iso:A.9.2'), JSON.stringify(refund.controls));
  // On unknown input.
  assert.equal(itemOf(j, 'mit:3.1', 'desk.mail-while-clerk-works')?.counts.onUnknown, 1);
  // A recalled item is reported as declared, with no decisions.
  const tone = itemOf(j, 'mit:3.1', 'desk.tone');
  assert.equal(tone?.kind, 'recalled');
  assert.ok(Object.values(tone.counts ?? {}).every((n) => n === 0), JSON.stringify(tone));
  // Allows are counted per scope, never for an item: the scope's count is the journal's allowed events.
  const allowed = verdicts(s.db).filter((v) => v.outcome === 'allowed').length;
  assert.ok(allowed >= 2, `the journal holds allows: ${allowed}`);
  assert.deepEqual((j.scopes ?? []).map((x) => [x.scope, x.allowed]), [['riskdesk', allowed]]);
  for (const r of j.risks) for (const i of r.items) assert.ok(!Object.hasOwn(i.counts ?? {}, 'allowed'), `no allow is counted for ${i.id}`);
  // Refused by the runtime, with no rule and no risk: the third stale allow. The timeout of an item's escalation is
  // counted under the item only.
  assert.ok((j.runtime ?? []).some((x) => x.kind === 'refused' && x.reason === 'stale-allow' && x.count === 1), JSON.stringify(j.runtime));
  assert.ok(!(j.runtime ?? []).some((x) => x.reason === 'escalation-timeout'), 'the timeout of an item\'s escalation is the item\'s');
  assert.ok(!(j.runtime ?? []).some((x) => /desk\./.test(String(x.reason))), 'a refusal by an item is not the runtime\'s');
  // The exposure no item names, and the item that names no risk.
  assert.deepEqual((j.uncovered ?? []).map((x) => bare(typeof x === 'string' ? x : x.id ?? x.risk)), ['mit:6.1']);
  assert.ok(holds(j.untagged, 'desk.no-ping'), JSON.stringify(j.untagged));
});

test('RT10: the unknown outcomes are listed under the item that sent their intent to a person, or under the scope that allowed it (PT34.4 item 5)', { timeout: 900_000 }, async () => {
  const s = await taggedDesk();
  const j = reportJson(s);
  const refund = itemOf(j, 'mit:7.3', 'desk.refund-reviewed');
  assert.equal(refund?.unknownOutcomes?.length, 1, JSON.stringify(refund?.unknownOutcomes));
  assert.ok(JSON.stringify(refund.unknownOutcomes).includes('desk.refund'), 'by effect kind');
  const scope = (j.scopes ?? []).find((x) => x.scope === 'riskdesk');
  assert.equal(scope?.unknownOutcomes?.length, 1, JSON.stringify(scope?.unknownOutcomes));
  assert.ok(JSON.stringify(scope.unknownOutcomes).includes('desk.note'), 'by effect kind');
});

test('RT10: the JSON has the fields of PT34.4 item 9', { timeout: 900_000 }, async () => {
  const j = reportJson(await taggedDesk());
  assert.equal(j.v, 1);
  for (const k of ['meaning', 'attribution', 'period', 'store', 'certificates', 'catalogs', 'risks', 'scopes', 'runtime', 'uncovered', 'untagged', 'unidentified', 'ambiguous']) assert.ok(Object.hasOwn(j, k), `${k} in ${Object.keys(j)}`);
  for (const k of ['runs', 'counted', 'notCounted']) assert.ok(Object.hasOwn(j.store, k), `store.${k}`);
  for (const r of j.risks) {
    for (const k of ['id', 'label', 'items']) assert.ok(Object.hasOwn(r, k), `risk ${r.id}: ${k}`);
    for (const i of r.items) for (const k of ['id', 'kind', 'controls', 'signer', 'sequence', 'counts', 'unknownOutcomes']) assert.ok(Object.hasOwn(i, k), `item ${i.id}: ${k}`);
  }
  // The risks are sorted by id, and labelled from the MIT catalog.
  assert.deepEqual(j.risks.map((r) => r.id), [...j.risks.map((r) => r.id)].sort());
  const mit = JSON.parse(readFileSync(join(ROOT, 'std', 'catalogs', 'mit-ai-risk.json'), 'utf8')).entries;
  assert.equal(riskOf(j, 'mit:7.3').label, mit.find((e) => e.id === '7.3').label);
});

// ── RT11: listed and not counted; neither counted nor listed ───────────────────────────────────────────────────

test('RT11: a run that does not verify is listed under Runs not counted with its problem, and not counted', { timeout: 900_000 }, async () => {
  const s = await taggedDesk();
  const db = copyStore(s.db, join(OUT, 'tampered.db'));
  const sql = new DatabaseSync(db);
  const row = sql.prepare('SELECT seq, event FROM poly_ledger WHERE run = ? AND kind = ? ORDER BY seq LIMIT 1').get(RUNS.refused, 'verdict');
  const e = JSON.parse(row.event);
  e.body.reason = 'changed';
  sql.prepare('UPDATE poly_ledger SET event = ? WHERE run = ? AND seq = ?').run(JSON.stringify(e), RUNS.refused, row.seq);
  sql.close();
  const j = reportJson(s, { db });
  assert.ok(holds(j.store.notCounted, RUNS.refused), JSON.stringify(j.store.notCounted));
  assert.equal(itemOf(j, 'mit:2.1', 'desk.no-wire').counts.refused + itemOf(j, 'mit:4.3', 'desk.wire-checked').counts.refused, 0, 'its refusal is not counted');
  assert.equal(itemOf(j, 'mit:7.3', 'desk.refund-reviewed').counts.escalated, 4, 'the other runs are');
});

test('RT11: without --trust no run verifies, nothing is counted, and the header says so', { timeout: 900_000 }, async () => {
  const s = await taggedDesk();
  const j = reportJson(s, { trust: [] });
  assert.equal(j.store.counted, 0);
  assert.ok(j.risks.every((r) => r.items.every((i) => Object.values(i.counts).every((n) => n === 0))), 'nothing is counted silently');
  const md = reportMd(s, { trust: [] });
  const header = md.split('\n## ')[0];
  assert.match(header, /trust/i, 'the header says that no key was trusted');
});

test('RT11: runs that match no certificate are listed under Certificate not identified, and not counted', { timeout: 900_000 }, async () => {
  const s = await taggedDesk();
  const u = await untaggedDesk();
  // The untagged certificate certifies the same modules, and another policy set: the tags are in its documents.
  const j = reportJson(s, { certificates: [u.certificate] });
  assert.equal(j.store.counted, 0);
  for (const id of [RUNS.refused, RUNS.approved, RUNS.stale]) assert.ok(holds(j.unidentified, id), `${id} is not identified: ${JSON.stringify(j.unidentified)}`);
  const md = reportMd(s, { certificates: [u.certificate] });
  assert.ok(md.includes('Certificate not identified'), 'its section is printed when not empty');
});

test('RT11: given both certificates, each run is matched to the one whose policy set it recorded, and counted', { timeout: 900_000 }, async () => {
  const s = await taggedDesk();
  const u = await untaggedDesk();
  const j = reportJson(s, { certificates: [u.certificate, s.certificate] });
  assert.deepEqual([j.unidentified, j.ambiguous], [[], []]);
  assert.equal(itemOf(j, 'mit:7.3', 'desk.refund-reviewed').counts.escalated, 4);
});

test('RT11: runs that match two certificates are listed under Certificate ambiguous, and not counted', { timeout: 900_000 }, async () => {
  const s = await taggedDesk();
  // The same project admitted again from a copy: the same modules and policy documents, so the same policy set, and
  // another certificate. The copy keeps the desk's own build untouched for the other tests.
  const copy = join(OUT, 'again');
  rmSync(copy, { recursive: true, force: true });
  cpSync(s.dir, copy, { recursive: true, filter: (f) => !/store\.db/.test(f) });
  const r = await admit(copy);
  const second = join(OUT, 'certificate-again.json');
  copyFileSync(r.certificatePath, second);
  // Measured on this tree: the second admission has the same buildId and module digests, and another certificate digest.
  assert.notEqual(r.certificate.digest, s.cert.digest, 'a second certificate');
  const j = reportJson(s, { certificates: [s.certificate, second] });
  assert.equal(j.store.counted, 0);
  for (const id of [RUNS.refused, RUNS.approved]) assert.ok(holds(j.ambiguous, id), `${id} is ambiguous: ${JSON.stringify(j.ambiguous)}`);
  assert.ok(reportMd(s, { certificates: [s.certificate, second] }).includes('Certificate ambiguous'));
});

test('RT11: a runtime:* run and a run with no gate record are neither counted nor listed, with two certificates given as with one', { timeout: 900_000 }, async () => {
  // No tag is needed here: the untagged desk, with its own certificate alone and beside another project's.
  const s = await untaggedDesk();
  const other = await untaggedOnce();
  const runtimeRuns = runsOf(s.db).filter((r) => r.startsWith('runtime:'));
  for (const certificates of [[s.certificate], [s.certificate, other.certificate]]) {
    const j = reportJson(s, { certificates });
    const listed = JSON.stringify([j.store.notCounted, j.unidentified, j.ambiguous]);
    assert.ok(!listed.includes(RUNS.noGate), `${RUNS.noGate} is not listed: ${listed}`);
    assert.ok(!listed.includes('runtime:'), `no runtime run is listed: ${listed}`);
    for (const r of runtimeRuns) assert.ok(!listed.includes(r), r);
  }
  // Counted: every run with a step and a gate record, and no other.
  const j = reportJson(s);
  const gated = new Set(verdicts(s.db).map((v) => v.run));
  assert.equal(j.store.counted, [...gated].filter((r) => !r.startsWith('runtime:')).length);
});

// ── RT12: the wording, the four words, and no private value ─────────────────────────────────────────────────

test('RT12: the first line after the Markdown\'s title and the JSON\'s meaning are the sentence of PT34.4 item 6', { timeout: 900_000 }, async () => {
  const s = await taggedDesk();
  assert.equal(reportJson(s).meaning, MEANING);
  const lines = reportMd(s).split(/\r?\n/);
  const title = lines.findIndex((l) => /^# /.test(l));
  assert.ok(title >= 0, 'a title');
  const first = lines.slice(title + 1).find((l) => l.trim() !== '');
  // The specification prints the sentence in italics; the emphasis marks, if the Markdown writes them, are set aside.
  assert.equal(first.trim().replace(/^[*_]+|[*_]+$/g, ''), MEANING);
});

test('RT12: the report never prints mitigated, covered, safe or compliant beside a count', { timeout: 900_000 }, async () => {
  const s = await taggedDesk();
  const md = reportMd(s);
  // Beside a count: in any line of the Markdown that holds a count, a table cell or a line that is a number alone.
  const rows = md.split(/\r?\n/).filter((l) => l.split('|').map((c) => c.trim()).some((c) => /^\d+$/.test(c)));
  assert.ok(rows.length > 0, 'the report has rows of counts');
  for (const line of rows) assert.doesNotMatch(line, /\b(mitigated|covered|safe|compliant)\b/i, line);
  const j = reportJson(s);
  const keys = JSON.stringify([j.risks.flatMap((r) => r.items.map((i) => Object.keys(i.counts))), j.scopes.map((x) => Object.keys(x)), j.runtime.map((x) => Object.keys(x))]);
  assert.doesNotMatch(keys, /\b(mitigated|covered|safe|compliant)\b/i);
  for (const r of j.risks) assert.doesNotMatch(JSON.stringify(r.items.map((i) => i.counts)), /mitigated|covered|safe|compliant/i);
});

test('RT12: the report prints no value the journal keeps as a digest or in its content store (PT34.4 item 7)', { timeout: 900_000 }, async () => {
  const s = await taggedOnce();
  const md = reportMd(s);
  const json = JSON.stringify(reportJson(s));
  for (const [what, canary] of Object.entries(CANARIES)) {
    assert.ok(!md.includes(canary), `the Markdown prints the ${what}`);
    assert.ok(!json.includes(canary), `the JSON holds the ${what}`);
  }
  // The control: the store does hold the question, in its content store, so its absence from the report is the report's.
  const bytes = Buffer.concat(['', '-wal'].filter((x) => existsSync(`${s.db}${x}`)).map((x) => readFileSync(`${s.db}${x}`)));
  assert.ok(bytes.includes(Buffer.from(CANARIES.question)), 'the question is in the store');
});

test('RT12: the Markdown\'s sections come in the order PT34.4 item 6 gives, the risks sorted by id', { timeout: 900_000 }, async () => {
  const md = reportMd(await taggedDesk());
  const at = (h) => md.indexOf(h);
  const order = ['Allowed in each scope', 'Refused by the runtime (no rule)', 'Escalated by the runtime (no rule)', 'Exposed and not covered', 'Rules that name no risk', 'Runs not counted', 'How the counts are made'];
  for (const h of order) assert.ok(at(h) >= 0, `the section ${h}`);
  for (let i = 1; i < order.length; i++) assert.ok(at(order[i - 1]) < at(order[i]), `${order[i - 1]} before ${order[i]}`);
  const risks = ['mit:2.1', 'mit:3.1', 'mit:4.3', 'mit:7.3'];
  for (let i = 1; i < risks.length; i++) assert.ok(at(risks[i - 1]) < at(risks[i]) && at(risks[i]) < at('Allowed in each scope'), `${risks[i - 1]} before ${risks[i]}`);
  // How the counts are made says that allows are per scope and a refusal is counted for one item.
  const how = md.slice(at('How the counts are made'));
  assert.match(how, /scope/i);
  assert.match(how, /one item|first item|one rule/i);
});

// ── RT13: the same bytes, and the period ───────────────────────────────────────────────────────────────────

test('RT13: the same store and arguments give the same bytes twice, in both formats, and the report writes nothing to the store', { timeout: 900_000 }, async () => {
  const s = await taggedDesk();
  const before = storeBytes(s.db);
  for (const format of ['json', 'md']) {
    const a = poly(...reportArgs(s, { extra: ['--format', format] }));
    const b = poly(...reportArgs(s, { extra: ['--format', format] }));
    assert.ok(a.stdout.length > 0, a.out);
    assert.equal(a.stdout, b.stdout, format);
    const file = join(OUT, `report.${format}`);
    rmSync(file, { force: true });
    poly(...reportArgs(s, { extra: ['--format', format, '--out', file] }));
    assert.equal(readFileSync(file, 'utf8'), a.stdout, `--out writes the same bytes (${format})`);
  }
  assert.equal(storeBytes(s.db), before, 'no byte of the store moved');
});

test('RT13: --period selects by the event\'s UTC day, and by month', { timeout: 900_000 }, async () => {
  const s = await taggedDesk();
  const refused = (j) => itemOf(j, 'mit:2.1', 'desk.no-wire').counts.refused + itemOf(j, 'mit:4.3', 'desk.wire-checked').counts.refused;
  const d1 = reportJson(s, { extra: ['--period', DAY1] });
  const d2 = reportJson(s, { extra: ['--period', DAY2] });
  const month = reportJson(s, { extra: ['--period', DAY1.slice(0, 7)] });
  const other = reportJson(s, { extra: ['--period', '2026-10'] });
  assert.deepEqual([refused(d1), itemOf(d1, 'mit:7.3', 'desk.refund-reviewed').counts.escalated], [1, 0], 'day 1: the wire');
  assert.deepEqual([refused(d2), itemOf(d2, 'mit:7.3', 'desk.refund-reviewed').counts.escalated], [0, 4], 'day 2: the refunds');
  assert.deepEqual([refused(month), itemOf(month, 'mit:7.3', 'desk.refund-reviewed').counts.escalated], [1, 4], 'the month');
  assert.equal(refused(other) + itemOf(other, 'mit:7.3', 'desk.refund-reviewed').counts.escalated, 0, 'another month');
  // The period printed is the one asked for, or the first and last day of the counted events.
  assert.ok(JSON.stringify(d1.period).includes(DAY1), JSON.stringify(d1.period));
  const all = JSON.stringify(reportJson(s).period);
  assert.ok(all.includes(DAY1) && all.includes(DAY2), all);
  // A risk whose items made no decision in the period says so.
  assert.match(reportMd(s, { extra: ['--period', DAY1] }), /no decision in the period/);
});

// ── RT16: the policy set computed from the certificate ─────────────────────────────────────────────────────

test('RT16: on a recorded store, the policy set computed from the certificate equals the policySet its gate records hold, so every gated run is matched', { timeout: 900_000 }, async () => {
  for (const make of [untaggedDesk, taggedDesk]) {
    const s = await make();
    const j = reportJson(s);
    assert.deepEqual([j.unidentified, j.ambiguous], [[], []], `every run is identified by its certificate: ${JSON.stringify(j.unidentified)}`);
    const gated = new Set(verdicts(s.db).map((v) => v.run).filter((r) => !r.startsWith('runtime:')));
    assert.equal(j.store.counted, gated.size);
  }
});

// ── RT17: the MCP tool ──────────────────────────────────────────────────────────────────────────────────────

test('RT17: poly_report_risks returns the same JSON as poly report risks --format json for the same inputs, and writes nothing', { timeout: 900_000 }, async () => {
  const s = await taggedDesk();
  const cli = reportJson(s);
  const before = storeBytes(s.db);
  const c = mcpClient(process.execPath, [...ACCEPT_TEST_ANCHORS, CLI, 'mcp'], { cwd: ROOT });
  try {
    await c.initialize();
    const tool = (await c.request('tools/list')).tools.find((t) => t.name === 'poly_report_risks');
    assert.ok(tool, 'poly mcp lists poly_report_risks');
    // "With the same inputs": the argument names are the flags'. A repeated flag is a list in the schema, or one value.
    const props = tool.inputSchema?.properties ?? {};
    const many = (k, xs) => (props[k]?.type === 'array' ? xs : xs[0]);
    const trust = [`${s.trust.ledger.id}=${s.trust.ledger.file}`, `${s.trust.admission.id}=${s.trust.admission.file}`];
    const args = { db: s.db, build: s.build, certificate: many('certificate', [s.certificate]), trust: props.trust?.type === 'object' ? { [s.trust.ledger.id]: s.trust.ledger.file, [s.trust.admission.id]: s.trust.admission.file } : many('trust', trust), ...(props.format ? { format: 'json' } : {}) };
    const r = await c.request('tools/call', { name: 'poly_report_risks', arguments: args });
    assert.equal(r.isError ?? false, false, JSON.stringify(r).slice(0, 2000));
    assert.deepEqual(r.structuredContent, cli);
  } finally { await c.close(); }
  assert.equal(storeBytes(s.db), before, 'read-only');
});

// ── RT18: escalate-once (PT9.7 rule 2, finding 34) ──────────────────────────────────────────────────────────

test('RT18: a denial escalate-once with gateDecision "escalate" is an escalation by the runtime under its escalatedBy cause, ended by escalate-once, and is no refusal and no item\'s', { timeout: 900_000 }, async () => {
  const s = await taggedOnce();
  const j = reportJson(s);
  assert.ok((j.runtime ?? []).some((x) => x.kind === 'escalated' && x.reason === 'stale-items' && x.endedBy === 'escalate-once' && x.count === 1), JSON.stringify(j.runtime));
  assert.ok(!(j.runtime ?? []).some((x) => x.kind === 'refused' && x.reason === 'escalate-once'), 'never counted as a refusal');
  const item = itemOf(j, 'mit:3.1', 'review-answers.person-reviews');
  assert.ok(item, JSON.stringify(j.risks));
  assert.deepEqual([item.counts.refused, item.counts.escalated, item.counts.approved], [0, 1, 1], 'the item sent it to a person once, and a person approved it');
  const md = reportMd(s);
  const section = md.slice(md.indexOf('Escalated by the runtime (no rule)'), md.indexOf('Exposed and not covered'));
  assert.ok(section.includes('stale-items'), section);
});

test('RT18: a denial escalate-once recorded before finding 34\'s fix, with no escalatedBy, is grouped under the cause not recorded', { timeout: 300_000 }, () => {
  const j = reportJson(prefixStore());
  assert.ok((j.runtime ?? []).some((x) => x.kind === 'escalated' && x.reason === 'not recorded' && x.endedBy === 'escalate-once' && x.count === 1), JSON.stringify(j.runtime));
  assert.ok(!(j.runtime ?? []).some((x) => x.kind === 'refused' && x.reason === 'escalate-once'), 'never counted as a refusal');
});

// ── RT19: the MIT attribution (PT34.1, PT34.4 item 6) ─────────────────────────────────────────────────────────

test('RT19 guard: std/catalogs/PROVENANCE.md carries the MIT attribution line, with Version 4, its date and CC BY 4.0', () => {
  assert.ok(readFileSync(join(ROOT, 'std', 'catalogs', 'PROVENANCE.md'), 'utf8').includes(ATTRIBUTION));
});

test('RT19: the Markdown\'s header and the JSON\'s attribution carry the MIT attribution line, with the version and date the certificate records', { timeout: 900_000 }, async () => {
  const s = await taggedDesk();
  const mit = s.cert.poly?.risk?.catalogs?.find((c) => c.catalog === 'mit');
  assert.ok(mit, 'the certificate records the MIT catalog');
  const line = `Risk domains and subdomains: MIT AI Risk Repository, Domain Taxonomy, ${mit.version}, airisk.mit.edu, licensed under CC BY 4.0.`;
  assert.equal(line, ATTRIBUTION, 'the certificate records Version 4 of 2025-12-04');
  const j = reportJson(s);
  assert.equal(j.attribution, line);
  const md = reportMd(s);
  const header = md.split(/\r?\n## /)[0];
  assert.ok(header.includes(line), header);
});
