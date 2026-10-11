// `poly adjudicate` (PF9.6, PS20.3, PT30.4, S512): a person's verdict on one candidate rule, signed with a key given by
// file. The record binds the project's anchor, the candidate's digest and the verdict, so it cannot be moved to another
// project, another candidate or another verdict. An agent's key never signs it, and the verdict `narrowed` is no verdict
// in M7. Never offered over MCP.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { adjudicationSubject, keyringsOf, loadProject, readAnchor, signRecord, type SignedRecord } from '@poly/core';
import { AdmitError, personKey } from './admit.js';
import { candidateDigest } from './mine.js';

export const VERDICTS = ['real', 'spurious', 'defer'] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface AdjudicateOptions { candidates: string; candidate: string; verdict: string; by: string; key: string; project?: string; out: string }
export interface AdjudicationFile { v: 1; kind: 'poly.adjudication'; candidate: string; id: string; verdict: Verdict; record: SignedRecord }

/** The anchor id of a project, for a record to be bound to (S321). */
export function projectAnchorId(project: string): string {
  const { manifest } = loadProject(project);
  const a = readAnchor(project, manifest.name);
  if (!a) throw new AdmitError(`${project} has no keyring anchor, so a record cannot be bound to it (S321): anchor it with poly anchor keyrings`);
  return a.anchor.id;
}

/** The candidates file, read and its digests recomputed (PS20.1): a candidate whose digest is not its own is refused. */
export function readCandidates(file: string): { candidates: Record<string, unknown>[]; doc: Record<string, unknown> } {
  if (!existsSync(file)) throw new AdmitError(`${file}: no such candidates file`);
  let doc: Record<string, unknown>;
  try { doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { throw new AdmitError(`${file} is not JSON`); }
  if (doc?.kind !== 'poly.candidates' || doc.v !== 1 || !Array.isArray(doc.candidates)) throw new AdmitError(`${file} is not a poly.candidates file of version 1 (PT30.3)`);
  const candidates = doc.candidates as Record<string, unknown>[];
  for (const c of candidates) if (c.digest !== candidateDigest(c)) throw new AdmitError(`the candidate ${String(c.id)} in ${file} has the digest ${String(c.digest)}, which is not its own (PS20.1): the candidate was changed`);
  return { candidates, doc };
}

export function adjudicate(o: AdjudicateOptions): { path: string; file: AdjudicationFile } {
  if (!(VERDICTS as readonly string[]).includes(o.verdict)) {
    throw new AdmitError(o.verdict === 'narrowed' ? 'the verdict narrowed is no verdict in M7: a person judges a candidate real, spurious or defer (PS20.3)' : `${o.verdict} is not a verdict: real, spurious or defer (PS20.3)`);
  }
  if (existsSync(o.out)) throw new AdmitError(`${o.out} exists: poly adjudicate does not overwrite a file`);
  const { candidates } = readCandidates(o.candidates);
  const c = candidates.find((x) => x.id === o.candidate);
  if (!c) throw new AdmitError(`the candidates file ${o.candidates} has no candidate ${o.candidate}`);
  const project = o.project ?? process.cwd();
  const rings = keyringsOf(project, loadProject(project).manifest);
  if (rings.agents.some((a) => a.keyId === o.by)) throw new AdmitError(`${o.by} is an agent key, and an agent key never signs a record of the kind adjudication (PF9.6, PT12.5)`);
  if (!rings.people.some((p) => p.keyId === o.by)) throw new AdmitError(`${o.by} is not a key in the project's people keyring (PT12.5): a person's verdict is signed with a person's key`);
  const record = signRecord({ kind: 'adjudication', subject: adjudicationSubject(projectAnchorId(project), c.digest as string, o.verdict), by: o.by, at: new Date().toISOString() }, personKey(o.key));
  const file: AdjudicationFile = { v: 1, kind: 'poly.adjudication', candidate: c.digest as string, id: o.candidate, verdict: o.verdict as Verdict, record };
  writeFileSync(o.out, JSON.stringify(file, null, 2) + '\n', { flag: 'wx' });
  return { path: o.out, file };
}
