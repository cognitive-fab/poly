#!/usr/bin/env node
// DF8, Q11: the demo copy of the concierge. The program, the policy, the calibration maps and the price tables are examples/concierge
// as released; the copy changes the budget's two cap lines (the example's are the tests' own, the demo's are set for a room and a
// bill) and nothing else. The copy is produced by this script and the demo prints the diff against the example, so the audience
// sees what differs. The price tables are the example's placeholders until the owner reads the vendor's page (price-gate.mjs).
//
//   node demo/scripts/make-demo-concierge.mjs            writes demo/concierge/ and prints the diff
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXAMPLE = join(ROOT, 'examples', 'concierge');

/** The files of the example that the copy holds (not its host code, its README or its folder of tests). */
const SUBSET = ['concierge.poly', 'concierge.policy.poly', 'maps', 'prices'];

/** The budget's caps, in dollars: the example's (the tests' own) and the demo's (a run of the room, and a day). */
export const DEMO_CAPS = {
  example: { run: '0.5', day: '20' },
  demo: { run: '0.25', day: '10' },
};

const walk = (d) => readdirSync(d).flatMap((e) => (statSync(join(d, e)).isDirectory() ? walk(join(d, e)) : [join(d, e)]));

function once(text, from, to) {
  if (text.split(from).length !== 2) throw new Error(`the example no longer holds "${from.trim()}" exactly once`);
  return text.replace(from, () => to);
}

/** Writes the copy to `out` and returns { changed, diff }: the files that differ from the example, and the diff as text. */
export function makeDemoConcierge({ out = join(ROOT, 'demo', 'concierge') } = {}) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const f of SUBSET) cpSync(join(EXAMPLE, f), join(out, f), { recursive: true });
  const program = join(out, 'concierge.poly');
  let text = readFileSync(program, 'utf8');
  text = once(text, `  cap usd ${DEMO_CAPS.example.run} per run`, `  cap usd ${DEMO_CAPS.demo.run} per run`);
  text = once(text, `  cap usd ${DEMO_CAPS.example.day} per day per scope`, `  cap usd ${DEMO_CAPS.demo.day} per day per scope`);
  writeFileSync(program, text);

  // The diff against the example's own files, under the names a reader knows them by.
  const stage = mkdtempSync(join(tmpdir(), 'demo-diff-'));
  try {
    for (const f of SUBSET) cpSync(join(EXAMPLE, f), join(stage, 'examples', 'concierge', f), { recursive: true });
    cpSync(out, join(stage, 'demo', 'concierge'), { recursive: true });
    let raw = '';
    try {
      raw = execFileSync('git', ['diff', '--no-index', '--no-color', '--', 'examples/concierge', 'demo/concierge'], { cwd: stage, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      // git exits 1 when the trees differ, with the diff on standard output.
      if (e.status !== 1) throw e;
      raw = e.stdout;
    }
    const diff = raw.replace(/^index [0-9a-f]+\.\.[0-9a-f]+.*\n/gm, '');
    const changed = [...new Set([...raw.matchAll(/^diff --git a\/examples\/concierge\/(\S+) b\//gm)].map((m) => m[1]))];
    return { changed, diff };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { changed, diff } = makeDemoConcierge();
  console.log(`demo/concierge written; ${changed.length} file(s) differ from examples/concierge: ${changed.join(', ') || 'none'}\n`);
  console.log(diff);
}
