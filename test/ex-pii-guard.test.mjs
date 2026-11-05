// pii-guard example tests: light checks (node:test). Written from docs/examples/pii-guard.md alone, before any code
// exists (rule 7a). Covers PG1 (CLEAN, the eight never statements declared and tested), PG2 (the defect's PL3002 naming
// no-sensitive-mail and no other property, with a witness), PG7 and PG8 (the policy's decision table through poly-ref),
// PG10 (a new recipient escalated), and the certified handlers (poly check --host, PL6836, the status classes). As
// amended by A1: the state holds the two joined facts sensitive and personal, and the measured state counts (5,206 and
// 7,006) and the defect's witness (DraftMail, Scanned, Checked, Send) are recorded on the page, so they are asserted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commandNamed } from '@poly/check';
import { parse } from '@poly/lang';
import { decide, initialSigma, policyFacts, proposalTable } from '@poly/ref';
import { ROOT } from './helpers.mjs';
import { checkExample, expectedOf, mismatch } from './examples-expected.mjs';

const EX_DIR = join(ROOT, 'examples', 'pii-guard');
const PROGRAM = join(EX_DIR, 'pii-guard.poly');
const POLICY = join(EX_DIR, 'pii-guard.policy.poly');
const DEFECT = join(EX_DIR, 'pii-guard-defect.poly');
const DEFECT_POLICY = join(EX_DIR, 'pii-guard-defect.policy.poly');
const M = 'pii.Outbound';

// The spec's table of properties: each never statement and the effect it names (PS5.2a).
const NEVERS = {
  'no-sensitive-model': 'callModel',
  'no-sensitive-mail': 'sendMail',
  'no-unscanned-model': 'callModel',
  'no-unscanned-mail': 'sendMail',
  'no-unverified-model': 'callModel',
  'no-unverified-mail': 'sendMail',
  'model-redacted': 'callModel',
  'mail-recipient-checked': 'sendMail',
};

const isOutbound = (name) => name === 'Outbound' || name.endsWith('.Outbound');

// One check of the program with its policy for the file: two tests read its report.
let cleanReport;
const clean = () => (cleanReport ??= checkExample(PROGRAM, ROOT, `ex-pii-guard-clean-${process.pid}`));

// ── the program and the defect (PG1, PG2) ──

test('PG1: the program, checked with its policy, is CLEAN with its instance printed', { timeout: 300_000 }, async () => {
  const report = await clean();
  const expected = expectedOf(PROGRAM);
  assert.deepEqual(expected, { verdict: 'CLEAN', codes: [] }, 'the first line is // expected: CLEAN');
  const m = mismatch(expected, report);
  assert.equal(m, null, m);
  assert.equal(report.verdict, 'CLEAN');
  // The policy outbound, scope "pii", is read with the program.
  assert.ok((report.policies ?? []).some((p) => p.scope === 'pii'), 'the policy of scope "pii" is paired with the program');
  const machines = (report.machines ?? []).filter((x) => isOutbound(x.machine));
  assert.equal(machines.length, 1, `one machine Outbound; got ${(report.machines ?? []).map((x) => x.machine).join(', ')}`);
  const inst = machines[0].instance;
  assert.ok(inst, 'the instance is in the report (PT12.3a)');
  assert.ok(Array.isArray(inst.domains), 'the instance has its domains');
  assert.equal(typeof inst.states, 'number', 'the instance has its state count');
  console.log(`pii-guard instance: ${machines[0].machine} over ${inst.domains.join('; ')}; ${inst.states} states`);
  // A1 records the measured count: 5,206 states for the program with its policy.
  assert.equal(inst.states, 5206, 'the state count A1 records');
  // A1: nothing vacuous and nothing not run; the policy CLEAN.
  assert.deepEqual(machines[0].vacuous ?? [], [], JSON.stringify(machines[0].vacuous));
  assert.deepEqual(machines[0].notRun ?? [], [], JSON.stringify(machines[0].notRun));
  for (const p of report.policies.filter((x) => x.scope === 'pii')) assert.equal(p.verdict, 'CLEAN', JSON.stringify(p.diagnostics));
});

