// S586 (PT8.6, PT34.2, PT1.2, PT12.3a): risk and control tags in the language. RT1 (the forms parse and format back to
// themselves; `poly fmt` sorts each list and removes repeats), RT2 (each kind of unknown tag is PL6506 at its position,
// REFUSED), RT3 (in a project that opts in, the warnings untagged: and no control:, with the verdict unchanged; none in a
// project that has not opted in), RT4 (PL6507 for an exposure id that is not a MIT subdomain, and uncovered:). Written
// by a separate writer from the specification and the catalogs alone, before any code (rule 7a). RT15 is in
// test/s586-untagged-bytes.test.mjs.
//
// The canonical layout of the clauses (line breaks, indentation) is not specified, so RT1 asserts a fixed point of the
// formatter and the order of the strings, not a layout. The JSON shape of the new warnings is not specified either: only
// their printed text is, so the text is asserted on `poly check`'s output and the report is only required to list each
// under `warnings`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, format } from '@poly/lang';
import { checkProject } from '@poly/check';
import { ROOT } from './helpers.mjs';
import { makeKey, project } from './runtime-helpers.mjs';

const CLI = join(ROOT, 'packages', 'poly-check', 'dist', 'src', 'cli.js');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const ORDERS_POLICY = read('conformance/m5/orders.policy.poly');

// ── RT1: the forms of Tags (PT8.1, PT8.6) ─────────────────────────────────────────────────────────────────────

const RULE = 'rule {\n    when effect.kind == "payment.fee"\n    require false else deny\n  }';
const MACHINE = 'machine {\n    states open, reserved\n    initial open\n    from open when effect.kind == "stock.reserve" -> reserved\n    deny in open when effect.kind == "payment.charge" reason "charge-before-reserve"\n    end open, reserved\n  }';
const policy = (items) => `module tagged_policy\n\npolicy tagged {\n  scope "orders"\n  var deploys: 0..5 = 0\n${items}\n}\n`;

/** Each form PT8.6 allows: on a rule, machine and invariant obligation, a recalled item and a policy never statement. */
const FORMS = {
  'a rule with mitigates only': `  obligation fee-denied "No fee is charged." mitigates "mit:7.3" ${RULE}`,
  'a rule with implements only': `  obligation fee-denied "No fee is charged." implements "nist:MANAGE-2.4" ${RULE}`,
  'a rule with both, two of each': `  obligation fee-denied "No fee is charged." mitigates "mit:4.3", "mit:7.3" implements "iso:A.9.2", "nist:MAP-3.5" ${RULE}`,
  'a machine obligation': `  obligation reserve-first "Charge only after stock is reserved." mitigates "mit:7.3" implements "iso:A.6.2.8" ${MACHINE}`,
  'an invariant obligation': '  obligation few-deploys "At most five deploys." mitigates "mit:6.1" invariant { deploys <= 5 }',
  'a recalled item': '  recalled style "Short sentences." mitigates "mit:3.1" implements "iso:A.9.2"',
  'a policy never statement': '  never merge-is-never-allowed "No merge is ever allowed." mitigates "mit:5.2" implements "nist:MANAGE-2.4"\n    : allow when effect.kind == "payment.fee"',
  // PT8.6's own example, written as the specification writes it: the tags on their own lines, unsorted.
  'the example of PT8.6': [
    '  obligation large-refund-reviewed "A refund above 100 is issued only after a person approves it."',
    '    mitigates "mit:7.3", "mit:4.3"',
    '    implements "nist:MAP-3.5", "iso:A.9.2"',
    '    rule {',
    '      when proposal.kind == "effect" && effect.kind == "payments.refund"',
    '      require false else escalate',
    '      on unknown escalate',
    '    }',
    '',
    '  never merge-is-never-allowed "No merge is ever allowed." mitigates "mit:5.2" implements "nist:MANAGE-2.4"',
    '    : allow when effect.kind == "github.merge"',
  ].join('\n'),
};

/** The strings of one clause as the formatted text writes them, in order. */
function clause(text, word) {
  const m = new RegExp(`\\b${word}\\s+("[^"]*"(?:\\s*,\\s*"[^"]*")*)`).exec(text);
  return m ? [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]) : null;
}

