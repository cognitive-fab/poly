// PS15.5, as ruled on S206 and S207 (decisions-m9.md, "Four rulings"): timers fire in every configuration, and an
// application that answers a message from one channel on another gets a joint configuration beside the per-channel
// ones, explored to 10,000 global states at most.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile, resolveUses } from '@poly/check';
import { parse } from '@poly/lang';
import { expandChannels } from '@poly/core';
import { readChannels } from '@poly/ref';
import { ROOT } from './helpers.mjs';

const OUT = join(ROOT, '.poly', 'test-switches');
const BOTH = /const BOTH = `([\s\S]*?)`;/.exec(readFileSync(join(ROOT, 'test', 'review-m8b-a.test.mjs'), 'utf8'))[1];
const CROSS = BOTH.replace('  on GotText(body) {\n    emit text.reply(body: body)\n  }', '  on GotText(body) {\n    emit mail.reply(body: body)\n  }');

async function check(name, src, opts = {}) {
  const d = join(OUT, name);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'm.poly'), src);
  return checkFile(join(d, 'm.poly'), { root: d, ...opts });
}
const summary = (r) => r.configurations.map((c) => [c.configuration, c.verdict, [...new Set(c.diagnostics.map((d) => d.code))]]);

// A lamp whose Start arms a timer, and which ends when the timer fires. Its configuration offers only Start, so before
// S206 the timer never fired there and the lamp was stuck (PL5402); now the environment fires it.
const LAMP = `module lamp

enum Phase { Off, Lit, Done }

machine Lamp {
  state {
    phase : Phase = Off
  }
  terminal phase is Done

  action Start()
  action Tick()

  on Start {
    require phase is Off else reject "started"
    phase' = Lit
    after 1s -> Tick() as t
  }
  on Tick {
    require phase is Lit else reject "not-lit"
    phase' = Done
  }
}

configuration room {
  l : Lamp
  inputs { l.Start }
  bounds { transit 1 }
}
`;

test('S206: a declared configuration keeps its instances\' armed timers, and the environment fires one while it is armed', { timeout: 300_000 }, async () => {
  const r = await check('s206', LAMP);
  assert.deepEqual(summary(r), [['room', 'CLEAN', []]]);
});

const readings = (src) => {
  const mod = parse(src).module;
  const program = resolveUses(mod, join(OUT, 'm.poly'), undefined, join(ROOT, 'std')).program;
  return { program, both: [expandChannels(mod, program).module.decls, readChannels(mod, program).module.decls] };
};

test('S207: an application that answers each channel on its own keeps one configuration per channel, in the compiler and in poly-ref', () => {
  for (const decls of readings(BOTH).both) assert.deepEqual(decls.filter((d) => d.kind === 'Configuration').map((d) => d.name).sort(), ['mail', 'text']);
});

test('S207: an application that answers on another channel also gets one named after it, every conversation live, instances 1 + n and transit the sum of pending, in the compiler and in poly-ref', () => {
  const { program, both } = readings(CROSS);
  const pending = (kind) => program.find((m) => m.name === `std.channels.${kind}`).decls.find((d) => d.kind === 'Machine' && d.name === 'Conversation').fields.find((f) => f.name === 'pending').type.hi;
  for (const decls of both) {
    const configs = decls.filter((d) => d.kind === 'Configuration');
    assert.deepEqual(configs.map((d) => d.name).sort(), ['Agent', 'mail', 'text']);
    const c = configs.find((d) => d.name === 'Agent');
    assert.deepEqual([c.joint, c.bounds.instances, c.bounds.transit], [['text', 'mail'], 3, pending('sms') + pending('email')]);
    for (const ch of ['text', 'mail']) assert.ok(c.inputs.some((i) => i.instance === `desk.${ch}.Conversation` && i.action === 'Inbound'), ch);
  }
});

test('S207: the joint configuration is explored to its cap and reads INCONCLUSIVE there, never CLEAN; the cross reply\'s PL5407 is the program\'s', { timeout: 1_800_000 }, async () => {
  const r = await check('s207-cross', CROSS);
  const agent = r.configurations.find((c) => c.configuration === 'Agent');
  assert.equal(agent.verdict, 'INCONCLUSIVE', JSON.stringify(agent.diagnostics.map((d) => d.code)));
  assert.ok(agent.diagnostics.some((d) => d.code === 'PL3901'));
  assert.ok(agent.instance.states <= 10_000);
  assert.deepEqual(summary(r).filter(([n]) => n !== 'Agent'), [['text', 'FINDINGS', ['PL5407']], ['mail', 'CLEAN', []]]);
});
