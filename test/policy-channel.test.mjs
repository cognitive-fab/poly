// M8 plan step 9 (S181, S185, PT25.1): the proposal field `channel`, and E10 settled by test, not by reading. A
// policy that reads `effect.channel.*`, lowered as poly lowers every policy, is compiled and stepped by the pinned
// Polyaxion: a proposal carrying `channel` must be denied on it, and a proposal without it must never be allowed by a
// rule that reads it (PS8.2: unknown, then `on unknown` decides; deny or escalate, never allow).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admit, checkFile, checkProject } from '@poly/check';
import { certificateDigest, signDigest } from '@poly/core';
import { parse } from '@poly/lang';
import { lowerPolicyScope } from '@poly/lower';
import { polyaxionPeer, loadPolyaxion, policyEngine, load } from '@poly/runtime';
import { whatsapp } from '@poly/io';
import { loaded, makeKey, project } from './runtime-helpers.mjs';

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
  return { key, dir, run: () => admit(dir, {}) };
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
    await rt.dispatch('support:wa-1/support', 'Inbound', { from: 'wa-1', body: await rt.putContent('Hello') });
    await rt.advance();
    const verdicts = (await rt.chain('support:wa-1/support')).filter((e) => e.kind === 'verdict').map((e) => e.body);
    const denied = verdicts.find((b) => b.outcome === 'denied');
    assert.ok(denied && /no-free-form/.test(denied.reason), JSON.stringify(verdicts));
    assert.equal(sent.length, 0, 'the denied reply never reaches the provider');
    const proposed = await rt.store.body(denied.action);
    assert.deepEqual(proposed.effect.channel, { name: 'support', kind: 'whatsapp', recipient: proposed.effect.channel.recipient, recipientClass: 'external', messageKind: 'FreeForm' });
    assert.match(proposed.effect.channel.recipient, /^sha256:[0-9a-f]{64}$/);
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
