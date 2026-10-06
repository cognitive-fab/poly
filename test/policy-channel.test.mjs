// M8 plan step 9 (S181, S185, PT25.1): the proposal field `channel`, and E10 settled by test, not by reading. A
// policy that reads `effect.channel.*`, lowered as poly lowers every policy, is compiled and stepped by the pinned
// Polyaxion: a proposal carrying `channel` must be denied on it, and a proposal without it must never be allowed by a
// rule that reads it (PS8.2: unknown, then `on unknown` decides; deny or escalate, never allow).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { admit, checkFile, checkProject } from '@poly/check';
import { certificateDigest, signDigest } from '@poly/core';
import { parse } from '@poly/lang';
import { lowerPolicyScope } from '@poly/lower';
import { polyaxionPeer, loadPolyaxion, policyEngine, load } from '@poly/runtime';
import { whatsapp } from '@poly/io';
import { ROOT } from './helpers.mjs';
import { loaded, makeKey, project } from './runtime-helpers.mjs';

// Review D-F4 (M8b): a message reaches a conversation whose Inbound declares claims only through its connected,
// certified adapter, so these tests post a WhatsApp notification signed with the app secret to rt.receive.
const waMessage = (from, id, text) => {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '106540352242922' }, messages: [{ from, id, type: 'text', text: { body: text } }] } }] }] });
  return { method: 'POST', url: 'https://hooks.example.com/channels/support', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', 'a').update(body).digest('hex')}` }, body };
};

const peer = polyaxionPeer();
const skip = peer.ok ? false : `not run: ${peer.reason}`;

const policy = (onUnknown) => `module desk_policy

policy channels {
  scope "desk"
  obligation no-external-on-support "Nothing goes to an external recipient on the support channel." rule {
    when effect.channel.name == "support" && effect.channel.recipientClass == "external"
    require false else deny
${onUnknown ? `    on unknown ${onUnknown}\n` : ''}  }
}
`;

async function engine(onUnknown) {
  const m = parse(policy(onUnknown)).module;
  assert.ok(m, 'the policy parses');
  const doc = lowerPolicyScope('desk', m.decls.filter((d) => d.kind === 'Policy'), 'sha256:0');
  const px = await loadPolyaxion();
  return policyEngine(px, px.compileToTriple(doc).plan);
}

/** A proposal as the gate host gives it to the engine (policy-gate.ts): a channel send, with or without `channel`. */
const proposal = (channel) => ({
  proposal: 'effect',
  effect: { kind: 'channel.support.send', class: 'irreversible', machine: 'desk.support.Conversation', ...(channel ? { channel } : {}) },
  effects: ['egress:external'],
  machines: {},
  decisions: {},
});
const CHANNEL = { name: 'support', kind: 'whatsapp', recipient: 'sha256:' + 'a'.repeat(64), recipientClass: 'external', messageKind: 'FreeForm' };

test('E10 by test: Polyaxion reads a `channel` field of the proposal, so a policy over effect.channel denies on it, and allows another channel', { skip }, async () => {
  const e = await engine('deny');
  assert.equal(e.step(e.initial(), proposal(CHANNEL)).decision, 'deny');
  assert.equal(e.step(e.initial(), proposal({ ...CHANNEL, name: 'billing' })).decision, 'allow', 'the rule reads the field: another channel is allowed');
  assert.equal(e.step(e.initial(), proposal({ ...CHANNEL, recipientClass: 'staff' })).decision, 'allow');
});

test('E10 by test, fail closed: a proposal without `channel` is never allowed by a rule that reads it; on unknown deny denies, the default escalates', { skip }, async () => {
  assert.equal((await engine('deny')).step((await engine('deny')).initial(), proposal(null)).decision, 'deny');
  const d = await engine(null);
  assert.equal(d.step(d.initial(), proposal(null)).decision, 'escalate', 'PS8.2: a deny rule whose condition is unknown escalates by default');
  const esc = await engine('escalate');
  assert.equal(esc.step(esc.initial(), proposal(null)).decision, 'escalate');
});

test('E10 by test, the engine alone: a raw Polyaxion rule over a missing action.effect.channel is applied, not skipped (no fail-open in the engine)', { skip }, async () => {
  const m = parse(policy('deny')).module;
  const doc = lowerPolicyScope('desk', m.decls.filter((d) => d.kind === 'Policy'), 'sha256:0');
  // poly's PS8.2 rewrite removed: one rule, its `when` reading the missing field directly, as Polyaxion takes it.
  const raw = { ...doc, obligations: [{ id: 'raw', kind: 'rule', text: 'raw', severity: 'deny', when: "(action.kind in ['custom.poly.effect', 'custom.poly.send']) && (action.effect.channel.name == 'support')", require: 'false' }] };
  const px = await loadPolyaxion();
  const e = policyEngine(px, px.compileToTriple(raw).plan);
  assert.equal(e.step(e.initial(), proposal(CHANNEL)).decision, 'deny');
  assert.notEqual(e.step(e.initial(), proposal(null)).decision, 'allow', 'Polyaxion applies a rule whose condition is unknown');
});

