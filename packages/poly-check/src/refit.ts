// `poly refit` (PF8.6, PS22.2 to PS22.6, PT32.2, PT32.3, S519, S520): a new calibration map from a person's signed verdicts alone.
// Only verified verdicts of the decision and the model are counted; below the floor, or when the map would earn the calibration
// warning of PT24, the refit is refused and says by how much; otherwise the map is the isotonic fit of PD1.6a, one version above
// the map it replaces, written to a file of its own with a signed record beside it. The old map and the sources are never
// edited: the route keeps citing the old map until a person changes its path and the project is admitted again. Admission reads
// the record back (PL6513). Never offered over MCP.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { keyringsOf, loadProject, mapProblem, readAnchor, recordDigest, refitSubject, signRecord, verdictSubject, verifyRecord, type Keyrings, type SignedRecord } from '@poly/core';
import type { CalibrationMap, JournalReader } from '@poly/runtime';
import { AdmitError, personKey } from './admit.js';
import { projectAnchorId } from './adjudicate.js';
import { isotonicPoints } from './evaluate.js';
import { calibrationWarning } from './routing.js';
import { decisionEvents, verdictFilesIn } from './verdict.js';

/** PS22.3: the verdicts a refit of one decision for one model needs. */
export const REFIT_FLOOR = 50;

export interface RefitOptions { reader?: JournalReader; db?: string; decision: string; model: string; verdictsDir: string; previous: string; project: string; by: string; key: string; out: string; synthetic?: boolean; /** Where the project's anchor came from; the command line reads it, a test names it (PS20.5). */ anchorSource?: 'user' | 'test' }
export interface RefitFile { v: 1; kind: 'poly.refit'; map: string; verdicts: string[]; skipped: { file: string; why: string }[]; synthetic?: true; record: SignedRecord }

