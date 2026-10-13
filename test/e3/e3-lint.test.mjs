// plan-e3.md S562 (decisions-e3.md): a model decision that names no budget is not a finding of the checker, so this is a
// source lint, not a proof. Every decision of the harness module names the budget, and every tool effect that needs the
// network (the label egress:external, kind tool.*) is one the offline policy denies by kind (S558).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers.mjs';

const DIR = join(ROOT, 'examples', 'harness');
const SRC = readFileSync(join(DIR, 'harness.poly'), 'utf8');
const POLICY = readFileSync(join(DIR, 'harness.policy.poly'), 'utf8');

/** The text of each `kind … {` block of a source: its header line and the body up to the next blank-line-separated block. */
function blocks(src, word) {
  const out = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(`  ${word} `) && lines[i].includes('(') && lines[i].endsWith('{')) {
      let j = i;
      while (j < lines.length && lines[j] !== '  }') j++;
      out.push(lines.slice(i, j + 1).join('\n'));
    }
  }
  return out;
}

test('S562 lint: every decision of the harness names the budget and its price table and limits', () => {
  const ds = blocks(SRC, 'decision');
  assert.ok(ds.length >= 3, 'agent, summarise and read');
  for (const d of ds) assert.match(d, /prices "[^"]+" max input tokens \d+ max tokens \d+ budget task/, d.split('\n')[0]);
});

test('S558 lint: every tool effect that needs the network is denied by kind in the offline policy', () => {
  const net = blocks(SRC, 'effect').filter((e) => /egress:external/.test(e)).map((e) => /kind "([^"]+)"/.exec(e)[1]);
  assert.deepEqual(net, ['tool.fetch'], 'the one tool that needs the network');
  for (const k of net) assert.ok(POLICY.includes(`effect.kind == "${k}"`), `${k} is not in the offline policy`);
});
