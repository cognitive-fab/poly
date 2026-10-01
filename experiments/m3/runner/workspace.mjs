// The workspace of one run (plan-m3 section 6): a fresh directory under the system temporary directory that
// holds the brief, the host interface, a package.json and the arm's tools, and nothing from a task's
// reference, O2, O3 or O1. Every file put there is listed, so the dry run can check what an arm could read.
//
// The poly arms get poly's manual and toolchain; examples that model a task family closely (the field studies,
// the checkout, the OMS order) are left out, so no arm starts from a near-answer. Arm 2 gets polygraph at the
// commit poly vendors. The experiment's own design (PT13) is cut from the manual.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { M3 } from '../lib/task.mjs';

export const ROOT = join(M3, '..', '..');
/** polygraph as arm 2 gets it: the commit poly vendors (vendor/polygraph/PROVENANCE.md). */
export const POLYGRAPH = { repo: 'C:/Users/jjdub/code/polygraph', commit: '4949de4' };
const POLY_EXAMPLES = ['hello', 'delivery', 'evidence'];
const EMBED_EXAMPLES = ['turnstile.ts', 'workshop.ts'];

const write = (ws, rel, text) => { mkdirSync(dirname(join(ws, rel)), { recursive: true }); writeFileSync(join(ws, rel), text); };
const copy = (ws, rel, from) => { mkdirSync(dirname(join(ws, rel)), { recursive: true }); cpSync(from, join(ws, rel), { recursive: true }); };

/** The technical spec without PT13, the experiment's own design. */
function specWithoutPT13() {
  const text = readFileSync(join(ROOT, 'docs', '03-technical-spec.md'), 'utf8');
  const a = text.indexOf('## PT13.');
  const b = text.indexOf('## PT14.');
  if (a < 0 || b < a) throw new Error('03-technical-spec.md: PT13 not found');
  return text.slice(0, a) + text.slice(b);
}

/** A package of the poly toolchain as node_modules holds it: its package.json and dist. */
function copyPolyPackage(ws, dir, name) {
  copy(ws, `node_modules/@poly/${name}/package.json`, join(ROOT, 'packages', dir, 'package.json'));
  copy(ws, `node_modules/@poly/${name}/dist`, join(ROOT, 'packages', dir, 'dist'));
}

/**
 * Builds the workspace of `arm` (1 to 4) for version 0 of a task: `version` is lib/task's version 0. Returns
 * { ws, files } with every file written, relative to ws.
 */
export function makeWorkspace(ws, arm, version) {
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });
  write(ws, 'BRIEF.md', readFileSync(version.briefs[0], 'utf8'));
  copy(ws, 'host.ts', version.hostFile);
  copy(ws, 'node_modules/typescript', join(ROOT, 'node_modules', 'typescript'));
  const scripts = { test: 'node --test' };
  if (arm === 2) {
    // git archive of the pinned commit: nothing of the owner's working tree, nothing from poly.
    const into = join(ws, 'tools', 'polygraph');
    mkdirSync(into, { recursive: true });
    execFileSync('git', ['-C', POLYGRAPH.repo, 'archive', '--format=tar', '-o', join(into, 'polygraph.tar'), POLYGRAPH.commit, 'README.md', 'package.json', 'scripts', 'skills', 'polyrun/src', 'LICENSE']);
    // A relative archive path: GNU tar reads "C:" in an absolute Windows path as a remote host.
    execFileSync('tar', ['-xf', 'polygraph.tar'], { cwd: into });
    rmSync(join(into, 'polygraph.tar'));
  }
  if (arm === 3 || arm === 4) {
    const entry = arm === 3 ? 'src/system.poly' : 'src/system.ts';
    for (const [dir, name] of [['poly-core', 'core'], ['poly-lang', 'lang'], ['poly-lower', 'lower'], ['poly-ref', 'ref'], ['poly-embed', 'embed'], ['poly-check', 'check']]) copyPolyPackage(ws, dir, name);
    copy(ws, 'node_modules/@cognitive-fab/polygraph', join(ROOT, 'vendor', 'polygraph'));
    copy(ws, 'node_modules/@cognitive-fab/sam-pattern', join(ROOT, 'vendor', 'sam-pattern'));
    copy(ws, 'tools/adapter/generate.mjs', join(M3, 'adapter', 'generate.mjs'));
    copy(ws, 'host.map.schema.json', join(M3, 'tasks', '_template', 'host.map.schema.json'));
    write(ws, 'tools/poly/README.md', readFileSync(join(ROOT, 'README.md'), 'utf8'));
    write(ws, 'tools/poly/docs/03-technical-spec.md', specWithoutPT13());
    copy(ws, 'tools/poly/docs/04-semantics.md', join(ROOT, 'docs', '04-semantics.md'));
    for (const e of POLY_EXAMPLES) copy(ws, `tools/poly/examples/${e}`, join(ROOT, 'examples', e));
    if (arm === 4) {
      copy(ws, 'tools/poly/embed/index.d.ts', join(ROOT, 'packages', 'poly-embed', 'embed', 'index.d.ts'));
      for (const e of EMBED_EXAMPLES) copy(ws, `tools/poly/examples/embedded/${e}`, join(ROOT, 'conformance', 'm2', 'embed', e));
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