export async function refitMap(o: RefitOptions): Promise<{ path: string; refit: string; map: CalibrationMap; used: number; skipped: { file: string; why: string }[] }> {
  if (existsSync(o.out)) throw new AdmitError(`${o.out} exists: poly refit does not overwrite a file`);
  const refitPath = o.out.replace(/\.json$/, '') + '.refit.json';
  if (existsSync(refitPath)) throw new AdmitError(`${refitPath} exists: poly refit does not overwrite a file`);
  if (!existsSync(o.previous)) throw new AdmitError(`${o.previous}: no such map`);
  let prev: CalibrationMap;
  try { prev = JSON.parse(readFileSync(o.previous, 'utf8')) as CalibrationMap; } catch { throw new AdmitError(`${o.previous} is not JSON`); }
  const bad = mapProblem(prev);
  if (bad) throw new AdmitError(`the map ${o.previous} to replace ${bad}`);
  if (prev.decision !== o.decision) throw new AdmitError(`the map ${o.previous} is for the decision ${prev.decision}, not ${o.decision}`);
  const rings = keyringsOf(o.project, loadProject(o.project).manifest);
  if (rings.agents.some((a) => a.keyId === o.by)) throw new AdmitError(`${o.by} is an agent key, and an agent key never signs a record of the kind refit (PF9.6, PT12.5)`);
  if (!rings.people.some((p) => p.keyId === o.by)) throw new AdmitError(`${o.by} is not a key in the project's people keyring (PT12.5): a refit is signed with a person's key`);
  // PS20.5: a refit from verdicts made for a test is a test's.
  if (o.synthetic && (o.anchorSource ?? readAnchor(o.project, loadProject(o.project).manifest.name)?.source) !== 'test') throw new AdmitError('--synthetic: verdicts made for the purpose are refitted only for a project with a test anchor, since a certificate that cites a refit from them is a test certificate (PS20.5)');
  const anchor = projectAnchorId(o.project);

  let reader = o.reader;
  let opened = false;
  if (!reader) {
    if (!o.db) throw new AdmitError('poly refit needs --db <store>');
    const { openJournal } = await import('@poly/runtime');
    reader = openJournal(o.db);
    opened = true;
  }
  const used: { x: number; y: number }[] = [];
  const digests: string[] = [];
  const skipped: { file: string; why: string }[] = [];
  try {
    const events = await decisionEvents(reader);
    const seen = new Set<string>();
    for (const file of verdictFilesIn(o.verdictsDir)) {
      const name = basename(file);
      const skip = (why: string) => skipped.push({ file: name, why });
      let v: { v?: number; kind?: string; event?: string; verdict?: string; correct?: unknown; record?: unknown };
      try { v = JSON.parse(readFileSync(file, 'utf8')); } catch { skip('is not JSON'); continue; }
      if (!v || v.kind !== 'poly.verdict' || v.v !== 1 || typeof v.event !== 'string' || (v.verdict !== 'right' && v.verdict !== 'wrong')) { skip('is not a poly.verdict of version 1 (PT32.1)'); continue; }
      const r = verifyRecord(v.record, rings, { kind: 'verdict', subject: verdictSubject(anchor, v.event, v.verdict, v.correct) });
      if (!r.ok) { skip(`does not verify: ${r.problem}`); continue; }
      const e = events.get(v.event);
      if (!e) { skip(`names no decision event ${v.event} in the store`); continue; }
      if (e.decision !== o.decision) { skip(`is a verdict on another decision (${e.decision})`); continue; }
      if (e.model !== o.model) { skip(`is a verdict on another model (${e.model})`); continue; }
      if (seen.has(v.event)) { skip('is a second verdict on an answer already counted'); continue; }
      seen.add(v.event);
      used.push({ x: Math.round(e.raw * 1000), y: v.verdict === 'right' ? 1 : 0 });
      digests.push(r.digest);
    }
  } finally { if (opened) await reader.close(); }

  const head = `refit of ${o.decision} for ${o.model} is refused:`;
  if (used.length < REFIT_FLOOR) throw new AdmitError(`${head} ${used.length} verdicts, the floor is ${REFIT_FLOOR}: ${REFIT_FLOOR - used.length} short (PS22.3)`);
  const body = { decision: o.decision, version: prev.version + 1, fittedFor: o.model, points: isotonicPoints(used) };
  const { mapDigest } = await import('@poly/runtime');
  const map: CalibrationMap = { ...body, digest: mapDigest(body) };
  const warn = calibrationWarning(map);
  if (warn) {
    const band = /the (\d+) raw values/.exec(warn);
    throw new AdmitError(`${head} the map would earn the calibration warning of PT24: ${warn}${band ? ` (${Number(band[1]) - 100} over the 100 it tolerates)` : ''}; the verdicts do not cover the range (PS22.3)`);
  }
  const sorted = [...digests].sort();
  const record = signRecord({ kind: 'refit', subject: refitSubject(anchor, map.digest, sorted), by: o.by, at: new Date().toISOString() }, personKey(o.key));
  const side: RefitFile = { v: 1, kind: 'poly.refit', map: map.digest, verdicts: sorted, skipped, ...(o.synthetic ? { synthetic: true as const } : {}), record };
  writeFileSync(o.out, JSON.stringify(map, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(refitPath, JSON.stringify(side, null, 2) + '\n', { flag: 'wx' });
  return { path: o.out, refit: refitPath, map, used: used.length, skipped };
}

export interface Refit { map: string; digest: string; record: string }
export interface RefitProblem { code: 'PL6513'; entry: string; message: string }

/** PT32.3: every `*.refit.json` under the project's source folders, read back against the map beside it and the certified people ring. */
export function readRefits(project: string, rings: Keyrings, anchorId: string, certificateSource: 'user' | 'test'): { list: Refit[]; problems: RefitProblem[] } {
  const list: Refit[] = [];
  const problems: RefitProblem[] = [];
  const src = join(project, 'src');
  if (!existsSync(src)) return { list, problems };
  const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith('.refit.json')).map((f) => join(src, f)).sort();
  for (const file of files) {
    const rel = relative(project, file).split(sep).join('/');
    const bad = (message: string) => problems.push({ code: 'PL6513', entry: rel, message: `${rel} is a refit record that does not bear out its map: ${message}` });
    let r: Partial<RefitFile>;
    try { r = JSON.parse(readFileSync(file, 'utf8')); } catch { bad('it is not JSON'); continue; }
    if (!r || r.kind !== 'poly.refit' || r.v !== 1 || typeof r.map !== 'string' || !Array.isArray(r.verdicts)) { bad('it is not a poly.refit of version 1 (PT32.2)'); continue; }
    const mapFile = file.replace(/\.refit\.json$/, '.json');
    const mapRel = relative(project, mapFile).split(sep).join('/');
    if (!existsSync(mapFile)) { bad(`the map ${mapRel} beside it does not exist`); continue; }
    let map: unknown;
    try { map = JSON.parse(readFileSync(mapFile, 'utf8')); } catch { bad(`the map ${mapRel} is not JSON`); continue; }
    const problem = mapProblem(map);
    if (problem) { bad(`the map ${mapRel} ${problem}`); continue; }
    if ((map as CalibrationMap).digest !== r.map) { bad(`it names the map ${r.map}, and ${mapRel} has the digest ${(map as CalibrationMap).digest}`); continue; }
    const v = verifyRecord(r.record, rings, { kind: 'refit', subject: refitSubject(anchorId, r.map, r.verdicts as string[]) });
    if (!v.ok) { bad(v.problem); continue; }
    if (r.synthetic === true && certificateSource !== 'test') { bad('it was fitted from synthetic verdicts, which only a test certificate may cite (PS20.5)'); continue; }
    list.push({ map: mapRel, digest: r.map, record: recordDigest(r.record as SignedRecord) });
  }
  return { list, problems };
}
