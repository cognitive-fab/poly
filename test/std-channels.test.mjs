// M8b step 2 (plan step 7): the five conversation machines of std/channels. Each is written from its provider's
// documentation, read on the date its PROVENANCE.md records. Each must be CLEAN, free of deadlock, and prove its
// properties; a seeded mutant of each rule must give a finding with a witness; and an application bound to it through
// a channel must check CLEAN in the configuration the channel generates (PS15.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admit, checkFile } from '@poly/check';
import { format, parse } from '@poly/lang';
import { ROOT } from './helpers.mjs';
import { loaded, makeKey, project } from './runtime-helpers.mjs';

const STD = join(ROOT, 'std', 'channels');
const OUT = join(ROOT, '.poly', 'test-std-channels');
const all = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics), ...r.configurations.flatMap((c) => c.diagnostics)];
const text = (r) => `${r.error ?? ''} ${JSON.stringify(all(r).map((d) => `${d.code} ${d.message}`))}`;
let n = 0;
async function check(file, src) {
  const d = join(OUT, `case-${n++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, file), src);
  return checkFile(join(d, file), { root: d });
}

// Each kind: its thread field, the reasons its Peer may refuse with, and one seeded mutant per rule. A rule is a
// never statement, a step property or a reject property of the conversation; its mutant breaks the handler that keeps
// it, as [handler, text, replacement], the text unique within that handler. one-send-at-a-time's mutant lets a send
// out while the slot is held by a send in flight.
const KINDS = {
  whatsapp: {
    sample: 'wa-1',
    extra: {},
    thread: 'from',
    reasons: '"window-closed"',
    rules: {
      'free-form-outside-window': ['Reply', 'if window is Closed {', 'if window is Open && window is Closed {'],
      'one-send-at-a-time': ['Template', 'require slot is Free else reject "busy"', 'require !(slot is Receipt) else reject "busy"'],
      'window-opens-on-inbound': ['Template', "slot' = Sending\n", "slot' = Sending\n    window' = Open\n"],
    },
  },
  sms: {
    sample: 'sms-1',
    extra: { keyword: 'Plain' },
    thread: 'from',
    reasons: '"opted-out"',
    rules: {
      'no-send-after-opt-out': ['Reply', 'if !consent {', 'if consent && !consent {'],
      'one-send-at-a-time': ['Template', 'require slot is Free else reject "busy"', 'require !(slot is Receipt) else reject "busy"'],
      'consent-changes-only-by-keyword': ['SendFailed', "slot' = Receipt\n", "slot' = Receipt\n    consent' = true\n"],
      'opt-keyword-never-refused': ['Inbound', 'if keyword is OptOut {', 'require waiting < 2 else reject "backlog"\n    if keyword is OptOut {'],
    },
  },
  email: {
    sample: 'mail-1',
    extra: { event: 'Mail' },
    thread: 'from',
    reasons: '"unsubscribed", "suppressed"',
    rules: {
      'no-bulk-after-unsubscribe': ['Template', 'if !subscribed {', 'if subscribed && !subscribed {'],
      'no-send-to-suppressed': ['Reply', 'if bounces == 2 {', 'if bounces == 2 && bounces == 1 {'],
      'one-send-at-a-time': ['Template', 'require slot is Free else reject "busy"', 'require !(slot is Receipt) else reject "busy"'],
      'unsubscribe-holds': ['Inbound', "waiting' = waiting + 1\n", "waiting' = waiting + 1\n      subscribed' = true\n"],
    },
  },
  slack: {
    sample: 'C-1',
    extra: { event: 'Posted' },
    thread: 'channel',
    reasons: '"channel-archived", "rate-limited"',
    rules: {
      'no-post-to-archived': ['Reply', 'if archived {', 'if archived && !archived {'],
      'one-message-per-second': ['Template', 'if cooling {', 'if cooling && !cooling {'],
      'one-send-at-a-time': ['Template', 'require slot is Free else reject "busy"', 'require !(slot is Receipt) else reject "busy"'],
    },
  },
  webhook: {
    sample: 'hook-1',
    extra: {},
    thread: 'source',
    reasons: '"endpoint-disabled"',
    rules: {
      'no-delivery-while-disabled': ['Reply', 'if !enabled {', 'if enabled && !enabled {'],
      'one-send-at-a-time': ['Template', 'require slot is Free else reject "busy"', 'require !(slot is Receipt) else reject "busy"'],
      'disabled-only-after-failures': ['Undelivered', 'if failures < 2 {', 'if failures < 0 {'],
    },
  },
};

/** The source with one handler's text replaced; the text must occur once in that handler. */
function mutate(src, handler, from, to) {
  const start = src.search(new RegExp(`\n  on ${handler}[ (]`));
  assert.ok(start >= 0, `no handler ${handler}`);
  const rest = src.slice(start + 1);
  const end = start + 1 + rest.search(/\n  (on |effect )/);
  const body = src.slice(start, end);
  assert.equal(body.split(from).length, 2, `${handler}: the mutant's text is not unique in the handler: ${from}`);
  return src.slice(0, start) + body.replace(from, to) + src.slice(end);
}

/** An application of one ticket per thread: it answers the first message once, and closes on the receipt. */
const application = (kind, spec) => `module desk

enum Status { New, Open, Closed }

channel line: ${kind} {
  adapter "${kind}"
  thread "{${spec.thread}}"
  starts Ticket.Start on inbound
  Message -> Ticket.Got
  Delivered -> Ticket.Delivered
  Rejected -> Ticket.SendRejected
  Failed -> Ticket.SendFailed
}

machine Ticket {
  state {
    status  : Status = New
    replies : 0..1 = 0
  }
  terminal status is Closed

  action Start()
  action Got(body: Content)
  action Delivered()
  action SendRejected(reason: string check { ${spec.reasons} })
  action SendFailed()

  on Start {
    require status is New else reject "started"
    status' = Open
  }
  on Got(body) {
    require status is Open else reject "closed"
    require replies == 0 else reject "replied"
    replies' = 1
    emit line.reply(body: body)
  }
  on Delivered {
    require status is Open else reject "closed"
    status' = Closed
  }
  on SendRejected(reason) {
    require status is Open else reject "closed"
    status' = Closed
  }
  on SendFailed {
    require status is Open else reject "closed"
    status' = Closed
  }
}
`;

const source = (kind) => readFileSync(join(STD, `${kind}.poly`), 'utf8');
const ruleNames = (src) => [...src.matchAll(/^\s*(?:never|step property|reject property) ([a-z0-9-]+):/gm)].map((m) => m[1]);

for (const [kind, spec] of Object.entries(KINDS)) {
  test(`std.channels.${kind}: CLEAN, free of deadlock, and every property proved`, { timeout: 300_000 }, async () => {
    const src = source(kind);
    assert.deepEqual(ruleNames(src).sort(), Object.keys(spec.rules).sort(), 'each rule has its seeded mutant');
    const parsed = parse(src);
    assert.equal(format(parsed.module, parsed.trivia), src, 'a std module is in canonical form');
    const r = await check(`${kind}.poly`, src);
    assert.equal(r.verdict, 'CLEAN', text(r));
    const conv = r.machines.find((m) => m.machine === 'Conversation');
    assert.ok(conv, text(r));
    assert.deepEqual([conv.notRun, conv.vacuous], [[], []]);
    const stage = (m, s) => m.stages.find((x) => x.stage === s);
    for (const s of ['lower', 'validate', 'translation-validation', 'model-check']) assert.deepEqual([s, stage(conv, s)?.status, stage(conv, s)?.verdict], [s, 'ran', 'CLEAN']);
    // The conversation is a service (PS1.7): it never ends, so the configuration's quiescence check covers it. Read
    // without the marker, the same machine is free of deadlock under PS5.6: in every reachable state some action
    // accepts.
    assert.match(src, /^service machine Conversation \{$/m);
    const plain = await check(`${kind}.poly`, src.replace(/^service machine Conversation \{$/m, 'machine Conversation {'));
    const dl = stage(plain.machines.find((m) => m.machine === 'Conversation'), 'deadlock');
    assert.deepEqual([dl.status, dl.verdict], ['ran', 'CLEAN'], text(plain));
    assert.doesNotMatch(dl.note ?? '', /exempt/);
  });

  for (const [rule, [handler, from, to]] of Object.entries(spec.rules)) {
    test(`std.channels.${kind}: the seeded mutant of ${rule} gives a finding with a witness`, { timeout: 300_000 }, async () => {
      const r = await check(`${kind}.poly`, mutate(source(kind), handler, from, to));
      const f = all(r).find((d) => ['PL3002', 'PL3003'].includes(d.code) && d.message.includes(rule));
      assert.ok(f, text(r));
      assert.ok(f.witness?.steps?.length ?? f.witness?.length, JSON.stringify(f));
    });
  }

  test(`std.channels.${kind}: PROVENANCE.md names a source and the date for every rule and every constant`, () => {
    const prov = readFileSync(join(STD, kind, 'PROVENANCE.md'), 'utf8');
    assert.match(prov, /read on 2026-10-05/);
    // A rule is the provider's, with a source, or poly's own, listed as such.
    const own = prov.slice(prov.indexOf("## poly's own rules"), prov.indexOf('## Not checked'));
    for (const rule of Object.keys(spec.rules)) {
      const row = prov.split('\n').find((l) => l.startsWith('|') && l.includes(`\`${rule}\``));
      assert.ok(row && (/https:\/\//.test(row) || own.includes(row)), `${rule}: no row with a source, and not listed as poly's own`);
    }
    assert.ok(Object.keys(spec.rules).some((rule) => prov.split('\n').some((l) => l.includes(`\`${rule}\``) && /https:\/\//.test(l))), 'at least one rule is the provider\'s');
    // Every duration and retry bound in the source is a provider's number or poly's own choice, and is recorded.
    for (const [, c] of source(kind).matchAll(/\b(\d+(?:ms|s|m|h))\b/g)) assert.ok(prov.includes(`\`${c}\``), `${c}: not in PROVENANCE.md`);
  });

  test(`std.channels.${kind}: an application bound through a channel checks CLEAN in the generated configuration`, { timeout: 300_000 }, async () => {
    const r = await check('desk.poly', application(kind, spec));
    assert.equal(r.verdict, 'CLEAN', text(r));
    assert.deepEqual(r.machines.map((m) => m.machine).sort(), ['Ticket', 'line.Conversation']);
    const cfg = r.configurations.find((c) => c.configuration === 'line');
    assert.ok(cfg && cfg.verdict === 'CLEAN', text(r));
  });

  // The real std, with no test option: admission certifies the channel, whose descriptor records the library's digest,
  // and the runtime loads it. Until E13 a new thread is refused creation-unavailable (PS15.4).
  test(`std.channels.${kind}: an application on it is admitted and loaded from std/, and its descriptor records the library`, { timeout: 300_000 }, async () => {
    const key = makeKey(`std-${kind}`);
    const dir = project(`std-${kind}`, [], key, 'test-std-channels-rt');
    writeFileSync(join(dir, 'src', 'desk.poly'), application(kind, spec));
    const a = await admit(dir, {});
    assert.equal(a.verdict, 'CLEAN', JSON.stringify(a.error ?? a));
    const cert = JSON.parse(readFileSync(a.certificatePath, 'utf8'));
    assert.deepEqual(cert.poly.channels.map((c) => [c.name, c.application]), [['line', 'desk.Ticket']]);
    const descriptor = JSON.parse(readFileSync(join(dir, '.poly', 'build', 'channels', 'line.json'), 'utf8'));
    assert.equal(descriptor.library.module, `std.channels.${kind}`);
    assert.match(descriptor.library.digest, /^sha256:[0-9a-f]{64}$/);
    const { rt } = await loaded({ build: join(dir, '.poly', 'build'), certificate: a.certificatePath, trust: { [key.id]: key.publicKey } });
    try {
      const body = await rt.putContent('hello');
      const r = await rt.inbound('line', { [spec.thread]: KINDS[kind].sample, body, ...KINDS[kind].extra }, { messageId: 'm-1' });
      assert.deepEqual([r.outcome, r.reason], rt.kernelCreatesInstances ? ['delivered', undefined] : ['refused', 'creation-unavailable']);
    } finally { await rt.close(); }
  });
}

// PS15.3, as ruled after step 7: each receipt is acknowledged by the expansion, so an application that answers every
// message keeps every message between it and its conversation within pending's bound. Its generated configuration is
// CLEAN for every kind (it was INCONCLUSIVE with PL5301 before the acknowledgement).
const answering = (kind, spec) => `module desk

enum Last { Nothing, Sent, Refused, Lost }

channel line: ${kind} {
  adapter "${kind}"
  thread "{${spec.thread}}"
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
  action SendRejected(reason: string check { ${spec.reasons} })
  action SendFailed()

  on Start {
    require !started else reject "started"
    started' = true
  }
  on Got(body) {
    emit line.reply(body: body)
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

for (const [kind, spec] of Object.entries(KINDS)) {
  test(`std.channels.${kind}, PS15.3: an application that answers every message is CLEAN in its generated configuration`, { timeout: 300_000 }, async () => {
    const r = await check('desk.poly', answering(kind, spec));
    assert.equal(r.verdict, 'CLEAN', text(r));
    const cfg = r.configurations.find((c) => c.configuration === 'line');
    assert.equal(cfg?.verdict, 'CLEAN', text(r));
    assert.ok(!all(r).some((d) => d.code === 'PL5301'), text(r));
  });
}

// As ruled on step 8: a reply that answers a waiting message is queued while the slot is held (at most two, within
// pending), so an application that answers every message is never refused busy (above). With the queue taken out of a
// module, the same application gets PL5407 in its generated configuration, for every kind.
async function checkWith(stdModule, kind, src) {
  const d = join(OUT, `case-${n++}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(join(d, 'std', 'channels'), { recursive: true });
  writeFileSync(join(d, 'std', 'channels', `${kind}.poly`), stdModule);
  writeFileSync(join(d, 'desk.poly'), src);
  return checkFile(join(d, 'desk.poly'), { root: d, std: join(d, 'std') });
}

for (const [kind, spec] of Object.entries(KINDS)) {
  test(`std.channels.${kind}: without its reply queue, an application that answers every message is refused busy, PL5407 with a witness`, { timeout: 300_000 }, async () => {
    const unqueued = mutate(source(kind), 'Reply', 'require waiting > 0 else reject "busy"', 'require waiting > 2 else reject "busy"');
    const r = await checkWith(unqueued, kind, answering(kind, spec));
    const f = all(r).find((d) => d.code === 'PL5407');
    assert.ok(f && /Reply/.test(f.message) && f.witness.length > 0, text(r));
  });
}

test('std.channels.whatsapp, PS15.5: an application whose receipt handler can be rejected gets PL5406 with a witness', { timeout: 300_000 }, async () => {
  const src = application('whatsapp', KINDS.whatsapp).replace('  on Delivered {\n    require status is Open else reject "closed"', '  on Delivered {\n    require status is New else reject "too-late"');
  const r = await check('desk.poly', src);
  const f = all(r).find((d) => d.code === 'PL5406');
  assert.ok(f && /Delivered/.test(f.message) && f.witness.length > 0, text(r));
});
