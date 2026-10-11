// `poly mine` (PF10.2, PS20, PT30.1 to PT30.3, PT30.9, S507, S508, S509, S510): a trace corpus (PT29) is made into the input
// of polyx, polyx runs as a separately installed tool, and what it proposes comes back as candidates: rules with their
// support, their counter-evidence and the source that would carry them. A candidate is part of no program. polyx is not
// vendored and not imported: it is run by path with a configuration, a corpus and an alphabet that live in a temporary
// directory, and no language model is called (the environment polyx sees holds no key, and `annotate` is never run).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize, loadProject } from '@poly/core';
import type * as A from '@poly/core';
import { parse } from '@poly/lang';
import { buildMachine, type RMachine, type RType } from '@poly/ref';

export class MineUsageError extends Error {}

export interface MineOptions { traces: string; project: string; polyx: string; out: string; synthetic?: boolean; all?: boolean }

interface Step { seq: number; action: string; stepKind: string; pre: Record<string, unknown>; post: Record<string, unknown>; effects: { kind: string; consequence: string; gate: { outcome: string } | null }[] }
interface Episode { episode: string; machine: string; gapped: boolean; steps: Step[] }
interface Rule { id: string; pattern: string; bindings: Record<string, string>; status: string; support: { holds: number; of: number }; counterexamples?: { interactionId: string; episodeId: string; seq: number }[] }

const sha = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const scalar = (v: unknown): string | number | boolean | null => (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : JSON.stringify(v));

/** PS20.1: the digest of a candidate is that of its canonical form without the digest field. */
export const candidateDigest = (c: Record<string, unknown>): string => { const { digest: _d, ...rest } = c; return sha(canonicalize(rest)); };

/** What polyx may see of this process: nothing that looks like a key, a token or a secret, and nothing of polyx's own settings. */
function polyxEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^POLYX_|KEY|TOKEN|SECRET|PASSWORD/i.test(k)) env[k] = v;
  return env;
}

