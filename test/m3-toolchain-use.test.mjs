// The pilot report's ruling (d28afc3), point 3: the scorer counts the diagnostics a poly arm saw only in the output
// of poly commands, never in what the agent read in the manual. Arm 3's pilot read the technical spec, which names
// PL5401 CONFIGURATION_INVARIANT; its one-machine module cannot raise it, so it must not be counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { M3 } from '../experiments/m3/lib/task.mjs';
import { toolchainUse } from '../experiments/m3/runner/score.mjs';

const line = (event) => JSON.stringify({ type: 'stream', event });
const use = (id, name, input) => line({ type: 'assistant', message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, text) => line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });

test('arm 3\'s pilot: codes read in the manual are not counted', () => {
  const r = toolchainUse(readFileSync(join(M3, 'pilots', 'P1-arm3-run1', 'journal.jsonl'), 'utf8'));
  assert.equal(r.codes.PL5401, undefined, JSON.stringify(r.codes));
});

test('codes and fixes are counted from poly commands only', () => {
  const journal = [
    use('t1', 'Read', { file_path: 'tools/poly/docs/03-technical-spec.md' }),
    result('t1', 'PL5401 CONFIGURATION_INVARIANT ... PL3201 DEADLOCK ... fix enter-charging-status@0123456789ab'),
    use('t2', 'Bash', { command: 'npm run --silent poly -- check src/system.poly' }),
    result('t2', 'system.poly:5  PL3201 DEADLOCK  Book\n  fixes: [enter-lent-status@abcdefabcdef]\nverdict: FINDINGS'),
    use('t3', 'Bash', { command: 'npm run poly -- fix src/system.poly enter-lent-status@abcdefabcdef' }),
    result('t3', 'applied enter-lent-status@abcdefabcdef'),
    use('t4', 'Grep', { pattern: 'PL4001' }),
    result('t4', 'docs: PL4001 PATH_PROPERTY'),
  ].join('\n');
  const r = toolchainUse(journal);
  assert.deepEqual(r.codes, { PL3201: 1 });
  assert.equal(r.fixesOffered, 1);
  assert.equal(r.fixesApplied, 1);
});
