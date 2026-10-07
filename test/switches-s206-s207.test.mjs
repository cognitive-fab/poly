// M9 step 10 (S206, S207): built behind switches that are off until the owner rules on their measured changes
// (decisions-m9.md, "S206 (S192) and S207 (S193): measure first, then rule"). The switches are a check option only:
// no command-line flag, no poly.json field, and nothing reads them from the environment.
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
export const CROSS = BOTH.replace('  on GotText(body) {\n    emit text.reply(body: body)\n  }', '  on GotText(body) {\n    emit mail.reply(body: body)\n  }');

async function check(name, src, opts = {}) {
  const d = join(OUT, name);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'm.poly'), src);
  return checkFile(join(d, 'm.poly'), { root: d, ...opts });
}
const summary = (r) => r.configurations.map((c) => [c.configuration, c.verdict, [...new Set(c.diagnostics.map((d) => d.code))]]);

// A lamp whose Start arms a timer, and which ends when the timer fires. Its configuration offers only Start, so before
// S206 the timer never fires there and the lamp is stuck (PL5402); with S206 the environment fires it.
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

test('S206, off by default: a declared configuration completes timers through its declared inputs alone (S61), so the lamp is stuck', { timeout: 300_000 }, async () => {
  const r = await check('s206-off', LAMP);
  assert.deepEqual(summary(r), [['room', 'FINDINGS', ['PL5402']]]);
});

test('S206, on: every configuration keeps every instance\'s armed timers, and the environment may fire one while it is armed', { timeout: 300_000 }, async () => {
  const r = await check('s206-on', LAMP, { switches: { s206: true } });
  assert.deepEqual(summary(r), [['room', 'CLEAN', []]]);
});

test('S207, off by default: an application bound to two channels has one generated configuration per channel, in the compiler and in poly-ref', () => {
  const mod = parse(BOTH).module;
  const program = resolveUses(mod, join(OUT, 'm.poly'), undefined, join(ROOT, 'std')).program;
  for (const decls of [expandChannels(mod, program).module.decls, readChannels(mod, program).module.decls]) {
    assert.deepEqual(decls.filter((d) => d.kind === 'Configuration').map((d) => d.name).sort(), ['mail', 'text']);
  }
});

test('S207, on: the application gets one configuration named after it, every conversation live, instances 1 + n and transit the sum of pending, in the compiler and in poly-ref', () => {
  const mod = parse(BOTH).module;
  const program = resolveUses(mod, join(OUT, 'm.poly'), undefined, join(ROOT, 'std')).program;
  const pending = (kind) => program.find((m) => m.name === `std.channels.${kind}`).decls.find((d) => d.kind === 'Machine' && d.name === 'Conversation').fields.find((f) => f.name === 'pending').type.hi;
  for (const decls of [expandChannels(mod, program, { joint: true }).module.decls, readChannels(mod, program, { joint: true }).module.decls]) {
    const configs = decls.filter((d) => d.kind === 'Configuration');
    assert.deepEqual(configs.map((d) => d.name), ['Agent']);
    const [c] = configs;
    assert.deepEqual([c.joint, c.bounds.instances, c.bounds.transit], [['text', 'mail'], 3, pending('sms') + pending('email')]);
    assert.deepEqual(c.inputs.map((i) => `${i.instance}.${i.action}`).filter((x) => !x.startsWith('app.')).map((x) => x.split('.').slice(-2, -1)[0] + '.' + x.split('.').pop()).length > 0, true);
    for (const ch of ['text', 'mail']) assert.ok(c.inputs.some((i) => i.instance === `desk.${ch}.Conversation` && i.action === 'Inbound'), ch);
  }
});
