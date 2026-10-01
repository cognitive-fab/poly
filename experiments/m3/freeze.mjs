// The freeze of M3 (M3-5, plan-m3 section 8): the SHA-256 of every file of every part of the experiment, written
// to experiments/m3/freeze.json, and one digest per part (over its files' paths and digests, sorted) for the
// plan to record. A file changed after the freeze changes its part's digest, so a deviation cannot pass
// unnoticed. The `toolchain` part (S100) covers what arms 2 to 4 run: poly's package sources (no build output),
// the vendored engines and package-lock.json; freeze.json also records the git commit it was taken from.
// This does not approve anything: a real run also needs experiments/m3/FROZEN, which the owner writes
// on approval (runner/run.mjs).
//
// Usage: node experiments/m3/freeze.mjs [--check]   (--check compares with freeze.json and lists what changed)
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { M3, PRACTICE, taskIds, versions } from './lib/task.mjs';

const ROOT = join(M3, '..', '..');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const rel = (p) => relative(ROOT, p).split('\\').join('/');
const walk = (d) => (existsSync(d) ? readdirSync(d).flatMap((e) => (statSync(join(d, e)).isDirectory() ? walk(join(d, e)) : [join(d, e)])) : []);

/** Build output and installed packages are not sources (S100). */
const BUILD_OUTPUT = new Set(['dist', 'node_modules']);
const sources = (d) => (existsSync(d) ? readdirSync(d).flatMap((e) => {
  const p = join(d, e);
  if (statSync(p).isDirectory()) return BUILD_OUTPUT.has(e) ? [] : sources(p);
  return e.endsWith('.tsbuildinfo') ? [] : [p];
}) : []);

/** The toolchain of arms 2 to 4 under a root (S100): package sources, everything vendored, the lock file. */
export function toolchainFiles(root = ROOT) {
  // Everything under vendor/: a vendored engine's own dist/ is the engine (sam-pattern's SAM.js), not build output.
  return [...sources(join(root, 'packages')), ...walk(join(root, 'vendor')), join(root, 'package-lock.json')];
}

/** The parts of the experiment and their files. */
export function parts({ toolchainRoot = ROOT } = {}) {
  const out = {};
  // The ten tasks, and the practice tasks of the pilot runs.
  const practice = existsSync(PRACTICE) ? readdirSync(PRACTICE).filter((d) => /^P\d+$/.test(d)).sort() : [];
  for (const id of [...taskIds(), ...practice]) {
    for (const v of versions(id)) {
      const own = (f) => join(v.dir, f);
      const files = [own('brief.md'), own('o2.mjs'), own('explore.json'), ...walk(own('reference')), ...walk(own('mutant')), ...walk(own('o3'))];
      if (existsSync(own('host.ts'))) files.push(own('host.ts'));
      out[`${id} v${v.n}`] = files.filter((f) => existsSync(f));
    }
  }
  out['O1 prompt'] = [join(ROOT, 'docs', 'm3', 'o1-prompt.md'), join(M3, 'o1-kit.mjs')];
  out['template'] = walk(join(M3, 'tasks', '_template'));
  out['controls'] = [join(M3, 'controls', 'run.mjs'), join(M3, 'controls', 'o1-check.mjs'), ...walk(join(M3, 'lib')), join(M3, 'o3', 'generate.mjs')];
  out['adapter'] = [join(M3, 'adapter', 'generate.mjs'), join(M3, 'adapter', 'README.md')];
  out['runner and prompts'] = [...walk(join(M3, 'runner')), ...walk(join(M3, 'prompts'))];
  out['analysis'] = walk(join(M3, 'analysis'));
  out['toolchain'] = toolchainFiles(toolchainRoot).map((f) => ({ file: f, as: relative(toolchainRoot, f) }));
  return out;
}

/** The digests; `toolchainRoot` reads the toolchain part from another tree, as the test does with a copy. */
export function manifest({ toolchainRoot = ROOT } = {}) {
  const files = {};
  const digests = {};
  for (const [part, list] of Object.entries(parts({ toolchainRoot }))) {
    // A toolchain file is named by its path under its root, so a copy of the tree digests alike.
    const entries = list.map((f) => (typeof f === 'string' ? [rel(f), sha(readFileSync(f))] : [f.as.split('\\').join('/'), sha(readFileSync(f.file))])).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (const [p, d] of entries) files[p] = d;
    digests[part] = sha(entries.map(([p, d]) => `${p} ${d}\n`).join(''));
  }
  return { commit: execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), parts: digests, files };
}

/** The parts whose digest differs between two manifests, sorted. */
export function changedParts(a, b) {
  return [...new Set([...Object.keys(a.parts), ...Object.keys(b.parts)])].filter((p) => a.parts[p] !== b.parts[p]).sort();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const m = manifest();
  const file = join(M3, 'freeze.json');
  if (process.argv.includes('--check')) {
    const old = JSON.parse(readFileSync(file, 'utf8'));
    const changed = Object.keys({ ...old.files, ...m.files }).filter((f) => old.files[f] !== m.files[f]).sort();
    for (const p of changedParts(old, m)) console.log(`part changed since the freeze: ${p}`);
    for (const f of changed) console.log(`changed since the freeze: ${f}`);
    process.exitCode = changed.length ? 1 : 0;
  } else {
    writeFileSync(file, JSON.stringify(m, null, 2) + '\n');
    for (const [p, d] of Object.entries(m.parts)) console.log(`| ${p} | \`${d.slice(0, 16)}\` |`);
  }
}
