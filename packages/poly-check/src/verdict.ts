// `poly verdict` (PF8.6, PS22.1, PT32.1, S519): a person's signed statement that one recorded answer of a decision was right or
// wrong, with the correct answer when it is known. The record binds the project's anchor, the decision event's hash, the
// verdict and the correct answer, so it cannot be moved to another project, answer or verdict. The journal is read and never
// written: a verdict is a file of the project, checked against the chain when a refit uses it. Never offered over MCP.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keyringsOf, loadProject, signRecord, verdictSubject, type SignedRecord } from '@poly/core';
import type { JournalReader } from '@poly/runtime';
import { AdmitError, personKey } from './admit.js';
import { projectAnchorId } from './adjudicate.js';

export const ANSWER_VERDICTS = ['right', 'wrong'] as const;

export interface VerdictFile { v: 1; kind: 'poly.verdict'; decision: string; event: string; run: string; model: string; verdict: 'right' | 'wrong'; correct?: unknown; record: SignedRecord }
export interface SignVerdictOptions { reader?: JournalReader; db?: string; event: string; verdict: string; correct?: string; by: string; key: string; project?: string; out: string }

/** A `decision` event of the store, by its hash: the run it is in and what it recorded. */
export interface DecisionEvent { hash: string; run: string; decision: string; model: string; raw: number }

/** Every decision event of the journal, by hash (PD2.2: the model is the one the provider reported, or the configured id). */
export async function decisionEvents(reader: JournalReader): Promise<Map<string, DecisionEvent>> {
  const out = new Map<string, DecisionEvent>();
  for (const r of await reader.runs()) {
    for (const e of await reader.chain(r.run)) {
      if (e.kind !== 'decision') continue;
      const b = e.body as { decision: string; raw: number; model: { id: string; reported: string | null } };
      out.set(e.hash, { hash: e.hash, run: r.run, decision: b.decision, model: b.model?.reported ?? b.model?.id, raw: b.raw });
    }
  }
  return out;
}

/** The `*.json` files of a folder, sorted: the verdicts a refit reads. */
export function verdictFilesIn(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => join(dir, f)) : [];
}

export async function signVerdict(o: SignVerdictOptions): Promise<{ path: string; file: VerdictFile }> {
  if (!(ANSWER_VERDICTS as readonly string[]).includes(o.verdict)) throw new AdmitError(`${o.verdict} is not a verdict on an answer: right or wrong (PS22.1)`);
  if (existsSync(o.out)) throw new AdmitError(`${o.out} exists: poly verdict does not overwrite a file`);
  let correct: unknown;
  if (o.correct !== undefined) {
    try { correct = JSON.parse(o.correct); } catch { throw new AdmitError(`--correct is not JSON: ${o.correct}`); }
  }
  const project = o.project ?? process.cwd();
  const rings = keyringsOf(project, loadProject(project).manifest);
  if (rings.agents.some((a) => a.keyId === o.by)) throw new AdmitError(`${o.by} is an agent key, and an agent key never signs a record of the kind verdict (PF9.6, PT12.5)`);
  if (!rings.people.some((p) => p.keyId === o.by)) throw new AdmitError(`${o.by} is not a key in the project's people keyring (PT12.5): a person's verdict is signed with a person's key`);
  let reader = o.reader;
  let opened = false;
  if (!reader) {
    if (!o.db) throw new AdmitError('poly verdict needs --db <store>');
    const { openJournal } = await import('@poly/runtime');
    reader = openJournal(o.db);
    opened = true;
  }
  try {
    const hit = (await decisionEvents(reader)).get(o.event);
    if (!hit) throw new AdmitError(`no decision event ${o.event} in the store: a verdict names the hash of a decision event (PS22.1)`);
    const record = signRecord({ kind: 'verdict', subject: verdictSubject(projectAnchorId(project), o.event, o.verdict, correct), by: o.by, at: new Date().toISOString() }, personKey(o.key));
    const file: VerdictFile = { v: 1, kind: 'poly.verdict', decision: hit.decision, event: o.event, run: hit.run, model: hit.model, verdict: o.verdict as 'right' | 'wrong', ...(correct !== undefined ? { correct } : {}), record };
    writeFileSync(o.out, JSON.stringify(file, null, 2) + '\n', { flag: 'wx' });
    return { path: o.out, file };
  } finally { if (opened) await reader.close(); }
}

export const readVerdictFile = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));