for (const [name, items] of Object.entries(FORMS)) {
  test(`RT1: ${name} parses, and its formatted text formats back to itself with every tag kept (PT8.6)`, () => {
    const src = policy(items);
    const r = parse(src);
    assert.deepEqual(r.diagnostics.map((d) => `${d.code} ${d.at?.line}:${d.at?.col} ${d.message}`), [], name);
    const out = format(r.module, r.trivia);
    const again = parse(out);
    assert.deepEqual(again.diagnostics.map((d) => `${d.code} ${d.message}`), [], `the formatted text parses: ${out}`);
    assert.equal(format(again.module, again.trivia), out, 'a formatted text formats to itself');
    for (const [, tag] of items.matchAll(/"((?:mit|nist|iso):[^"]*)"/g)) assert.ok(out.includes(`"${tag}"`), `${tag} is kept: ${out}`);
    if (items.includes('mitigates') && items.includes('implements')) assert.ok(out.indexOf('mitigates') < out.indexOf('implements'), 'mitigates comes before implements');
  });
}

test('RT1: poly fmt writes each list sorted by the string and without repeats; a repeated tag is accepted (PT8.6)', () => {
  const src = policy('  obligation fee-denied "No fee is charged." mitigates "mit:7.3", "mit:4.3", "mit:7.3" implements "nist:MAP-3.5", "iso:A.9.2", "nist:MAP-3.5", "iso:A.6.2.8" ' + RULE);
  const r = parse(src);
  assert.deepEqual(r.diagnostics.map((d) => `${d.code} ${d.message}`), [], 'a repeated tag is accepted');
  const out = format(r.module, r.trivia);
  assert.deepEqual(clause(out, 'mitigates'), ['mit:4.3', 'mit:7.3']);
  assert.deepEqual(clause(out, 'implements'), ['iso:A.6.2.8', 'iso:A.9.2', 'nist:MAP-3.5']);
  const again = parse(out);
  assert.equal(format(again.module, again.trivia), out);
});

