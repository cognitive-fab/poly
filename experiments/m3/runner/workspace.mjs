// The workspace of one run (plan-m3 section 6): a fresh directory under the system temporary directory that
// holds the brief, the host interface, a package.json and the arm's tools, and nothing from a task's
// reference, O2, O3 or O1. Every file put there is listed, so the dry run can check what an arm could read.
//
// The poly arms get poly's manual and toolchain; examples that model a task family closely (the field studies,
// the checkout, the OMS order) are left out, so no arm starts from a near-answer. Arm 2 gets polygraph at the
// commit poly vendors. The experiment's own design (PT13) is cut from the manual.
//
// Every file copied in comes from the list workspaceSources and changeSources return (S114), and the freeze
// covers every one of them (test/m3-manual.test.mjs). The manual is the snapshot in experiments/m3/manual/,
// taken at the freeze commit 04c62e8, never the live docs/: it then describes exactly the toolchain the arms run.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { M3 } from '../lib/task.mjs';

export const ROOT = join(M3, '..', '..');
/** polygraph as arm 2 gets it: the commit poly vendors (vendor/polygraph/PROVENANCE.md). */
export const POLYGRAPH = { repo: 'C:/Users/jjdub/code/polygraph', commit: '4949de4', paths: ['README.md', 'package.json', 'scripts', 'skills', 'polyrun/src', 'LICENSE'] };
/** poly's manual as the poly arms read it (S114): README.md, docs/03-technical-spec.md and docs/04-semantics.md at 04c62e8. */
export const MANUAL = join(M3, 'manual');
export const POLY_PACKAGES = [['poly-core', 'core'], ['poly-lang', 'lang'], ['poly-lower', 'lower'], ['poly-ref', 'ref'], ['poly-embed', 'embed'], ['poly-check', 'check']];
export const POLY_EXAMPLES = ['hello', 'delivery', 'evidence'];
export const EMBED_EXAMPLES = ['turnstile.ts', 'workshop.ts'];

const write = (ws, rel, text) => { mkdirSync(dirname(join(ws, rel)), { recursive: true }); writeFileSync(join(ws, rel), text); };
const copy = (ws, rel, from, filter) => { mkdirSync(dirname(join(ws, rel)), { recursive: true }); cpSync(from, join(ws, rel), { recursive: true, filter }); };

/**
 * A package's dist without tsc's incremental bookkeeping: nothing in a workspace reads a .tsbuildinfo, and it
 * differs between a clean build and an incremental one of the same sources (measured), so it cannot be frozen.
 */
export const notBuildInfo = (p) => !p.endsWith('.tsbuildinfo');

/** The technical spec without PT13, the experiment's own design. */
function withoutPT13(text) {
  const a = text.indexOf('## PT13.');
  const b = text.indexOf('## PT14.');
  if (a < 0 || b < a) throw new Error('03-technical-spec.md: PT13 not found');
  return text.slice(0, a) + text.slice(b);
}

/** polygraph at the pinned commit, by git archive, into a directory: nothing of the owner's working tree, nothing from poly. */
export function extractPolygraph(into) {
  mkdirSync(into, { recursive: true });
  execFileSync('git', ['-C', POLYGRAPH.repo, 'archive', '--format=tar', '-o', join(into, 'polygraph.tar'), POLYGRAPH.commit, ...POLYGRAPH.paths]);
  // A relative archive path: GNU tar reads "C:" in an absolute Windows path as a remote host.
  execFileSync('tar', ['-xf', 'polygraph.tar'], { cwd: into });
  rmSync(join(into, 'polygraph.tar'));
}

/**
 * Every file the runner copies into the workspace of `arm` (1 to 4) for version 0 of a task (S114): { to, from }
 * with `from` a file or a directory, `filter` when only some of a directory's files are copied, `edit` when the
 * text is changed on the way, and { to, git } for arm 2's
 * polygraph. The runner writes package.json, and tsconfig.json for arm 4, itself.
 */
