// M3-9: O1 enters the freeze as a part of its own, and o1-check lists only the flags LEAKS.md gives under each task
// and version, not its preamble.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { changedParts, manifest } from '../experiments/m3/freeze.mjs';
import { leakFlags } from '../experiments/m3/controls/o1-check.mjs';
import { M3 } from '../experiments/m3/lib/task.mjs';

test('M3-9: the O1 part covers every file under experiments/m3/o1/, and a changed byte in a suite changes only it', () => {
  const before = manifest();
  assert.ok('O1' in before.parts);
  const frozen = Object.keys(before.files).filter((f) => f.startsWith('experiments/m3/o1/')).sort();
  // Every file at any depth, listed independently of freeze.mjs.
  const onDisk = readdirSync(join(M3, 'o1'), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => `experiments/m3/o1/${relative(join(M3, 'o1'), join(e.parentPath, e.name)).split('\\').join('/')}`).sort();
  assert.deepEqual(frozen, onDisk);
  const copy = mkdtempSync(join(tmpdir(), 'poly-o1-'));
  try {
    cpSync(join(M3, 'o1'), copy, { recursive: true });
    assert.deepEqual(changedParts(before, manifest({ o1Dir: copy })), []);
    const victim = join(copy, 'T1', 'v0.test.mjs');
    const text = readFileSync(victim);
    text[text.length - 1] = text[text.length - 1] === 0x0a ? 0x20 : 0x0a;
    writeFileSync(victim, text);
    assert.deepEqual(changedParts(before, manifest({ o1Dir: copy })), ['O1']);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test('M3-9: o1-check lists only the flags under each task and version, not the preamble', () => {
  const flags = leakFlags(readFileSync(join(M3, 'o1', 'LEAKS.md'), 'utf8'));
  assert.deepEqual(flags.map((f) => `${f.task} v${f.version}`), ['T10 v0', 'T10 v1', 'T10 v2', 'T10 v3']);
  for (const f of flags) assert.match(f.flag, /^- "A `Revoked` can arrive before the `Granted` it revokes/);
  // A flag on several lines stays one flag, and `none` is no flag.
  const text = '# Leaks\n\nPreamble that is not a flag.\n\n## T1\n### v0\nnone\n### v1\n- "First sentence" (a reason\n  that continues)\n- "Second"\n## T2\n### v0\n- none\n';
  assert.deepEqual(leakFlags(text), [
    { task: 'T1', version: 1, flag: '- "First sentence" (a reason that continues)' },
    { task: 'T1', version: 1, flag: '- "Second"' },
  ]);
});
