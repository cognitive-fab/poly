// Assembles the workspace of the O1 session (M3-1): the prompt, and for each task and version the brief as
// changed so far and the host interface, nothing else. No reference, mapping, O2, O3 or arm output is copied,
// and the kit is written outside the repository so the session cannot read around it.
//
// Usage: node experiments/m3/o1-kit.mjs [<dir>]   (default: <tmp>/poly-m3-o1-kit)
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { M3, taskIds, versions } from './lib/task.mjs';

export function buildKit(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(M3, '..', '..', 'docs', 'm3', 'o1-prompt.md'), join(dir, 'PROMPT.md'));
  for (const id of taskIds()) {
    for (const v of versions(id)) {
      const out = join(dir, id, `v${v.n}`);
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'brief.md'), v.briefs.map((b) => readFileSync(b, 'utf8').trimEnd()).join('\n\n') + '\n');
      copyFileSync(v.hostFile, join(out, 'host.ts'));
    }
  }
  return dir;
}

/** Every file of the kit, relative to it. */
export function kitFiles(dir) {
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else out.push(relative(dir, p).split('\\').join('/')); } };
  walk(dir);
  return out.sort();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const dir = buildKit(process.argv[2] ?? join(tmpdir(), 'poly-m3-o1-kit'));
  console.log(`O1 kit: ${kitFiles(dir).length} files in ${dir}`);
}