export function workspaceSources(arm, version) {
  const out = [
    { to: 'BRIEF.md', from: version.briefs[0] },
    { to: 'host.ts', from: version.hostFile },
    { to: 'node_modules/typescript', from: join(ROOT, 'node_modules', 'typescript') },
  ];
  if (arm === 2) out.push({ to: 'tools/polygraph', git: POLYGRAPH });
  if (arm === 3 || arm === 4) {
    // A package of the poly toolchain as node_modules holds it: its package.json and dist.
    for (const [dir, name] of POLY_PACKAGES) {
      out.push({ to: `node_modules/@poly/${name}/package.json`, from: join(ROOT, 'packages', dir, 'package.json') });
      out.push({ to: `node_modules/@poly/${name}/dist`, from: join(ROOT, 'packages', dir, 'dist'), filter: notBuildInfo });
    }
    out.push(
      { to: 'node_modules/@cognitive-fab/polygraph', from: join(ROOT, 'vendor', 'polygraph') },
      { to: 'node_modules/@cognitive-fab/sam-pattern', from: join(ROOT, 'vendor', 'sam-pattern') },
      { to: 'tools/adapter/generate.mjs', from: join(M3, 'adapter', 'generate.mjs') },
      { to: 'host.map.schema.json', from: join(M3, 'tasks', '_template', 'host.map.schema.json') },
      { to: 'tools/poly/README.md', from: join(MANUAL, 'README.md') },
      { to: 'tools/poly/docs/03-technical-spec.md', from: join(MANUAL, 'docs', '03-technical-spec.md'), edit: withoutPT13 },
      { to: 'tools/poly/docs/04-semantics.md', from: join(MANUAL, 'docs', '04-semantics.md') },
    );
    for (const e of POLY_EXAMPLES) out.push({ to: `tools/poly/examples/${e}`, from: join(ROOT, 'examples', e) });
    if (arm === 4) {
      out.push({ to: 'tools/poly/embed/index.d.ts', from: join(ROOT, 'packages', 'poly-embed', 'embed', 'index.d.ts') });
      for (const e of EMBED_EXAMPLES) out.push({ to: `tools/poly/examples/embedded/${e}`, from: join(ROOT, 'conformance', 'm2', 'embed', e) });
    }
  }
  return out;
}

/** The files the runner copies in when a change starts (version n > 0): the version's host interface and the change's brief. */
export function changeSources(version) {
  return [{ to: 'host.ts', from: version.hostFile }, { to: `CHANGE-${version.n}.md`, from: version.briefs[version.n] }];
}

/**
 * Builds the workspace of `arm` (1 to 4) for version 0 of a task: `version` is lib/task's version 0. Returns
 * { ws, files } with every file written, relative to ws.
 */
export function makeWorkspace(ws, arm, version) {
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });
  for (const s of workspaceSources(arm, version)) {
    if (s.git) extractPolygraph(join(ws, s.to));
    else if (s.edit) write(ws, s.to, s.edit(readFileSync(s.from, 'utf8')));
    else copy(ws, s.to, s.from, s.filter);
  }
  const scripts = { test: 'node --test' };
  if (arm === 3 || arm === 4) {
    const entry = arm === 3 ? 'src/system.poly' : 'src/system.ts';
    if (arm === 4) {
      write(ws, 'tsconfig.json', JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, types: [], paths: { '@cognitive-fab/poly/embed': ['./tools/poly/embed/index.d.ts'] } },
        include: ['src/*.ts'],
      }, null, 2) + '\n');
    }
    scripts.poly = 'node node_modules/@poly/check/dist/src/cli.js';
    scripts.adapter = `node tools/adapter/generate.mjs --map host.map.json --host host.ts --module ${entry} --out build`;
  }
  write(ws, 'package.json', JSON.stringify({ name: 'solution', private: true, type: 'module', scripts }, null, 2) + '\n');
  return { ws, files: listFiles(ws) };
}

/** Every file under a directory, relative to it, node_modules and tools summarised by their top directories. */
export function listFiles(dir, rel = '') {
  const out = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, p));
    else out.push(p);
  }
  return out.sort();
}

/** The files a delivery consists of, for an arm. */
export function deliveryFiles(arm) {
  return arm <= 2 ? ['src'] : ['src', 'host.map.json'];
}

/** Copies an arm's delivery out of the workspace. Returns the files copied. */
export function takeDelivery(ws, arm, to) {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  const taken = [];
  for (const f of deliveryFiles(arm)) if (existsSync(join(ws, f))) { cpSync(join(ws, f), join(to, f), { recursive: true }); taken.push(f); }
  return taken;
}
