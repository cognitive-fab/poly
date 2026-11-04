// S586, RT15: writes v1.5.1-untagged.json, the record of every policy source of examples/, demo/ and conformance/ as
// the toolchain of the tag v1.5.1 makes it (untagged-policies.mjs says what is recorded). It was run once, from a
// detached worktree of v1.5.1 built with its own packages (`git worktree add --detach <dir> v1.5.1`, node_modules
// linking @poly/* and @cognitive-fab/* to that worktree's packages and vendor/, and `tsc -b`), with this file and
// untagged-policies.mjs copied into its test/fixtures/s586/:
//   node --import ./test/fixtures/home-guard.mjs --env-file=test/fixtures/serial-heap.env test/fixtures/s586/record-v151.mjs <out>
// The first comparison on this tree found the model checker's progress lines, which depend on the clock, in three
// outputs (the inbox and the two concierges); they were then removed from the recorded outputs, line by line, with the
// pattern QUIET of untagged-policies.mjs, which the recorder now applies itself. Nothing else of the record was changed.
// No source of the three folders changed between v1.5.1 and the commit the tests were written at, so the list of
// sources is the same on both trees.
import '../home-guard.mjs';
import { recordAll, policySources } from './untagged-policies.mjs';

const out = process.argv[2];
if (!out) throw new Error('usage: record-v151.mjs <out.json>');
const files = policySources();
const records = await recordAll(files, out);
console.log(`${records.length} policy sources recorded to ${out}`);