// The confirmation tests above get a seeded control that must fail them: poly's lowering without its unknown rule
// (the policy fault drop-unknown-rule) lets a proposal without `channel` through.
test('seeded control: without the unknown rule of PS8.2, a proposal without `channel` is allowed, so the fail-closed test would fail', { skip }, async () => {
  const m = parse(policy('deny')).module;
  const doc = lowerPolicyScope('desk', m.decls.filter((d) => d.kind === 'Policy'), 'sha256:0', 'drop-unknown-rule');
  const px = await loadPolyaxion();
  const e = policyEngine(px, px.compileToTriple(doc).plan);
  assert.equal(e.step(e.initial(), proposal(null)).decision, 'allow');
});

// ── The proposal field on poly's side: the policy front end types effect.channel.*, the worker adds the field, and the
// certificate pins the engine that decides. ──
const APP = `module desk

enum Last { Nothing, Sent, Refused, Lost }

channel support: whatsapp {
  adapter "whatsapp"
  thread "{from}"
  starts Agent.Start on inbound
  Message -> Agent.Got
  Delivered -> Agent.Delivered
  Rejected -> Agent.SendRejected
  Failed -> Agent.SendFailed
}

service machine Agent {
  state {
    started : bool = false
    last    : Last = Nothing
  }

  action Start()
  action Got(body: Content)
  action Delivered()
  action SendRejected(reason: string check { "window-closed" })
  action SendFailed()

  on Start {
    require !started else reject "started"
    started' = true
  }
  on Got(body) {
    emit support.reply(body: body)
  }
  on Delivered {
    last' = Sent
  }
  on SendRejected(reason) {
    last' = Refused
  }
  on SendFailed {
    last' = Lost
  }
}
`;
const POLICY = (body) => `module desk_policy

policy channels {
  scope "desk.support"
  obligation no-free-form "A free-form message on the support channel to an external recipient is not sent." rule {
${body}
  }
}
`;
// A rule over effect.* is read on sends between scopes too (PS8.7), where effect is unknown; `proposal.kind == "effect"`
// makes it false there, so `on unknown deny` acts only on an effect without a channel.
const FREE_FORM = '    when proposal.kind == "effect" && effect.channel.name == "support" && effect.channel.recipientClass == "external" && effect.channel.messageKind == "FreeForm"\n    require false else deny\n    on unknown deny';

async function admittedWith(name, policy) {
  const key = makeKey(name);
  const dir = project(name, [], key, 'test-policy-channel');
  writeFileSync(join(dir, 'src', 'desk.poly'), APP);
  writeFileSync(join(dir, 'src', 'desk.policy.poly'), policy);
  return { key, dir, run: (opts = {}) => admit(dir, opts) };
}

test('S185: the policy front end types effect.channel.{name, kind, recipient, recipientClass, messageKind}; another field, or a channel the program has not, is refused', { skip, timeout: 300_000 }, async () => {
  const ok = await admittedWith('pc-front', POLICY(FREE_FORM));
  const r = await ok.run();
  assert.equal(r.verdict, 'CLEAN', JSON.stringify(r.error ?? r));
  for (const [name, body, re] of [
    ['pc-field', '    when effect.channel.sender == "x"\n    require false else deny', /no field sender/],
    ['pc-name', '    when effect.channel.name == "billing"\n    require false else deny', /billing/],
    ['pc-kind', '    when effect.channel.messageKind == "Bulk"\n    require false else deny', /Bulk/],
  ]) {
    const bad = await admittedWith(name, POLICY(body));
    const r = await checkProject(bad.dir);
    const text = JSON.stringify(r.files.flatMap((f) => (f.policies ?? []).flatMap((p) => p.diagnostics ?? [])).map((d) => `${d.code} ${d.message}`));
    assert.ok(/PL1001/.test(text) && re.test(text), `${name}: ${text}`);
  }
});