test('RT1: poly fmt sorts and removes repeats on the command line too (poly fmt --write)', () => {
  const dir = project('s586-fmt', [], makeKey('s586-fmt'), 'test-s586-language');
  const file = join(dir, 'src', 'tagged.policy.poly');
  writeFileSync(file, policy('  recalled style "Short sentences." mitigates "mit:7.3", "mit:3.1", "mit:7.3"'));
  const r = spawnSync(process.execPath, [CLI, 'fmt', file, '--write'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.deepEqual(clause(readFileSync(file, 'utf8'), 'mitigates'), ['mit:3.1', 'mit:7.3']);
});

// Guards for PT8.6's other rules, which hold before S586 is built (the clauses did not parse anywhere then).
test('RT1 guard: mitigates and implements are keywords only after an item\'s text, so no name is reserved (PT8.6)', () => {
  const src = 'module words\n\npolicy words {\n  scope "orders"\n  var mitigates: 0..1 = 0\n  var implements: 0..1 = 0\n  obligation implements-check "A name." invariant { mitigates <= implements }\n  recalled mitigates-note "Another name."\n}\n';
  const r = parse(src);
  assert.deepEqual(r.diagnostics.map((d) => `${d.code} ${d.message}`), []);
});

test('RT1 guard: a var takes no tags, and implements before mitigates is not the grammar (PT8.1, PT8.6)', () => {
  assert.notDeepEqual(parse(policy('  var limit: 0..1 = 0 mitigates "mit:7.3"').replace('  var deploys: 0..5 = 0\n', '')).diagnostics, [], 'a var takes no tags');
  assert.notDeepEqual(parse(policy('  recalled style "Short." implements "iso:A.9.2" mitigates "mit:7.3"')).diagnostics, [], 'mitigates comes before implements');
});

// ── Projects for RT2 to RT4 ─────────────────────────────────────────────────────────────────────────────────

/** A project of conformance/m5/orders.poly with a policy, and poly.json changed as given. */
function ordersProject(name, policyText, manifest = (m) => m) {
  const dir = project(name, ['conformance/m5/orders.poly'], makeKey(name), 'test-s586-language');
  writeFileSync(join(dir, 'src', 'orders.policy.poly'), policyText);
  const pj = join(dir, 'poly.json');
  writeFileSync(pj, JSON.stringify(manifest(JSON.parse(readFileSync(pj, 'utf8'))), null, 2));
  return dir;
}

/** `poly check` on a project, with its printed output, exit code and the report it writes. */
function cliCheck(dir) {
  const r = spawnSync(process.execPath, [CLI, 'check', dir, '--root', dir, '--no-cache'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const file = join(dir, '.poly', 'report.json');
  return { exit: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout, report: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null };
}

/** Every diagnostic of a project's check, at every level of the report. */
function diagnosticsOf(r) {
  const policies = (r.files ?? []).flatMap((f) => f.policies ?? []);
  return [...(r.diagnostics ?? []), ...(r.files ?? []).flatMap((f) => [...(f.diagnostics ?? []), ...(f.machines ?? []).flatMap((m) => m.diagnostics ?? [])]), ...policies.flatMap((p) => p.diagnostics ?? [])];
}

/** Every entry of every `warnings` list anywhere in a report (PT12.3a). */
function warningsIn(v, out = []) {
  if (Array.isArray(v)) { for (const x of v) warningsIn(x, out); return out; }
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === 'warnings' && Array.isArray(x)) out.push(...x); else warningsIn(x, out); }
  return out;
}
const RISK_WARNING = /^.*(untagged: \S+ names no risk|no control: \S+ names no control|uncovered: \S+ is listed as an exposure).*$/gm;
const riskLines = (out) => (out.match(RISK_WARNING) ?? []).map((l) => l.trim());

// ── RT2: an unknown tag is PL6506 at its position (PT34.2) ──────────────────────────────────────────────────────

// Each kind PT34.2 lists, on its own item: a prefix other than mit, nist or iso; an id not in its catalog (one per
// catalog); a MIT domain alone; a risk after implements; a control after mitigates (a NIST and an ISO one); and one bad
// tag beside a good one, so the position is the bad tag's. The rule's own tag is good and is not reported.
const BAD = [
  ['bad-prefix', 'mitigates', 'cis:7.3'],
  ['bad-mit-id', 'mitigates', 'mit:7.9'],
  ['bad-nist-id', 'implements', 'nist:MANAGE-9.9'],
  ['bad-iso-id', 'implements', 'iso:A.9.9'],
  ['mit-domain', 'mitigates', 'mit:7'],
  ['risk-as-control', 'implements', 'mit:7.3'],
  ['nist-as-risk', 'mitigates', 'nist:MANAGE-2.4'],
  ['iso-as-risk', 'mitigates', 'iso:A.9.2'],
];
const BAD_POLICY = [
  'module orders_policy',
  '',
  'policy orders-governance {',
  '  scope "orders"',
  '  obligation orders-irreversible "No irreversible effect on a cancelled order." mitigates "mit:7.3" rule {',
  '    when effect.machine == "orders.Order" && effect.class == "irreversible" && machine("orders.Order").status == Cancelled',
  '    require false else deny',
  '  }',
  ...BAD.map(([item, word, tag]) => `  recalled ${item} "An item with an unknown tag." ${word} "${tag}"`),
  '  recalled mixed "A good tag and a bad one." mitigates "mit:7.3", "mit:7.9"',
  '}',
  '',
].join('\n');

/** The 1-based line and column of the opening quote of a tag, the n-th time the string occurs from a line on. */
function positionOf(text, tag, fromLine) {
  const lines = text.split('\n');
  for (let i = fromLine - 1; i < lines.length; i++) { const c = lines[i].indexOf(`"${tag}"`); if (c >= 0) return { line: i + 1, col: c + 1 }; }
  return null;
}

test('RT2: each kind of unknown tag is PL6506 POLICY_TAG_UNKNOWN at the tag\'s position, the verdict is REFUSED, and the later policy stages are not run (PT34.2)', { timeout: 300_000 }, async () => {
  const dir = ordersProject('s586-bad-tags', BAD_POLICY);
  const r = await checkProject(dir, { root: dir });
  const ds = diagnosticsOf(r);
  assert.deepEqual([...new Set(ds.map((d) => d.code))], ['PL6506'], JSON.stringify(ds.map((d) => `${d.code} ${d.message}`)));
  assert.equal(r.verdict, 'REFUSED');
  const lines = BAD_POLICY.split('\n');
  const want = [
    ...BAD.map(([item, , tag]) => positionOf(BAD_POLICY, tag, lines.findIndex((l) => l.includes(`recalled ${item} `)) + 1)),
    positionOf(BAD_POLICY, 'mit:7.9', lines.findIndex((l) => l.includes('recalled mixed ')) + 1),
  ];
  assert.deepEqual(ds.map((d) => `${d.at.line}:${d.at.col}`).sort(), want.map((p) => `${p.line}:${p.col}`).sort(), 'one PL6506 at each bad tag, none at a good one');
  const p = (r.files ?? []).flatMap((f) => f.policies ?? []).find((x) => x.scope === 'orders');
  assert.ok(p, 'the policy is reported');
  assert.deepEqual(p.stages.filter((s) => s.status === 'not-run').map((s) => s.stage).sort(), ['consistency', 'never', 'policy-admission', 'policy-lower', 'policy-tv', 'regions']);
});

// ── RT3: the warnings of a project that opts in (PT34.2, PT12.3a) ───────────────────────────────────────────────

// Opted in by its tags alone. reserve-before-charge names a risk and two controls; orders-irreversible names nothing;
// the never statement names a risk and no control; the recalled item names both.
const TAGGED_POLICY = ORDERS_POLICY
  .replace('obligation reserve-before-charge "Charge only after stock has been reserved." machine {', 'obligation reserve-before-charge "Charge only after stock has been reserved."\n    mitigates "mit:7.3"\n    implements "nist:MANAGE-2.4", "iso:A.9.2"\n    machine {')
  .replace('never no-fee-when-cancelled "No irreversible effect is ever allowed for a cancelled order.":', 'never no-fee-when-cancelled "No irreversible effect is ever allowed for a cancelled order." mitigates "mit:6.1":')
  .replace(/\n}\s*$/, '\n  recalled style "Keep the fee notice short." mitigates "mit:3.1" implements "iso:A.6.2.8"\n}\n');

let baseline;
/** The untagged project with no exposure: the verdict the warnings must not change, and no new warning (S586, Q9). */
async function untaggedBaseline() {
  baseline ??= cliCheck(ordersProject('s586-no-tags', ORDERS_POLICY));
  return baseline;
}

test('RT3 guard: a project that has not opted in (no tag, no exposure) gets no untagged:, no control: or uncovered: warning (S586, Q9)', { timeout: 300_000 }, async () => {
  assert.ok(TAGGED_POLICY.includes('mitigates "mit:7.3"') && TAGGED_POLICY.includes('mitigates "mit:6.1":') && TAGGED_POLICY.includes('recalled style'), 'the tagged variant was written');
  const b = await untaggedBaseline();
  assert.ok(b.report, b.out);
  assert.deepEqual(riskLines(b.out), []);
  assert.deepEqual(warningsIn(b.report).filter((w) => /untagged|no control|uncovered/.test(JSON.stringify(w))), []);
});

test('RT3: in a project opted in by its tags, an untagged item and an item with no control give their warnings beside the verdict, which is the verdict without them (PT34.2)', { timeout: 300_000 }, async () => {
  const b = await untaggedBaseline();
  const t = cliCheck(ordersProject('s586-tagged-warnings', TAGGED_POLICY));
  const want = ['untagged: orders-governance.orders-irreversible names no risk it mitigates (PT8.6)', 'no control: orders-governance.no-fee-when-cancelled names no control it implements (PT8.6)'];
  for (const w of want) assert.ok(t.out.includes(w), `printed: ${w}\n${t.out}`);
  assert.equal(riskLines(t.out).length, want.length, `these two and no other: ${riskLines(t.out).join(' | ')}`);
  assert.ok(!/(untagged|no control): orders-governance\.(reserve-before-charge|style) /.test(t.out), 'an item with a risk and a control gets neither');
  // Beside the verdict, never in it: the same verdict, exit code and diagnostics as the untagged project's.
  assert.equal(t.report.verdict, b.report.verdict);
  assert.equal(t.exit, b.exit);
  assert.deepEqual(diagnosticsOf(t.report).map((d) => d.code).sort(), diagnosticsOf(b.report).map((d) => d.code).sort());
  // Listed under the report's warnings (the shape of an entry is not specified; each names its item).
  const ws = JSON.stringify(warningsIn(t.report));
  assert.ok(ws.includes('orders-governance.orders-irreversible') && ws.includes('orders-governance.no-fee-when-cancelled'), ws);
});

test('RT3: a project opted in by its exposure alone warns untagged: for every item, and keeps the verdict (PT34.2, PT1.2)', { timeout: 300_000 }, async () => {
  const b = await untaggedBaseline();
  const e = cliCheck(ordersProject('s586-exposure-only', ORDERS_POLICY, (m) => ({ ...m, exposure: { risks: ['mit:7.3'] } })));
  for (const item of ['reserve-before-charge', 'orders-irreversible', 'no-fee-when-cancelled']) {
    assert.ok(e.out.includes(`untagged: orders-governance.${item} names no risk it mitigates (PT8.6)`), `${item}\n${e.out}`);
  }
  assert.ok(!/no control: /.test(e.out), 'no control: is for an item with risks');
  assert.equal(e.report?.verdict, b.report.verdict, e.out);
  assert.equal(e.exit, b.exit);
});

// ── RT4: exposure (PT34.2, PT1.2) ─────────────────────────────────────────────────────────────────────────────

test('RT4: an exposed risk no item names in mitigates gives uncovered:, and one an item names does not (PT34.2)', { timeout: 300_000 }, async () => {
  const t = cliCheck(ordersProject('s586-uncovered', TAGGED_POLICY, (m) => ({ ...m, exposure: { risks: ['mit:2.1', 'mit:7.3'] } })));
  assert.ok(t.out.includes('uncovered: mit:2.1 is listed as an exposure and no rule mitigates it (PT34.2)'), t.out);
  assert.ok(!t.out.includes('uncovered: mit:7.3'), 'mit:7.3 is mitigated by reserve-before-charge');
  // A risk named only by a recalled item or a never statement: PT34.2 says "no item of the project names in mitigates".
  const n = cliCheck(ordersProject('s586-uncovered-never', TAGGED_POLICY, (m) => ({ ...m, exposure: { risks: ['mit:6.1', 'mit:3.1'] } })));
  assert.ok(!n.out.includes('uncovered: mit:6.1') && !n.out.includes('uncovered: mit:3.1'), `named by the never statement and the recalled item\n${n.out}`);
  assert.ok(warningsIn(t.report).some((w) => JSON.stringify(w).includes('mit:2.1')), 'listed under warnings');
});

for (const [why, risks] of [['a MIT domain alone', ['mit:7']], ['a MIT id not in the catalog', ['mit:7.9']], ['a NIST control', ['nist:MANAGE-2.4']], ['an ISO control', ['iso:A.9.2']], ['an id with no prefix', ['7.3']]]) {
  test(`RT4: an exposure id that is not a MIT subdomain is PL6507 EXPOSURE_TAG_UNKNOWN, an error of the manifest: ${why}`, { timeout: 300_000 }, () => {
    const c = cliCheck(ordersProject(`s586-exposure-${risks[0].replace(/[^a-z0-9]+/gi, '-')}`, ORDERS_POLICY, (m) => ({ ...m, exposure: { risks: ['mit:7.3', ...risks] } })));
    assert.match(c.out, /PL6507/, c.out);
    assert.notEqual(c.exit, 0, 'an error is not a clean check');
  });
}

test('RT4: an unknown field under exposure is refused, as under run (PT34.2, PT1.2)', { timeout: 300_000 }, () => {
  const c = cliCheck(ordersProject('s586-exposure-field', ORDERS_POLICY, (m) => ({ ...m, exposure: { risks: ['mit:7.3'], sector: 'finance' } })));
  assert.notEqual(c.exit, 0, c.out);
  assert.match(c.out, /sector/, 'the refusal names the field');
});

test('RT4: the exposure schema is published at schemas/manifest/exposure.json (PT1.2)', () => {
  const file = join(ROOT, 'schemas', 'manifest', 'exposure.json');
  assert.ok(existsSync(file), file);
  const schema = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(JSON.stringify(schema).includes('risks'), 'it describes risks');
});
