// M10 steps 3 and 4 (PS1.4b, PS17, PT10i, S300, S301, S303): audiences, sources, retrieval and Items on both surfaces,
// PL6833 to PL6835, the memory descriptors read back, and the flow rule in poly-ref: AC22's static half, with its seeded
// control (the concierge with `where owner == customer` removed) giving PL6831 with the shortest witness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { digest } from '@poly/core';
import { parse, format } from '@poly/lang';
import { printModule, readEmbedded } from '@poly/embed';
import { checkFile } from '@poly/check';
import { ROOT } from './helpers.mjs';

const CONCIERGE = readFileSync(join(ROOT, 'test', 'fixtures', 'm10', 'concierge-memory.poly'), 'utf8');
const HELP = readFileSync(join(ROOT, 'test', 'fixtures', 'm10', 'sms-help.poly'), 'utf8');
const OUT = join(ROOT, '.poly', 'test-memory-flow');
const swap = (src, from, to) => { assert.ok(src.includes(from), from); return src.replace(from, to); };
const all = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...r.configurations.flatMap((c) => c.diagnostics)];
const text = (r) => `${r.error ?? ''} ${JSON.stringify(all(r).map((d) => `${d.code} ${d.message}`))}`;
const codes = (r) => all(r).map((d) => d.code);
let n = 0;
async function check(src) {
  const d = join(OUT, `case-${n++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'm.poly'), src);
  return { r: await checkFile(join(d, 'm.poly'), { root: d }), build: join(d, '.poly', 'build') };
}

test('PS1.4b, PS17: audience, source, retrieve, remember, to, audience and cites format and print on both surfaces to the same digest', () => {
  const remembering = swap(CONCIERGE, '  effect reply(', '  effect note(subject: Principal, fact: Content) {\n    remember memory as derived about subject\n  }\n\n  effect reply(');
  const withMemory = swap(remembering, 'enum Phase', 'source memory: memory {\n  audience customer owned\n  stale deny\n}\n\nenum Phase');
  for (const src of [CONCIERGE, HELP, withMemory]) {
    const a = parse(src);
    assert.ok(a.module, JSON.stringify(a.diagnostics));
    const formatted = format(a.module);
    assert.equal(digest(parse(formatted).module), digest(a.module));
    assert.equal(format(parse(formatted).module), formatted);
    const back = readEmbedded(printModule(a.module));
    assert.ok(back.module, JSON.stringify(back.diagnostics));
    assert.equal(digest(back.module), digest(a.module));
  }
  const f = format(parse(withMemory).module);
  for (const line of ['audience { public < customer < staff }', 'source orders: records {', '  audience customer owned', '  freshness 1h', '  stale deny', '    retrieve orders where owner == customer limit 2', '    remember memory as derived about subject', '    to customer', '    audience public', '    cites context']) assert.ok(f.includes(line + '\n'), line);
});

test('AC22 (static): the concierge with memory is CLEAN, its flow rule ran, and its descriptors are written and read back', { timeout: 180_000 }, async () => {
  const { r, build } = await check(CONCIERGE);
  assert.equal(r.verdict, 'CLEAN', text(r));
  const flow = r.machines[0].stages.find((s) => s.stage === 'flow');
  assert.equal(flow?.verdict, 'CLEAN');
  assert.equal(r.machines[0].stages.find((s) => s.stage === 'translation-validation').verdict, 'CLEAN');
  assert.deepEqual(JSON.parse(readFileSync(join(build, 'sources', 'orders.json'), 'utf8')), { v: 1, module: 'concierge_memory', source: 'orders', kind: 'records', adapter: 'postgres', audience: 'customer', class: 1, owned: true, freshnessMs: 3_600_000, stale: 'escalate' });
  assert.deepEqual(JSON.parse(readFileSync(join(build, 'flow', 'concierge_memory.json'), 'utf8')), { v: 1, module: 'concierge_memory', audience: ['public', 'customer', 'staff'], sources: { orders: { class: 1, owned: true } }, claims: {} });
  const manifest = JSON.parse(readFileSync(join(build, 'concierge_memory.Desk', 'effects.manifest.json'), 'utf8')).effects;
  assert.deepEqual(manifest['source.orders.retrieve'].retrieve, { source: 'orders', owner: 'customer', limit: 2 });
  assert.deepEqual(manifest['source.orders.retrieve'].labels, ['read:private']);
  assert.deepEqual(manifest['support.reply'].recipient, { to: 'customer', audience: 'public' });
  assert.equal(manifest['decision.answer'].decision.cites, 'context');
  assert.equal(manifest['decision.answer'].decision.result, 'content');
  // PS17.4: one more principal representative for the owned source.
  assert.match(JSON.stringify(r.machines[0].instance.domains), /3 principal representatives/);
});

test('AC22 (static), seeded control: with where owner == customer removed, the reply leaks, PL6831 with the shortest witness', { timeout: 180_000 }, async () => {
  const { r } = await check(swap(CONCIERGE, ' where owner == customer', ''));
  assert.equal(r.verdict, 'FINDINGS', text(r));
  assert.deepEqual(codes(r), ['PL6831'], text(r));
  const f = all(r).find((d) => d.code === 'PL6831');
  assert.match(f.message, /support\.reply sends body, tainted \(customer, \{p1, p2, p3\}\), to a recipient of class public and principal p1/);
  assert.deepEqual(f.witness.trace.map((s) => s.action), ['Ask', 'Found', 'Answered']);
});

test('PS17.3: a reply to someone other than the owner leaks, and a recipient of a higher class reads it', { timeout: 180_000 }, async () => {
  // The reply goes to a principal the caller names: another customer's orders can reach them.
  const other = swap(swap(swap(CONCIERGE, 'action Answered(text: Content, cites: Items)', 'action Answered(text: Content, cites: Items, to: Principal)'), 'ok(r) -> Answered(text: r.answer, cites: r.cites)', 'ok(r) -> Answered(text: r.answer, cites: r.cites, to: none)'), 'emit reply(customer: customer, body: text)', 'emit reply(customer: to, body: text)').replace('on Answered(text, cites)', 'on Answered(text, cites, to)');
  const leak = await check(other);
  assert.ok(codes(leak.r).includes('PL6831'), text(leak.r));
  // Staff read every customer's orders: the same reply to a recipient of class staff is allowed.
  const staff = await check(swap(other, '    audience public\n', '    audience staff\n'));
  assert.ok(!codes(staff.r).includes('PL6831'), text(staff.r));
});

test('PS17.3: in a channel\'s configuration, staff documents reach a staff channel, and leak to a customer channel', { timeout: 600_000 }, async () => {
  const ok = await check(HELP);
  assert.ok(!codes(ok.r).includes('PL6831'), text(ok.r));
  assert.equal(ok.r.configurations[0].diagnostics.filter((d) => d.code === 'PL6831').length, 0);
  const leak = await check(swap(HELP, '  starts Agent.Start on inbound\n  audience staff\n', '  starts Agent.Start on inbound\n  audience customer\n'));
  const f = leak.r.configurations[0].diagnostics.find((d) => d.code === 'PL6831');
  assert.ok(f, text(leak.r));
  assert.match(f.message, /channel\.text\.send sends body, tainted \(staff, \{\}\), to a recipient of class customer/);
  assert.equal(f.witness.trace[f.witness.trace.length - 1].action, 'Reply');
});

test('PS17.5: remembering an answer about its customer is allowed; about anyone else, or below its class, it is PL6832', { timeout: 300_000 }, async () => {
  const base = swap(swap(swap(CONCIERGE, 'enum Phase', 'source memory: memory {\n  audience customer owned\n}\n\nenum Phase'), '    emit reply(customer: customer, body: text)\n', '    emit reply(customer: customer, body: text)\n    emit note(subject: customer, fact: text)\n'), '  effect reply(', '  effect note(subject: Principal, fact: Content) {\n    remember memory as derived about subject\n  }\n\n  effect reply(');
  const ok = await check(base);
  assert.equal(ok.r.verdict, 'CLEAN', text(ok.r));
  const other = await check(swap(base, 'emit note(subject: customer, fact: text)', 'emit note(subject: none, fact: text)'));
  assert.deepEqual(codes(other.r), ['PL6832'], text(other.r));
  const lower = await check(swap(base, 'source memory: memory {\n  audience customer owned', 'source memory: memory {\n  audience public'));
  assert.deepEqual(codes(lower.r), ['PL6832'], text(lower.r));
});

test('PL6833 to PL6835: an undeclared class, an adapter poly-io does not make, and an owner predicate on an unowned source', { timeout: 180_000 }, async () => {
  for (const [from, to, code] of [
    ['  audience customer owned\n  freshness 1h', '  audience gold owned\n  freshness 1h', 'PL6833'],
    ['    audience public\n', '    audience gold\n', 'PL6833'],
    ['audience { public < customer < staff }\n', '', 'PL6833'],
    ['  adapter "postgres"', '  adapter "mysql"', 'PL6834'],
    ['  adapter "postgres"\n', '', 'PL6834'],
    ['  audience customer owned\n  freshness 1h', '  audience customer\n  freshness 1h', 'PL6835'],
  ]) {
    const { r } = await check(swap(CONCIERGE, from, to));
    assert.equal(r.verdict, 'REFUSED', to);
    assert.ok(codes(r).length && codes(r).every((c) => c === code), `${to}: ${text(r)}`);
  }
});

test('PS1.4b: an Items is passed and its count read; stored, compared or given a check domain it is PL1209', { timeout: 180_000 }, async () => {
  const counted = await check(swap(CONCIERGE, '    phase\' = Answering\n    decide', '    require items.count >= 0 else reject "none"\n    phase\' = Answering\n    decide'));
  assert.equal(counted.r.verdict, 'CLEAN', text(counted.r));
  for (const [from, to] of [
    ['    question : Content   = none\n', '    question : Content   = none\n    kept     : Items     = none\n'],
    ['    phase\' = Answering\n    decide', '    require items == items else reject "x"\n    phase\' = Answering\n    decide'],
    ['    phase\' = Answering\n    decide', '    require items.owners == 1 else reject "x"\n    phase\' = Answering\n    decide'],
  ]) {
    const { r } = await check(swap(CONCIERGE, from, to));
    assert.equal(r.verdict, 'REFUSED', to);
    assert.ok(codes(r).includes('PL1209'), `${to}: ${text(r)}`);
  }
});

test('PS17.2: a retrieval names an existing source and a Principal owner, and takes no kind or labels of its own', { timeout: 180_000 }, async () => {
  for (const [from, to, code] of [
    ['retrieve orders where', 'retrieve order where', 'PL1001'],
    ['where owner == customer', 'where owner == buyer', 'PL1001'],
    ['    retrieve orders where owner == customer limit 2\n', '    retrieve orders where owner == customer limit 2\n    kind "x.y"\n', 'PL1201'],
    ['    to customer\n', '    to body\n', 'PL1201'],
    ['    cites context\n', '    cites question\n', 'PL1201'],
  ]) {
    const { r } = await check(swap(CONCIERGE, from, to));
    assert.equal(r.verdict, 'REFUSED', to);
    assert.ok(codes(r).includes(code), `${to}: ${text(r)}`);
  }
});