export async function mineTraces(o: MineOptions): Promise<{ path: string; candidates: number; promotable: number; gappedLeftOut: number }> {
  for (const [k, v] of [['--traces', o.traces], ['--project', o.project], ['--polyx', o.polyx], ['--out', o.out]] as const) if (!v) throw new MineUsageError(`poly mine needs ${k} <value>`);
  if (!existsSync(join(o.polyx, 'bin', 'polyx.mjs'))) throw new MineUsageError(`--polyx ${o.polyx} has no bin/polyx.mjs: it is the directory of a polyx checkout`);
  if (existsSync(o.out)) throw new MineUsageError(`${o.out} exists: poly mine does not overwrite a file`);
  if (!existsSync(o.traces)) throw new MineUsageError(`${o.traces}: no such trace corpus`);

  const bytes = readFileSync(o.traces);
  const [header, ...episodes] = bytes.toString('utf8').trim().split('\n').map((l) => JSON.parse(l)) as [{ v: number; kind: string }, ...Episode[]];
  if (header?.kind !== 'poly.traces' || header.v !== 1) throw new MineUsageError(`${o.traces} is not a poly.traces corpus of version 1 (PT29.2)`);
  const mined = episodes.filter((e) => !e.gapped);
  const gappedLeftOut = episodes.length - mined.length;

  // The program's types, to write a candidate's source as the program writes its values (PT30.9).
  const modules: A.Module[] = [];
  for (const f of loadProject(o.project).files) { const m = parse(readFileSync(f, 'utf8')).module; if (m) modules.push(m); }
  const machines = new Map<string, RMachine | null>();
  const machineOf = (id: string): RMachine | null => {
    if (!machines.has(id)) {
      const mod = modules.find((m) => m.name === id.slice(0, id.indexOf('.')));
      let M: RMachine | null = null;
      try { M = mod ? buildMachine(mod, id.slice(id.indexOf('.') + 1), { program: modules }) : null; } catch { M = null; }
      machines.set(id, M);
    }
    return machines.get(id)!;
  };

  // Which machines emitted which effect kinds.
  const emitters = new Map<string, Set<string>>();
  for (const e of mined) for (const s of e.steps) for (const f of s.effects) { if (!emitters.has(f.kind)) emitters.set(f.kind, new Set()); emitters.get(f.kind)!.add(e.machine); }
  const pureActions = new Map<string, Set<string>>();
  for (const e of mined) for (const s of e.steps) if (s.action !== '$create' && s.effects.length === 0) { const k = `${e.machine}.${s.action}`; if (!pureActions.has(k)) pureActions.set(k, new Set()); pureActions.get(k)!.add(e.machine); }

  // PT30.2: the port.
  const types = new Map<string, { id: string; match: Record<string, string>; consequence?: string; slots: string[]; identity?: string[]; state?: string[] }>();
  const fieldsOf = new Map<string, Set<string>>();
  const interactions: unknown[] = [];
  const turnSeq: number[][] = [];
  let startedAt = 1_700_000_000_000;
  mined.forEach((e, i) => {
    const run = e.episode;
    const turns: unknown[] = [];
    const seqs: number[] = [];
    const sid = `state-${e.machine}`;
    if (!fieldsOf.has(sid)) fieldsOf.set(sid, new Set());
    const state = (s: Record<string, unknown>) => { for (const k of Object.keys(s)) fieldsOf.get(sid)!.add(k); return { ...Object.fromEntries(Object.entries(s).map(([k, v]) => [k, scalar(v)])), run }; };
    for (const s of e.steps) {
      if (s.action === '$create') continue;
      turns.push({ speaker: 'system', event: sid, slots: state(s.pre) }); seqs.push(s.seq);
      if (s.effects.length === 0) {
        const aid = `act-${e.machine}.${s.action}`;
        types.set(aid, { id: `action:${aid}`, match: { speaker: 'action', button: aid }, consequence: 'none', slots: ['run'], identity: ['run'] });
        turns.push({ speaker: 'action', button: aid, slots: { run }, ...(s.stepKind !== 'accepted' ? { result: 'refused' } : {}) }); seqs.push(s.seq);
      }
      turns.push({ speaker: 'system', event: sid, slots: state(s.post) }); seqs.push(s.seq);
      {
        for (const f of s.effects) {
          const fid = `fx-${f.kind}`;
          // A consequence the trace does not know is written none (the candidate says so in its header).
          types.set(fid, { id: `action:${fid}`, match: { speaker: 'action', button: fid }, consequence: ['none', 'reversible', 'compensable', 'irreversible'].includes(f.consequence) ? f.consequence : 'none', slots: ['run'], identity: ['run'] });
          turns.push({ speaker: 'action', button: fid, slots: { run }, ...(f.gate?.outcome === 'denied' || s.stepKind !== 'accepted' ? { result: 'refused' } : {}) }); seqs.push(s.seq);
        }
      }
    }
    interactions.push({ id: `ep-${i}`, operator: 'poly', startedAt: startedAt + i * 3_600_000, turns });
    turnSeq.push(seqs);
  });
  for (const [sid, fs] of fieldsOf) types.set(sid, { id: `system:${sid}`, match: { speaker: 'system', event: sid }, slots: ['run', ...fs], identity: ['run'], state: [...fs] });

  const alphabet = ['corpus: poly-traces', 'version: 1', 'event_types:'];
  for (const t of types.values()) {
    alphabet.push(`  - id: ${t.id}`, `    match: { ${Object.entries(t.match).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')} }`);
    if (t.consequence) alphabet.push(`    consequence: ${t.consequence}`, '    recommendable: false');
    alphabet.push(`    slots: [${t.slots.join(', ')}]`);
    if (t.identity) alphabet.push(`    identity: [${t.identity.join(', ')}]`);
    if (t.state) alphabet.push(`    state: [${t.state.join(', ')}]`);
  }
  alphabet.push('outcomes: []', 'redaction: []');

  const work = mkdtempSync(join(tmpdir(), 'poly-mine-'));
  try {
    const corpusFile = join(work, 'corpus.json');
    const alphabetFile = join(work, 'alphabet.yaml');
    const configFile = join(work, 'polyx.config.json');
    writeFileSync(corpusFile, JSON.stringify({ corpus: 'poly-traces', interactions }));
    writeFileSync(alphabetFile, alphabet.join('\n') + '\n');
    writeFileSync(configFile, JSON.stringify({ workspace: join(work, 'workspace'), policies: [], segmenter: 'null', seed: 1, corpora: { 'poly-traces': { adapter: 'synthetic', source: corpusFile, alphabet: alphabetFile } } }));
    let out: string;
    try {
      out = execFileSync(process.execPath, [join(o.polyx, 'bin', 'polyx.mjs'), 'mine', 'poly-traces', '--json', '--config', configFile, ...(o.all ? ['--all'] : [])], { encoding: 'utf8', cwd: o.polyx, env: polyxEnv(), maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      const err = e as { stderr?: string; message: string };
      throw new Error(`polyx failed: ${(err.stderr ?? err.message).toString().trim().split('\n').slice(0, 5).join(' | ')}`);
    }
    const report = JSON.parse(out) as { manifest: Record<string, unknown>; rules: Rule[] };

    const m = report.manifest;
    const pkg = (p: string): string | null => { try { return (JSON.parse(readFileSync(p, 'utf8')) as { version?: string }).version ?? null; } catch { return null; } };
    const tool = {
      name: 'polyx',
      version: pkg(join(o.polyx, 'package.json')),
      commit: (m.codeCommit as string | undefined) ?? null,
      manifest: sha(canonicalize({ alphabetVersion: m.alphabetVersion, thresholds: m.thresholds, seed: m.seed, codeCommit: m.codeCommit, segmenter: m.segmenter, corpusRevision: m.corpusRevision })),
      lens: pkg(join(o.polyx, 'node_modules', '@cognitive-fab', 'polyx-lens', 'package.json')),
    };

    const kindOf = (s: string): { t: 'effect'; kind: string } | { t: 'action'; name: string } | null => {
      const m1 = /^action:fx-(.+)$/.exec(s ?? ''); if (m1) return { t: 'effect', kind: m1[1] };
      const m2 = /^action:act-(.+)$/.exec(s ?? ''); if (m2) return { t: 'action', name: m2[1] };
      return null;
    };
    const literal = (t: RType, v: unknown, M: RMachine): string | null => {
      if (t.k === 'union') return typeof v === 'string' && M.unions.get(t.name)?.ctors.every((c) => c.fields.length === 0) ? v : null;
      if (t.k === 'string') return typeof v === 'string' ? JSON.stringify(v) : null;
      if (t.k === 'int' || t.k === 'conf') return typeof v === 'number' ? String(v) : null;
      if (t.k === 'bool') return typeof v === 'boolean' ? String(v) : null;
      return null;
    };

    const candidates = report.rules.filter((r) => o.all || r.status === 'proposed').map((r) => {
      const id = r.id;
      const x = kindOf(r.bindings.subject);
      const base = { id, pattern: r.pattern, status: r.status, support: { holds: r.support.holds, of: r.support.of } };
      const counter = (r.counterexamples ?? []).map((c) => { const i = Number(/ep-(\d+)/.exec(c.interactionId)?.[1]); return mined[i] ? { episode: mined[i].episode, seq: turnSeq[i]?.[c.seq - 1] ?? turnSeq[i]?.[c.seq] ?? c.seq } : null; }).filter(Boolean);
      const no = (reason: string, text: string) => ({ ...base, counterEvidence: counter, promotable: false, reason, text });
      const decorate = (c: Record<string, unknown>) => ({ ...c, digest: candidateDigest(c) });
      const holdsOf = `${r.support.holds} of ${r.support.of} runs`;
      const machineFor = (...kinds: string[]): string | null => {
        const sets = kinds.map((k) => emitters.get(k) ?? new Set<string>());
        const all = new Set(sets.flatMap((s) => [...s]));
        return all.size === 1 && sets.every((s) => s.size === 1) ? [...all][0] : null;
      };
      if (!x) return decorate(no(`the rule is about ${r.bindings.subject}, which is not an effect or an action of the trace`, `${r.pattern} on ${r.bindings.subject}`));
      const label = (k: ReturnType<typeof kindOf>) => (k ? (k.t === 'effect' ? k.kind : k.name) : String(k));

      if (r.pattern === 'X-implies-prior-Y' || r.pattern === 'no-X-without-prior-Y') {
        const y = kindOf(r.bindings.guard);
        if (!y) return decorate(no(`the guard ${r.bindings.guard} is not an effect or an action of the trace`, `${label(x)} after ${r.bindings.guard}`));
        const text = `${label(x)} after ${label(y)} (mined, ${holdsOf})`;
        if (x.t !== y.t) return decorate(no(`the rule mixes an effect and a pure action (${label(x)} and ${label(y)}), which is not promotable in M7`, text));
        if (x.t === 'action') return decorate(no('a rule over pure actions is the ghost form of PS20.6, which is not built yet', text));
        const machine = machineFor(x.kind, (y as { kind: string }).kind);
        if (!machine) return decorate(no(`the effects ${x.kind} and ${(y as { kind: string }).kind} are not emitted by one machine alone, so the rule is not promotable in M7`, text));
        return decorate({ ...base, counterEvidence: counter, promotable: true, form: 'path-property', target: { machine }, text, source: `path property mined-${id}: before("${(y as { kind: string }).kind}", "${x.kind}")` });
      }
      if (r.pattern === 'at-most-one-X') {
        const text = `${label(x)} at most once per run (mined, ${holdsOf})`;
        if (x.t === 'action') return decorate(no('a rule over a pure action is the ghost form of PS20.6, which is not built yet', text));
        const machine = machineFor(x.kind);
        if (!machine) return decorate(no(`the effect ${x.kind} is not emitted by one machine alone, so the rule is not promotable in M7`, text));
        return decorate({ ...base, counterEvidence: counter, promotable: true, form: 'path-property', target: { machine }, text, source: `path property mined-${id}: count("${x.kind}") <= 1` });
      }
      if (r.pattern === 'no-X-unless-state') {
        const field = /^target\.(.+)$/.exec(r.bindings.fact ?? '')?.[1];
        let allowed: unknown[] = [];
        try { allowed = JSON.parse(r.bindings.allowed); } catch { allowed = []; }
        if (x.t === 'action') return decorate(no('a state rule over a pure action is not promotable in M7', `${label(x)} only in some states (mined, ${holdsOf})`));
        const machine = machineFor(x.kind);
        const M = machine ? machineOf(machine) : null;
        const f = M?.fields.find((q) => q.name === field);
        const lits = f && M ? allowed.map((v) => literal(f.type, v, M)) : [];
        const text = `${x.kind} only while ${field} is ${allowed.map(String).sort().join(' or ')} (mined, ${holdsOf})`;
        if (!machine || !M || !f || !lits.length || lits.some((l) => l === null)) return decorate(no(`the state rule on ${x.kind} cannot be written against the program: ${!machine ? 'the effect is not emitted by one machine alone' : !f ? `the machine has no field ${field}` : 'a value of the field cannot be written as a literal'}`, text));
        const vs = [...lits as string[]].sort();
        const quoteSafe = text.replace(/"/g, "'");
        return decorate({ ...base, counterEvidence: counter, promotable: true, form: 'policy-rule', target: { machine }, text: quoteSafe, source: [`obligation mined-${id} "${quoteSafe}" rule {`, `  when proposal.kind == "effect" && effect.kind == "${x.kind}"`, `  require machine("${machine}").${field} in { ${vs.join(', ')} } else deny`, '  on unknown escalate', '}'].join('\n') });
      }
      return decorate(no(`the pattern ${r.pattern} is not promotable in M7`, `${r.pattern} on ${label(x)}`));
    });

    const file = { v: 1, kind: 'poly.candidates', corpus: { digest: sha(bytes), kind: o.synthetic ? 'synthetic' : 'recorded', episodes: mined.length, gappedLeftOut }, tool, thresholds: pick(m.thresholds as Record<string, unknown>, ['minInstances', 'ownSupport', 'impliesSupport']), candidates };
    writeFileSync(o.out, JSON.stringify(file, null, 2) + '\n', { flag: 'wx' });
    return { path: o.out, candidates: candidates.length, promotable: candidates.filter((c) => (c as unknown as { promotable: boolean }).promotable).length, gappedLeftOut };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => k in (o ?? {})).map((k) => [k, o[k]]));
