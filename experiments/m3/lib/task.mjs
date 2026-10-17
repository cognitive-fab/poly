// A task's versions and their files (PT13, S92), and the adapter of a version's reference or mutant (M3-4).
//
// Version 0 is the task's directory; version n is changes/n. A version has its own reference/, mutant/,
// o2.mjs, explore.json and o3/. host.ts is the nearest one at or before the version, since a change gives a
// new interface only when the interface changes. The brief an arm reads for version n is the base brief
// followed by the deltas of changes 1 to n.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generate } from '../adapter/generate.mjs';

export const M3 = fileURLToPath(new URL('..', import.meta.url));
export const TASKS = join(M3, 'tasks');
/** Practice tasks (P1, ...) for pilot runs: outside the ten, never scored with them. */
export const PRACTICE = join(M3, 'practice');
const rootOf = (id) => join(/^P\d+$/.test(id) ? PRACTICE : TASKS, id);
/** poly's vendored polyrun, by file URL, so an adapter generated outside the repository resolves it. */
export const POLYRUN = pathToFileURL(join(M3, '..', '..', 'vendor', 'polygraph', 'polyrun', 'src', 'index.mjs')).href;

/** The ids of the tasks, in order (T1 to T10); the template is not a task. */
export function taskIds() {
  return readdirSync(TASKS).filter((d) => /^T\d+$/.test(d)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

/** The versions of a task: [{ n, dir, hostFile, briefs }]. */
export function versions(id) {
  const root = rootOf(id);
  const out = [];
  let hostFile = join(root, 'host.ts');
  const briefs = [join(root, 'brief.md')];
  out.push({ task: id, n: 0, dir: root, hostFile, briefs: [...briefs] });
  for (let n = 1; existsSync(join(root, 'changes', String(n))); n++) {
    const dir = join(root, 'changes', String(n));
    if (existsSync(join(dir, 'host.ts'))) hostFile = join(dir, 'host.ts');
    briefs.push(join(dir, 'brief.md'));
    out.push({ task: id, n, dir, hostFile, briefs: [...briefs] });
  }
  return out;
}

/**
 * The frozen sources of M3 predate PL6304 (013d23f1): an effect that reaches outside the program (egress:external or egress:public) and states no class is
 * refused. The frozen files are evidence and are not edited. A source that has such an effect is built from a copy in which each of them says
 * `class reversible` (the one line the rule asks for; none of these effects is retried more than once, so the retry-safety rule is not engaged). A source
 * that has none is used where it is.
 */
export function migrateClasses(text) {
  let out = '';
  let at = 0;
  for (const m of text.matchAll(/^( *)effect [^\n]*\{\n/gm)) {
    if (m.index < at) continue;
    let depth = 1;
    let end = m.index + m[0].length;
    while (depth > 0 && end < text.length) { if (text[end] === '{') depth++; else if (text[end] === '}') depth--; end++; }
    const body = text.slice(m.index, end);
    const labels = /^( *)labels \{ egress:(?:external|public)[^}]*\}\n/m.exec(body);
    out += text.slice(at, m.index);
    out += labels && !/^ *class /m.test(body) ? body.replace(labels[0], () => `${labels[0]}${labels[1]}class reversible\n`) : body;
    at = end;
  }
  return out + text.slice(at);
}

/** The poly module of a version's reference or mutant: the one .poly file there (or its migrated copy, see migrateClasses). */
export function moduleOf(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.poly'));
  if (files.length !== 1) throw new Error(`${dir}: expected one .poly file, found ${files.length}`);
  const file = join(dir, files[0]);
  const text = readFileSync(file, 'utf8');
  const migrated = migrateClasses(text);
  if (migrated === text) return file;
  const copy = join(tmpdir(), 'poly-m3', 'migrated', createHash('sha256').update(file).digest('hex').slice(0, 12), files[0]);
  mkdirSync(join(copy, '..'), { recursive: true });
  writeFileSync(copy, migrated);
  return copy;
}

/** The map of a reference or mutant: its own host.map.json, or else the reference's. */
export function mapOf(version, which) {
  const own = join(version.dir, which, 'host.map.json');
  return existsSync(own) ? own : join(version.dir, 'reference', 'host.map.json');
}

let built = 0;
/**
 * Generates the adapter of a version's reference or mutant into a fresh directory under the system temporary
 * directory, and returns its factory. A failed build throws, with the generator's errors.
 */
export async function adapterOf(version, which = 'reference') {
  const out = join(tmpdir(), 'poly-m3', `${version.task}-v${version.n}-${which}-${process.pid}-${++built}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const r = generate({ mapFile: mapOf(version, which), hostFile: version.hostFile, moduleFile: moduleOf(join(version.dir, which)), out, polyrun: POLYRUN });
  if (r.errors) throw new Error(`${version.task} v${version.n} ${which}: failed build\n${r.errors.join('\n')}`);
  return (await import(pathToFileURL(join(out, 'host.gen.ts')).href)).default;
}

export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** A version's O3, stored gzipped (o3/traces.json.gz): the traces repeat their states, so the file packs well. */
export const O3_FILE = 'traces.json.gz';
export const o3Path = (version) => join(version.dir, 'o3', O3_FILE);
export const readO3 = (version) => JSON.parse(gunzipSync(readFileSync(o3Path(version))).toString('utf8'));
export const writeO3 = (version, o3) => { mkdirSync(join(version.dir, 'o3'), { recursive: true }); writeFileSync(o3Path(version), gzipSync(JSON.stringify(o3) + '\n', { level: 9 })); };