test('PG1: the program declares exactly the eight never statements, each on its effect, and none is vacuous or not run', { timeout: 300_000 }, async () => {
  const program = parse(readFileSync(PROGRAM, 'utf8')).module;
  assert.ok(program, 'the program parses');
  assert.equal(program.name, 'pii');
  const outbound = program.decls.filter((d) => d.kind === 'Machine' && d.name === 'Outbound');
  assert.equal(outbound.length, 1, 'one machine Outbound in module pii');
  const nevers = outbound[0].items.filter((i) => i.kind === 'NeverEmit');
  assert.deepEqual(nevers.map((n) => n.name).sort(), Object.keys(NEVERS).sort(), 'exactly the eight never statements, by name');
  for (const n of nevers) assert.equal(n.effect, NEVERS[n.name], `${n.name} names ${NEVERS[n.name]}`);
  // PT12.3: the report lists no tested properties, so a property is tested when it is declared, the verdict is CLEAN
  // and it is in neither the vacuous nor the notRun list.
  const report = await clean();
  assert.equal(report.verdict, 'CLEAN');
  const mc = report.machines.find((x) => isOutbound(x.machine));
  assert.ok(mc, 'the machine is in the report');
  const vacuous = (mc.vacuous ?? []).map((v) => v.property);
  const notRun = (mc.notRun ?? []).map((v) => v.property);
  for (const name of Object.keys(NEVERS)) {
    assert.ok(!vacuous.includes(name), `${name} is vacuous: ${JSON.stringify(mc.vacuous)}`);
    assert.ok(!notRun.includes(name), `${name} was not run: ${JSON.stringify(mc.notRun)}`);
  }
});

test('the policy is outbound, scope "pii", in module pii_policy, with its three rules; the defect\'s policy is the same text', () => {
  const src = readFileSync(POLICY, 'utf8');
  const mod = parse(src).module;
  assert.ok(mod, 'the policy parses');
  assert.equal(mod.name, 'pii_policy');
  const policies = mod.decls.filter((d) => d.kind === 'Policy');
  assert.equal(policies.length, 1);
  assert.equal(policies[0].name, 'outbound');
  assert.equal(policies[0].scope, 'pii');
  const rules = policies[0].items.filter((i) => i.kind === 'RuleObligation').map((i) => i.name).sort();
  assert.deepEqual(rules, ['model-redacted', 'new-recipient-approved', 'sensitive-redacted']);
  // The defect's policy beside it is the same text as the program's.
  const lf = (s) => s.replace(/\r\n/g, '\n');
  assert.equal(lf(readFileSync(DEFECT_POLICY, 'utf8')), lf(src));
});

test('PG2: the defect is FINDINGS with exactly PL3002, naming no-sensitive-mail and no other property, with a witness whose last step is Send', { timeout: 300_000 }, async () => {
  const report = await checkExample(DEFECT, ROOT, `ex-pii-guard-defect-${process.pid}`);
  const expected = expectedOf(DEFECT);
  assert.deepEqual(expected, { verdict: 'FINDINGS', codes: ['PL3002'] }, 'the first line is // expected: FINDING PL3002');
  const m = mismatch(expected, report);
  assert.equal(m, null, m);
  assert.equal(report.verdict, 'FINDINGS');
  const all = [...(report.diagnostics ?? []), ...report.machines.flatMap((x) => x.diagnostics ?? [])];
  assert.deepEqual([...new Set(all.map((d) => d.code))], ['PL3002'], `exactly one code; got ${all.map((d) => d.code).join(', ')}`);
  // No other property is named, by any diagnostic.
  const named = [...new Set(all.filter((d) => d.property).map((d) => d.property))];
  assert.deepEqual(named, ['no-sensitive-mail'], `only no-sensitive-mail is named; got ${named.join(', ')}`);
  const f = all.find((d) => d.code === 'PL3002');
  assert.equal(f.name, 'STEP_PROPERTY');
  assert.ok(f.witness && Array.isArray(f.witness.trace) && f.witness.trace.length > 0, 'the finding has a witness');
  const actions = f.witness.trace.map((s) => s.action);
  console.log(`pii-guard defect witness: ${actions.join(', ')}`);
  assert.equal(actions.at(-1), 'Send', `the last step is Send; got ${actions.join(', ')}`);
  // A1 records the measured witness, in this order, 4 steps.
  assert.deepEqual(actions, ['DraftMail', 'Scanned', 'Checked', 'Send']);
  assert.equal(f.witness.length, 4);
  // A1: the defect's instance has 7,006 states, and the policy is CLEAN.
  const mc = report.machines.find((x) => isOutbound(x.machine));
  assert.ok(mc?.instance, 'the defect\'s instance is in the report');
  assert.equal(mc.instance.states, 7006, 'the state count A1 records for the defect');
  for (const p of (report.policies ?? []).filter((x) => x.scope === 'pii')) assert.equal(p.verdict, 'CLEAN', JSON.stringify(p.diagnostics));
});

