// PS15.5, as ruled on step 10: the generated configuration of a channel offers the firing of each armed timer of the
// conversation, and only of an armed one. A cancel disarms a key, an after on an armed key re-arms it, and a firing
// disarms it first. Checked on the concierge's support configuration, where Inbound cancels and re-arms the window's
// timer: no firing of WindowExpired is taken from a state where the timer is not armed. The seeded control, a
// configuration that fires disarmed timers (fault fire-disarmed), has such a firing, so the test would fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@poly/lang';
import { resolveUses } from '@poly/check';
import { checkConfiguration } from '@poly/ref';
import { ROOT } from './helpers.mjs';

const FILE = join(ROOT, 'conformance', 'm8', 'concierge', 'concierge.poly');
function support(fault) {
  const mod = parse(readFileSync(FILE, 'utf8')).module;
  return checkConfiguration(mod, 'support', { program: resolveUses(mod, FILE).program, ...(fault ? { fault } : {}) });
}
const armedIn = (s, k, key) => (s.timers ?? []).some((t) => t.instance === k && t.key === key);

test('PS15.5: a cancelled or never-armed timer never fires: every WindowExpired is taken from a state where w is armed, and disarms it', { timeout: 600_000 }, async () => {
  const r = support();
  const k = r.instances.findIndex((i) => i.machine.id === 'concierge.support.Conversation');
  const firings = r.graph.edges.filter((e) => e.label.instance === k && e.label.action === 'WindowExpired');
  assert.ok(firings.length > 0, 'the timer fires');
  for (const e of firings) {
    assert.ok(armedIn(r.graph.states[e.from], k, 'w'), 'armed before');
    if (e.outcome.kind === 'state') assert.ok(!armedIn(e.outcome.state, k, 'w'), 'disarmed after');
  }
  // One pending firing per key: no state holds w twice.
  for (const s of r.graph.states) assert.ok((s.timers ?? []).filter((t) => t.instance === k && t.key === 'w').length <= 1);
});

test('PS15.5, seeded control: a configuration that fires disarmed timers takes WindowExpired where w is not armed', { timeout: 600_000 }, async () => {
  const r = support('fire-disarmed');
  const k = r.instances.findIndex((i) => i.machine.id === 'concierge.support.Conversation');
  assert.ok(r.graph.edges.some((e) => e.label.instance === k && e.label.action === 'WindowExpired' && !armedIn(r.graph.states[e.from], k, 'w')));
});
