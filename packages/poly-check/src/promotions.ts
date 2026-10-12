// Admission reads promotions back (PS20.7, PT30.6, S513): each `promotions/*.json` is checked against the sources and the
// certified people ring, in file order, and the certificate lists them. A promotion the sources, the record or the corpus
// kind do not bear out is refused with PL6510, PL6511 or PL6512, and nothing is admitted.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { adjudicationSubject, recordDigest, sha256OfBytes, verifyRecord, type Keyrings } from '@poly/core';

export interface Promotion { candidate: string; id: string; record: string; corpus: { digest: string; kind: string }; tool: unknown }
export interface PromotionProblem { code: 'PL6510' | 'PL6511' | 'PL6512'; entry: string; message: string }

const sha = (s: string) => `sha256:${createHash('sha256').update(s, 'utf8').digest('hex')}`;

/** The promotions of a project, in file order, with the digest of each entry file, and every problem found. */
export function readPromotions(project: string, rings: Keyrings, anchorId: string, certificateSource: 'user' | 'test'): { list: Promotion[]; files: Record<string, string>; problems: PromotionProblem[] } {
  const dir = join(project, 'promotions');
  const list: Promotion[] = [];
  const files: Record<string, string> = {};
  const problems: PromotionProblem[] = [];
  if (!existsSync(dir)) return { list, files, problems };
  for (const name of readdirSync(dir).filter((f) => /^\d{4}-.+\.json$/.test(f)).sort()) {
    const rel = `promotions/${name}`;
    const bytes = readFileSync(join(dir, name));
    files[rel] = sha256OfBytes(bytes);
    const bad = (code: PromotionProblem['code'], message: string) => problems.push({ code, entry: rel, message });
    let e: { candidate?: string; id?: string; adjudication?: { v?: number; kind?: string; candidate?: string; id?: string; verdict?: string; record?: unknown }; tool?: unknown; corpus?: { digest?: string; kind?: string }; inserted?: { file?: string; text?: string; digest?: string } };
    try { e = JSON.parse(bytes.toString('utf8')); } catch { bad('PL6510', `${rel} is not JSON`); continue; }
    const id = String(e.id ?? '');
    const ins = e.inserted;
    // PL6510: the promoted text is in the sources, where the entry says, and is the text it digests.
    if (!ins || typeof ins.file !== 'string' || typeof ins.text !== 'string' || typeof ins.digest !== 'string') { bad('PL6510', `${rel} (promotion ${id}) has no inserted { file, text, digest }`); continue; }
    const abs = resolve(project, ins.file);
    const inside = !isAbsolute(ins.file) && !relative(project, abs).startsWith('..') && relative(project, abs).split(sep)[0] !== '..';
    if (!inside) bad('PL6510', `${rel} (promotion ${id}) names ${ins.file}, which is outside the project`);
    else if (!existsSync(abs)) bad('PL6510', `${rel} (promotion ${id}) names ${ins.file}, which does not exist`);
    else if (!readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').includes(ins.text)) bad('PL6510', `${rel} (promotion ${id}) is not in ${ins.file}: the promoted text is gone from the sources or changed`);
    // PS20.4: a refinement says why, and its candidate's source is not the text that was inserted.
    const refinement = (e as { refinement?: { reason?: unknown; candidateSource?: unknown } }).refinement;
    if (refinement !== undefined) {
      const body = ins.text.split('\n').slice(1).map((l) => l.trim()).join('\n').trim();
      if (typeof refinement.reason !== 'string' || !refinement.reason.trim()) bad('PL6510', `${rel} (promotion ${id}) has a refinement with no reason (PS20.4)`);
      else if (typeof refinement.candidateSource !== 'string' || !refinement.candidateSource.trim() || refinement.candidateSource.split('\n').map((l) => l.trim()).join('\n').trim() === body) bad('PL6510', `${rel} (promotion ${id}) has a refinement whose candidate source is missing or is the inserted text itself, so it refines nothing (PS20.4)`);
    }
    if (sha(ins.text) !== ins.digest) bad('PL6510', `${rel} (promotion ${id}) has the text digest ${ins.digest}, and its text digests to ${sha(ins.text)}`);

    // PL6511: the adjudication is a person's real verdict on this candidate, for this project.
    const adj = e.adjudication;
    const marker = ins.text.split('\n')[0].trim();
    if (!adj || adj.kind !== 'poly.adjudication' || adj.v !== 1) { bad('PL6511', `${rel} (promotion ${id}) holds no poly.adjudication`); continue; }
    if (adj.candidate !== e.candidate || adj.id !== e.id) bad('PL6511', `${rel}: the adjudication is of ${String(adj.id)} (${String(adj.candidate)}), and the entry is of ${id} (${String(e.candidate)})`);
    if (adj.verdict !== 'real') bad('PL6511', `${rel} (promotion ${id}): the verdict is ${String(adj.verdict)}, and only a real verdict reaches a program (PS20.3)`);
    const v = verifyRecord(adj.record, rings, { kind: 'adjudication', subject: adjudicationSubject(anchorId, String(e.candidate), String(adj.verdict)) });
    if (!v.ok) bad('PL6511', `${rel} (promotion ${id}): ${v.problem}`);
    else if (marker !== `// promoted: ${id} ${recordDigest(adj.record as never)}`) bad('PL6510', `${rel} (promotion ${id}): the marker line of the promoted text is "${marker}", and it must name the promotion and its record ${recordDigest(adj.record as never)}`);
    // PL6512: a synthetic corpus is cited only by a test certificate (PS20.5).
    if (e.corpus?.kind === 'synthetic' && certificateSource !== 'test') bad('PL6512', `${rel} (promotion ${id}) was mined from a synthetic corpus, which only a test certificate may cite (PS20.5)`);

    if (v.ok) list.push({ candidate: String(e.candidate), id, record: recordDigest(adj.record as never), corpus: { digest: String(e.corpus?.digest), kind: String(e.corpus?.kind) }, tool: e.tool });
  }
  return { list, files, problems };
}