// ── the policy through poly-ref's decision table (PG7, PG8, PG10) ──

let tableCache;
function table() {
  if (tableCache) return tableCache;
  const program = parse(readFileSync(PROGRAM, 'utf8')).module;
  const policyModule = parse(readFileSync(POLICY, 'utf8')).module;
  assert.ok(program && policyModule, 'the program and its policy parse');
  const scope = { scope: 'pii', policies: policyModule.decls.filter((d) => d.kind === 'Policy') };
  const t = proposalTable(scope, policyFacts([program]));
  // Every machine field the policy reads is an enum, so the table is finite and whole.
  assert.equal(t.capHit, false, 'the table is whole');
  assert.deepEqual(t.open, [], 'every read has a finite domain');
  tableCache = { scope, rows: t.rows };
  return tableCache;
}

/** The rows proposing `kind` whose machine snapshot has every field of `fields` at one of the values given. */
function rowsWhere(kind, fields) {
  const { rows } = table();
  const out = rows.filter((r) => {
    if (r.proposal !== 'effect' || r.effect?.kind !== kind) return false;
    const s = r.machines?.[M];
    if (!s) return false;
    return Object.entries(fields).every(([f, v]) => (Array.isArray(v) ? v.includes(s[f]) : s[f] === v));
  });
  assert.ok(out.length > 0, `the table proposes ${kind} with ${JSON.stringify(fields)}`);
  return out;
}

const decideRow = (row) => { const { scope } = table(); return decide(scope, initialSigma(scope), row); };
const has = (d, rule) => d.reasons.some((x) => x.includes(rule));

test('PG7: model.call with scan Done and redaction Verified is allowed', () => {
  for (const row of rowsWhere('model.call', { scan: 'Done', redaction: 'Verified' })) {
    const d = decideRow(row);
    assert.equal(d.decision, 'allow', JSON.stringify({ state: row.machines[M], d }));
  }
});

test('PG7: model.call and mail.send with scan Pending or Failed are denied by sensitive-redacted', () => {
  for (const kind of ['model.call', 'mail.send']) {
    for (const row of rowsWhere(kind, { scan: ['Pending', 'Failed'] })) {
      const d = decideRow(row);
      assert.equal(d.decision, 'deny', JSON.stringify({ kind, state: row.machines[M], d }));
      assert.ok(has(d, 'sensitive-redacted'), JSON.stringify(d.reasons));
    }
  }
});

test('PG7: model.call with sensitive Found and redaction None or Redacting is denied', () => {
  for (const row of rowsWhere('model.call', { sensitive: 'Found', redaction: ['None', 'Redacting'] })) {
    const d = decideRow(row);
    assert.equal(d.decision, 'deny', JSON.stringify({ state: row.machines[M], d }));
    assert.ok(has(d, 'sensitive-redacted'), JSON.stringify(d.reasons));
  }
});

test('PG7: model.call with sensitive NotRuledOut and redaction not Verified is denied', () => {
  for (const row of rowsWhere('model.call', { sensitive: 'NotRuledOut', redaction: ['None', 'Redacting', 'RedactFailed'] })) {
    const d = decideRow(row);
    assert.equal(d.decision, 'deny', JSON.stringify({ state: row.machines[M], d }));
    assert.ok(has(d, 'sensitive-redacted'), JSON.stringify(d.reasons));
  }
});