test('PT25.1, AC17 in part: a channel send carries the field `channel`, and a policy over it denies a free-form reply before the adapter is reached', { skip, timeout: 300_000 }, async () => {
  const a = await admittedWith('pc-run', POLICY(FREE_FORM));
  const r = await a.run();
  const { rt } = await loaded({ build: join(a.dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [a.key.id]: a.key.publicKey } });
  try {
    const sent = [];
    const cfg = { appSecret: 'a', accessToken: 'b', phoneNumberId: '106540352242922', verifyToken: 'c', apiVersion: 'v23.0' };
    rt.connectChannel('support', whatsapp(cfg), { http: { async request(q) { sent.push(q); return { status: 200, headers: {}, body: JSON.stringify({ messages: [{ id: 'wamid.1' }] }) }; } } });
    await rt.create('desk.Agent', { id: 'support:wa-1' });
    await rt.create('desk.support.Conversation', { id: 'support:wa-1/support', creation: { action: 'Open', data: { app: 'support:wa-1' } } });
    // A customer's message opens the window; the agent's free-form answer is proposed with its channel, and denied.
    await rt.receive('support', waMessage('wa-1', 'm-hello', 'Hello'));
    await rt.advance();
    const verdicts = (await rt.chain('support:wa-1/support')).filter((e) => e.kind === 'verdict').map((e) => e.body);
    const denied = verdicts.find((b) => b.outcome === 'denied');
    assert.ok(denied && /no-free-form/.test(denied.reason), JSON.stringify(verdicts));
    assert.equal(sent.length, 0, 'the denied reply never reaches the provider');
    const proposed = await rt.store.body(denied.action);
    assert.deepEqual(proposed.effect.channel, { name: 'support', kind: 'whatsapp', recipient: proposed.effect.channel.recipient, recipientClass: 'external', messageKind: 'FreeForm' });
    assert.match(proposed.effect.channel.recipient, /^hmac-sha256:[0-9a-f]{64}$/);
  } finally { await rt.close(); }
});

test('the engine is pinned: the certificate names the Polyaxion commit that decides, and load refuses a build admitted with another', { skip, timeout: 300_000 }, async () => {
  const a = await admittedWith('pc-pin', POLICY(FREE_FORM));
  const r = await a.run();
  const cert = JSON.parse(readFileSync(r.certificatePath, 'utf8'));
  assert.deepEqual(cert.poly.policyEngine, { name: 'polyaxion', commit: peer.commit });
  cert.poly.policyEngine = { name: 'polyaxion', commit: '0000000' };
  cert.digest = certificateDigest(cert);
  cert.signatures = [signDigest(cert.digest, a.key.id, readFileSync(a.key.file, 'utf8'))];
  writeFileSync(r.certificatePath, JSON.stringify(cert));
  await assert.rejects(load(join(a.dir, '.poly', 'build'), { certificate: r.certificatePath, trust: { [a.key.id]: a.key.publicKey } }), /admitted with Polyaxion 0000000.*this runtime has/);
});

// Polywatch on step 9: a single file with a channel and its policy is checked with the channel's std module and its
// expansion in the policy's program, so effect.channel.messageKind is typed there too.
test('S185, polywatch: in a single-file check, a policy beside its channel reads effect.channel.messageKind', { skip, timeout: 300_000 }, async () => {
  const dir = join(project('pc-single', [], makeKey('pc-single'), 'test-policy-channel'), 'src');
  const src = `${APP}
policy channels {
  scope "desk.support"
  obligation no-free-form "A free-form message on the support channel is not sent." rule {
    when proposal.kind == "effect" && effect.channel.name == "support" && effect.channel.messageKind == "FreeForm"
    require false else deny
    on unknown deny
  }
}
`;
  writeFileSync(join(dir, 'desk.poly'), src);
  const r = await checkFile(join(dir, 'desk.poly'), { root: dir });
  const text = JSON.stringify([...r.diagnostics, ...(r.policies ?? []).flatMap((p) => p.diagnostics ?? [])].map((d) => `${d.code} ${d.message}`));
  assert.doesNotMatch(text, /PL1001/, text);
  assert.ok((r.policies ?? []).length > 0, text);
});

