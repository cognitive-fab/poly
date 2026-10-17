// The frozen sources of M3 are evidence and are not edited: experiments/m3 is frozen, and so is experiments/m3/lib (test/m3-freeze-eol.test.mjs
// requires that no evidence part changes). They predate PL6304 (013d23f1), which refuses an effect that reaches outside the program (egress:external
// or egress:public) and states no class. The tests that build them with today's checker take a migrated copy from here instead: each such effect
// says `class reversible`, the one line the rule asks for. None of these effects is retried more than once, so the retry-safety rule is not engaged.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { POLYRUN, mapOf } from '../experiments/m3/lib/task.mjs';
import { generate } from '../experiments/m3/adapter/generate.mjs';

/** The text with `class reversible` added to each egress effect that has no class. */
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

/** The module of a version's reference or mutant (the one .poly file in `dir`), or its migrated copy when it has an effect to migrate. */
export function migratedModule(dir) {
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

let built = 0;
/** experiments/m3/lib/task.mjs adapterOf, built from the migrated module. */
export async function adapterOfMigrated(version, which = 'reference') {
  const out = join(tmpdir(), 'poly-m3', `${version.task}-v${version.n}-${which}-migrated-${process.pid}-${++built}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const r = generate({ mapFile: mapOf(version, which), hostFile: version.hostFile, moduleFile: migratedModule(join(version.dir, which)), out, polyrun: POLYRUN });
  if (r.errors) throw new Error(`${version.task} v${version.n} ${which}: failed build\n${r.errors.join('\n')}`);
  return (await import(pathToFileURL(join(out, 'host.gen.ts')).href)).default;
}