test('PG7, PG8: model.call with both facts Absent, scan Done and redaction None is allowed', () => {
  for (const row of rowsWhere('model.call', { sensitive: 'Absent', personal: 'Absent', scan: 'Done', redaction: 'None' })) {
    const d = decideRow(row);
    assert.equal(d.decision, 'allow', JSON.stringify({ state: row.machines[M], d }));
  }
});

test('PG8: model.call with personal NotRuledOut, sensitive Absent and redaction None is denied by model-redacted', () => {
  const facts = { sensitive: 'Absent', personal: 'NotRuledOut', redaction: 'None' };
  for (const row of rowsWhere('model.call', facts)) {
    const d = decideRow(row);
    assert.equal(d.decision, 'deny', JSON.stringify({ state: row.machines[M], d }));
    assert.ok(has(d, 'model-redacted'), JSON.stringify(d.reasons));
  }
  // With the scan done, the deny is model-redacted's alone: sensitive-redacted holds.
  for (const row of rowsWhere('model.call', { ...facts, scan: 'Done' })) {
    const d = decideRow(row);
    assert.equal(d.decision, 'deny');
    assert.ok(has(d, 'model-redacted') && !has(d, 'sensitive-redacted'), JSON.stringify(d.reasons));
  }
});

test('PG10: mail.send to a New recipient, otherwise allowed, is escalated by new-recipient-approved; to a Known one, allowed', () => {
  for (const row of rowsWhere('mail.send', { scan: 'Done', redaction: 'Verified', recipient: 'New' })) {
    const d = decideRow(row);
    assert.equal(d.decision, 'escalate', JSON.stringify({ state: row.machines[M], d }));
    assert.ok(has(d, 'new-recipient-approved'), JSON.stringify(d.reasons));
  }
  for (const row of rowsWhere('mail.send', { scan: 'Done', redaction: 'Verified', recipient: 'Known' })) {
    const d = decideRow(row);
    assert.equal(d.decision, 'allow', JSON.stringify({ state: row.machines[M], d }));
  }
});

// ── the certified handlers ──

test('poly check --host with root examples/pii-guard is CLEAN', { timeout: 300_000 }, async () => {
  const r = await commandNamed('check').run({ target: PROGRAM, root: EX_DIR, host: join(EX_DIR, 'host', 'tsconfig.json') });
  assert.equal(r.result.verdict, 'CLEAN', JSON.stringify(r.result.host?.diagnostics));
  assert.equal(r.result.host.status, 'ran');
  assert.deepEqual(r.result.host.diagnostics, []);
});

test('a host handler with a wrong payload field is PL6836', { timeout: 300_000 }, async () => {
  const tmpRoot = join(tmpdir(), `poly-test-pii-guard-host-${process.pid}-${Date.now()}`);
  mkdirSync(join(tmpRoot, 'host'), { recursive: true });
  const src = readFileSync(join(EX_DIR, 'host', 'handlers.ts'), 'utf8');
  // Both handlers read payload.text (the spec's handlers section); a field the generated type lacks is a type error.
  const broken = src.split('payload.text').join('payload.txt');
  assert.notEqual(broken, src, 'the mutation must change the file');
  writeFileSync(join(tmpRoot, 'host', 'handlers.ts'), broken);
  writeFileSync(join(tmpRoot, 'host', 'tsconfig.json'), readFileSync(join(EX_DIR, 'host', 'tsconfig.json'), 'utf8'));
  writeFileSync(join(tmpRoot, 'pii-guard.poly'), readFileSync(PROGRAM, 'utf8'));
  writeFileSync(join(tmpRoot, 'pii-guard.policy.poly'), readFileSync(POLICY, 'utf8'));
  const r = await commandNamed('check').run({ target: join(tmpRoot, 'pii-guard.poly'), root: tmpRoot, host: join(tmpRoot, 'host', 'tsconfig.json') });
  const codes = r.result.host.diagnostics.map((d) => d.code);
  assert.ok(codes.length > 0, 'the broken handler has diagnostics');
  assert.ok(codes.every((c) => c === 'PL6836'), `every code is PL6836; got ${codes.join(', ')}`);
});