// ── Ruled on step 9 (fix 1): the recipient is a keyed digest. A phone number is a space small enough to invert an
// unkeyed hash by enumeration, and the proposal is journaled with its verdict, so the digest is an HMAC under a key the
// store generates and keeps, never exported, logged, journaled or certified. ──
async function denials(a, r, extra = {}, times = 1) {
  const { rt } = await loaded({ build: join(a.dir, '.poly', 'build'), certificate: r.certificatePath, trust: { [a.key.id]: a.key.publicKey } }, extra);
  const cfg = { appSecret: 'a', accessToken: 'b', phoneNumberId: '106540352242922', verifyToken: 'c', apiVersion: 'v23.0' };
  rt.connectChannel('support', whatsapp(cfg), { http: { async request() { return { status: 200, headers: {}, body: JSON.stringify({ messages: [{ id: 'wamid.1' }] }) }; } } });
  await rt.create('desk.Agent', { id: 'support:wa-1' });
  await rt.create('desk.support.Conversation', { id: 'support:wa-1/support', creation: { action: 'Open', data: { app: 'support:wa-1' } } });
  for (let i = 0; i < times; i++) {
    await rt.receive('support', waMessage('wa-1', `m-${i}`, `Hello ${i}`));
    await rt.advance();
  }
  const denied = (await rt.chain('support:wa-1/support')).filter((e) => e.kind === 'verdict' && e.body.outcome === 'denied').map((e) => e.body);
  const actions = await Promise.all(denied.map((b) => rt.store.body(b.action)));
  const ledger = rt.store.db.prepare('SELECT event FROM poly_ledger').all().map((x) => x.event).join('\n');
  const content = rt.store.db.prepare('SELECT body FROM poly_content').all().map((x) => x.body).join('\n');
  await rt.close();
  return { recipients: actions.map((p) => p.effect.channel.recipient), actions, ledger, content };
}
const unkeyed = 'sha256:' + createHash('sha256').update('whatsapp:wa-1').digest('hex');

test('fix 1: one address gives one recipient digest in one store and two in two stores; the journal holds neither the address nor its unkeyed hash', { skip, timeout: 300_000 }, async () => {
  const a = await admittedWith('pc-keyed', POLICY(FREE_FORM));
  const r = await a.run();
  const one = await denials(a, r, {}, 2);
  assert.equal(one.recipients.length, 2);
  assert.equal(one.recipients[0], one.recipients[1], 'one address, one store: one digest');
  assert.match(one.recipients[0], /^hmac-sha256:[0-9a-f]{64}$/);
  const two = await denials(a, r);
  assert.notEqual(two.recipients[0], one.recipients[0], 'two stores: two digests');
  for (const x of [one, two]) {
    for (const p of x.actions) assert.doesNotMatch(JSON.stringify(p), /wa-1/, 'the proposal holds no address');
    assert.ok(!x.ledger.includes(unkeyed.slice(7)) && !x.content.includes(unkeyed.slice(7)), 'the journal holds no unkeyed hash');
  }
});

test('fix 1, seeded control: with the unkeyed hash (fault unkeyed-recipient), the journal check finds it', { skip, timeout: 300_000 }, async () => {
  const a = await admittedWith('pc-unkeyed', POLICY(FREE_FORM));
  const r = await a.run();
  const x = await denials(a, r, { fault: 'unkeyed-recipient' });
  assert.equal(x.recipients[0], unkeyed);
  assert.ok(x.content.includes(unkeyed.slice(7)), 'the check above would fail');
});

// ── Ruled on step 9 (fix 2): the engine as loaded is the engine pinned. Admission and load refuse a checkout whose
// pinned (tracked) file differs from the pinned commit, naming it; an untracked file is ignored. Tested on a copy of
// the pinned files, so the sibling checkout is never changed. ──
function pinnedCopy(name) {
  const text = readFileSync(join(ROOT, 'peers', 'polyaxion', 'PROVENANCE.md'), 'utf8');
  const files = [...text.matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)].map((m) => m[1]);
  const dir = join(ROOT, '.poly', 'test-policy-channel', name);
  rmSync(dir, { recursive: true, force: true });
  for (const f of files) { mkdirSync(dirname(join(dir, f)), { recursive: true }); copyFileSync(join(peer.dir, f), join(dir, f)); }
  return { dir, files };
}

test('fix 2: a copy of the pinned files is the pinned engine; an untracked file changes nothing; a changed pinned file is refused at admission and at load, by name', { skip, timeout: 300_000 }, async () => {
  const { dir, files } = pinnedCopy('engine-copy');
  assert.equal(polyaxionPeer({ dir, fresh: true }).ok, true);
  writeFileSync(join(dir, 'packages', 'polyaxion', 'src', 'untracked-note.mjs'), '// not tracked\n');
  assert.equal(polyaxionPeer({ dir, fresh: true }).ok, true, 'an untracked file is ignored');
  const a = await admittedWith('pc-modified', POLICY(FREE_FORM));
  const r = await a.run();
  const changed = files.find((f) => f.endsWith('src/core/expr.mjs'));
  writeFileSync(join(dir, changed), `${readFileSync(join(dir, changed), 'utf8')}\n// a local edit\n`);
  await assert.rejects(load(join(a.dir, '.poly', 'build'), { certificate: r.certificatePath, trust: { [a.key.id]: a.key.publicKey }, policyEngine: dir }), (e) => e.message.includes(`${changed} differs`));
  // Last, since a refused admission leaves no certificate.
  await assert.rejects(a.run({ policyEngine: dir }), (e) => e.message.includes(`${changed} differs`));
});