/** Fake capabilities: content read from a map (none for an unknown id), and a post that records and answers `respond`. */
function fakeCaps(contents, respond) {
  const posts = [];
  return {
    posts,
    caps: {
      content: { read: async (id) => (Object.hasOwn(contents, id) ? contents[id] : null) },
      egress: { post: async (url, body, opts) => { posts.push({ url, body, opts }); return respond(); } },
    },
  };
}

async function thrown(fn) {
  try { await fn(); } catch (e) { return e; }
  assert.fail('the handler must throw');
}

test('the handlers: 200 and 201 ok; 422 permanent; 429, 503 and a transport error ambiguous and not permanent; header and body', async () => {
  const { callModel, sendMail } = await import(pathToFileURL(join(EX_DIR, 'host', 'handlers.ts')).href);
  assert.equal(typeof callModel, 'function');
  assert.equal(typeof sendMail, 'function');
  const contents = { 'c-text': 'Hello <EMAIL_1>, call <PHONE_1>.', 'c-to': 'reader@mail.example' };
  const runs = [
    { name: 'callModel', fn: callModel, payload: { text: 'c-text' }, url: 'https://model.example/v1/complete', body: { input: contents['c-text'] } },
    { name: 'sendMail', fn: sendMail, payload: { text: 'c-text', to: 'c-to' }, url: 'https://mail.example/v1/send', body: { to: contents['c-to'], body: contents['c-text'] } },
  ];
  for (const h of runs) {
    for (const status of [200, 201]) {
      const ctx = { idempotencyKey: `key-${h.name}-${status}` };
      const { caps, posts } = fakeCaps(contents, () => ({ status, headers: {}, body: {} }));
      assert.deepEqual(await h.fn(h.payload, caps, ctx), { ok: true }, `${h.name} ${status} is ok`);
      assert.equal(posts.length, 1, `${h.name} posts once`);
      assert.equal(posts[0].url, h.url);
      assert.deepEqual(posts[0].body, h.body, `${h.name} posts the body the spec gives`);
      assert.equal(posts[0].opts.headers['idempotency-key'], ctx.idempotencyKey, 'the idempotency-key header is the context\'s');
    }
    // A status from 400 to 499 other than 429 is permanent.
    for (const status of [400, 422]) {
      const { caps } = fakeCaps(contents, () => ({ status, headers: {}, body: {} }));
      const e = await thrown(() => h.fn(h.payload, caps, { idempotencyKey: 'k' }));
      assert.equal(e.permanent, true, `${h.name} ${status} is permanent`);
    }
    // 429, 5xx and a transport error are ambiguous, which with one attempt is delivered as exhausted.
    for (const status of [429, 500, 503]) {
      const { caps } = fakeCaps(contents, () => ({ status, headers: {}, body: {} }));
      const e = await thrown(() => h.fn(h.payload, caps, { idempotencyKey: 'k' }));
      assert.equal(e.ambiguous, true, `${h.name} ${status} is ambiguous`);
      assert.ok(!e.permanent, `${h.name} ${status} is not permanent`);
    }
    const { caps } = fakeCaps(contents, () => { throw new Error('connection reset'); });
    const e = await thrown(() => h.fn(h.payload, caps, { idempotencyKey: 'k' }));
    assert.equal(e.ambiguous, true, `${h.name}: a transport error is ambiguous`);
    assert.ok(!e.permanent, `${h.name}: a transport error is not permanent`);
  }
  // No content to read is permanent, and nothing is posted.
  const { caps, posts } = fakeCaps({}, () => ({ status: 200, headers: {}, body: {} }));
  assert.equal((await thrown(() => callModel({ text: 'c-none' }, caps, { idempotencyKey: 'k' }))).permanent, true);
  assert.equal((await thrown(() => sendMail({ text: 'c-none', to: 'c-none' }, caps, { idempotencyKey: 'k' }))).permanent, true);
  assert.equal(posts.length, 0, 'nothing is posted without content');
});
