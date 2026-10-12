// `poly propose` (PF10.3, PS21, PT31, S516 to S518, S503): polyness, a separately installed tool, is given the transcripts of
// the work a person already repeats and proposes a checked workflow for one step. poly reads what polyness wrote by four
// fixed templates and by nothing else (C1), derives a deterministic linear machine from the steps (PS21.2), turns each rule
// the templates cover into a path property (PS21.3), and writes poly source and an evidence file (PT31.5). The proposal is
// part of no program until a person copies it in: admission reads it back (PL6520, PL6521). Every effect is declared with
// the label `exec` and no class, because a consequence is a person's declaration (S503, C2). No language model is called,
// and no word of a transcript, a prompt, an argument, a path, a branch, a session id or a project name can reach the output:
// the source and the evidence are written from fixed text, the checked names of steps and rules, and numbers (PS21.5, C4).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { canonicalize } from '@poly/core';
import { AdmitError } from './admit.js';
import { MineUsageError, loadSeam } from './mine.js';
import { TraceUsageError, exportTraces } from './traces.js';

export const PROPOSAL_THRESHOLDS = { minInstances: 5, ownSupport: 0.6 } as const;

/** A step is one to four words of lower-case letters and digits, the first word beginning with a letter, at most 32 characters. */
const STEP_ARG = /^[a-z][a-z0-9]*( [a-z0-9]+){0,3}$/;
const STEP_KEY = /^[a-z][a-z0-9]*(-[a-z0-9]+){0,3}$/;
/** A rule's name becomes the name of a path property, and poly reads a hyphen segment that begins with a digit as a number with a unit. */
const RULE_NAME = /^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$/;
const KIND = '([a-z][a-z0-9]*(?:-[a-z0-9]+)*)';
const TEMPLATES = {
  implies: new RegExp(`^\\(path\\) => path\\.emitted\\.every\\(\\(e\\) => e\\.kind !== '${KIND}' \\|\\| path\\.emitted\\.some\\(\\(s\\) => s\\.kind === '${KIND}' && s\\.step < e\\.step\\)\\)$`),
  exactly: new RegExp(`^\\(path\\) => !path\\.emitted\\.some\\(\\(e\\) => e\\.kind === '${KIND}'\\) \\|\\| path\\.count\\('${KIND}'\\) === 1$`),
  atMost: new RegExp(`^\\(path\\) => path\\.count\\('${KIND}'\\) <= 1$`),
  verify: new RegExp(`^\\(path\\) => path\\.emitted\\.every\\(\\(e, i\\) => e\\.kind !== '${KIND}' \\|\\| path\\.actionBefore\\('VERIFY_PASSED', i\\)\\)$`),
};

export interface ProposeRuns { db: string; build: string; certificate: string; trust: Record<string, string> }
export interface ProposeOptions { polyness: string; step: string; transcripts?: string; /** PT31.10: a store, in place of transcripts. */ runs?: ProposeRuns; out: string; polynessPin?: string; synthetic?: boolean; timeoutMs?: number; maxOutput?: number }
export interface ProposeResult { out: string; name: string; steps: string[]; rules: number; notTranslatable: number }

const sha = (b: Buffer | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const first = (s: string) => s.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
const pascal = (slug: string) => slug.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('');
const under = (slug: string) => slug.replace(/-/g, '_');

/** `poly propose --pin-polyness`: records the polyness at a path as the one this person trusts (PT31.3). A different pin needs `repin`. */
export async function pinPolyness(o: { polyness: string; polynessPin?: string; repin?: boolean }): Promise<{ path: string; pin: { version: string }; changed: boolean }> {
  for (const [k, v] of [['--polyness', o.polyness], ['--polyness-pin', o.polynessPin]] as const) if (!v) throw new MineUsageError(`poly propose --pin-polyness needs ${k} <value>`);
  const seam = await loadSeam();
  let pin: ReturnType<typeof seam.polynessPinOf>;
  try { pin = seam.polynessPinOf(o.polyness); } catch (e) { throw new AdmitError((e as Error).message); }
  const path = o.polynessPin!;
  if (existsSync(path)) {
    let had: unknown = null;
    try { had = JSON.parse(readFileSync(path, 'utf8')); } catch { had = null; }
    if (had && canonicalize(had as never) === canonicalize(pin as never)) return { path, pin, changed: false };
    if (!o.repin) throw new MineUsageError(`${path} pins another polyness than the one at ${o.polyness}: use --repin-polyness to replace it`);
  }
  writeFileSync(path, JSON.stringify(pin, null, 2) + '\n');
  return { path, pin, changed: true };
}

interface Rule { name: string; pattern: string; support: { holds: number; of: number }; window: 'run' | 'session'; provenance: 'own' }
interface NotTranslatable { name: string; pattern: string; reason: string }
interface Translated { rules: (Rule & { form: string })[]; notTranslatable: NotTranslatable[]; instances: number }

/** C1: the entries of polyness's effect-invariants.mjs, read as text by the four templates. The JavaScript is never run. */
function translate(invariants: string, steps: string[], verifyStep: string | null): Translated {
  const text = invariants.replace(/\r\n/g, '\n');
  const block = /^ {2}\{\n((?: {4}\/\/[^\n]*\n)*) {4}name: '([^'\n]*)',\n {4}pred: ([^\n]*),\n {2}\},?$/gm;
  const entries = [...text.matchAll(block)];
  const named = (text.match(/^ {4}name: /gm) ?? []).length;
  if (entries.length !== named) throw new AdmitError('polyness wrote an entry in effect-invariants.mjs in a layout poly does not read: what polyness writes is no longer what poly reads (PT31.4)');
  const out: Translated = { rules: [], notTranslatable: [], instances: 0 };
  for (const m of entries) {
    const [, comments, name, pred] = m;
    const ev = /^ {4}\/\/ own evidence: (\d+) of (\d+) (per run|across the session)\b/m.exec(comments);
    if (ev) out.instances = Math.max(out.instances, Number(ev[2]));
    const no = (pattern: string, reason: string) => out.notTranslatable.push({ name, pattern, reason });
    const known = steps;
    const hit = (re: RegExp) => re.exec(pred);
    if (!RULE_NAME.test(name)) { no('unrecognised', `the rule's name is not one poly can use as a name of a path property: lower-case words of letters and digits, each beginning with a letter (PT31.5a)`); continue; }
    let pattern: string; let form: string;
    let t: RegExpExecArray | null;
    if ((t = hit(TEMPLATES.exactly))) { no('exactly-one-when-started', 'exactly-one-when-started is not a prefix-closed form (PS5.4)'); continue; }
    if ((t = hit(TEMPLATES.implies))) {
      pattern = 'implies-a-prior';
      if (!known.includes(t[1]) || !known.includes(t[2])) { no(pattern, `the rule ${name} names a step the workflow does not have`); continue; }
      form = `before("${t[2]}", "${t[1]}")`;
    } else if ((t = hit(TEMPLATES.atMost))) {
      pattern = 'at-most-one-per-run';
      if (!known.includes(t[1])) { no(pattern, `the rule ${name} names a step the workflow does not have`); continue; }
      form = `count("${t[1]}") <= 1`;
    } else if ((t = hit(TEMPLATES.verify))) {
      pattern = 'no-without-a-prior-verify';
      if (!known.includes(t[1]) || !verifyStep) { no(pattern, `the rule ${name} needs a verification step, and the workflow names none`); continue; }
      form = `before("${verifyStep}", "${t[1]}")`;
    } else { no('unrecognised', `the rule ${name} matches no template poly reads (PT31.4)`); continue; }
    if (!ev) { no(pattern, `the rule ${name} has no "own evidence: H of N" comment, so its support is unknown (PS21.3)`); continue; }
    out.rules.push({ name, pattern, support: { holds: Number(ev[1]), of: Number(ev[2]) }, window: ev[3] === 'per run' ? 'run' : 'session', provenance: 'own', form });
  }
  return out;
}

/** PS21.2: the machine, derived from the steps alone, and PS21.3: each translated rule as a path property. */
function emitSource(name: string, steps: string[], instances: number, rules: { name: string; form: string }[]): string {
  const P = steps.map(pascal);
  const L: string[] = [];
  L.push(`// Proposed by poly propose ${instances > 0 ? `from ${instances} instances of ${name}` : `for ${name}`} (PS21). Every effect is declared with the label exec and no class: a person declares each consequence (S503).`);
  L.push(`module ${under(name)}`, '');
  L.push(`enum Phase { Idle, ${P.map((p) => `Awaiting${p}`).join(', ')}, Done, Blocked }`, '');
  L.push('machine Run {', '  state {', '    phase : Phase = Idle', '  }', '  terminal phase in { Done, Blocked }', '');
  L.push('  action Start()');
  for (const p of P) L.push(`  action ${p}Done()`, `  action ${p}Failed()`);
  L.push('');
  const handler = (on: string, from: string, to: string, emit?: string) => {
    L.push(`  on ${on} {`, `    require phase == ${from} else reject "not-awaiting"`, `    phase' = ${to}`);
    if (emit) L.push(`    emit ${emit}()`);
    L.push('  }');
  };
  handler('Start', 'Idle', `Awaiting${P[0]}`, under(steps[0]));
  P.forEach((p, i) => {
    const last = i === P.length - 1;
    handler(`${p}Done`, `Awaiting${p}`, last ? 'Done' : `Awaiting${P[i + 1]}`, last ? undefined : under(steps[i + 1]));
    handler(`${p}Failed`, `Awaiting${p}`, 'Blocked');
  });
  if (rules.length) {
    L.push('');
    for (const r of rules) L.push(`  // proposed: ${r.name}`, `  path property ${r.name}: ${r.form}`);
  }
  L.push('');
  for (const s of steps) L.push(`  effect ${under(s)}() {`, `    kind "${s}"`, '    labels { exec }', '  }');
  L.push('}', '');
  return L.join('\n');
}

/**
 * PT31.10: the trace corpus of PS19 as transcripts polyness reads: one session per episode (the export's own token is the
 * session id), five episodes to a file, and for each effect of each step, in step order, one tool call named by the effect's
 * kind and its result, an error when the gate denied the effect. Nothing else of the corpus is carried: no state, no data, no
 * machine or project name, no consequence. A gapped episode is not converted, as the miner leaves it out.
 */
export function transcriptsFromCorpus(corpus: string): { files: Record<string, string>; sessions: number } {
  const [, ...rows] = corpus.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) as [unknown, ...{ episode: string; gapped?: boolean; steps: { effects?: { kind: string; gate?: { outcome?: string } | null }[] }[] }[]];
  const episodes = rows.filter((e) => !e.gapped);
  const files: Record<string, string> = {};
  let t = Date.parse('2026-01-01T00:00:00.000Z');
  const at = () => new Date((t += 1000)).toISOString();
  for (let f = 0; f * 5 < episodes.length; f++) {
    const out: string[] = [];
    episodes.slice(f * 5, f * 5 + 5).forEach((ep, e) => {
      out.push(JSON.stringify({ type: 'user', sessionId: ep.episode, timestamp: at(), message: { role: 'user', content: 'run' } }));
      let k = 0;
      for (const step of ep.steps) for (const fx of step.effects ?? []) {
        const id = `call-${f}-${e}-${k++}`;
        const command = fx.kind.replace(/-/g, ' ').replace(/[^A-Za-z0-9._: ]/g, '_');
        const ts = at();
        const denied = fx.gate?.outcome === 'denied';
        out.push(JSON.stringify({ type: 'assistant', sessionId: ep.episode, timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } }));
        out.push(JSON.stringify({ type: 'user', sessionId: ep.episode, timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: denied ? 'denied' : 'ok', ...(denied ? { is_error: true } : {}) }] }, toolUseResult: { stdout: '', stderr: '' } }));
      }
    });
    files[`runs-${f}.jsonl`] = out.join('\n') + '\n';
  }
  return { files, sessions: episodes.length };
}

const sessionsOf = (files: string[]): number => {
  const ids = new Set<string>();
  for (const f of files) for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.includes('sessionId')) continue;
    try { const id = (JSON.parse(line) as { sessionId?: unknown }).sessionId; if (typeof id === 'string') ids.add(id); } catch { /* a line that is not JSON names no session */ }
  }
  return ids.size;
};

export async function proposeWorkflow(o: ProposeOptions): Promise<ProposeResult> {
  for (const [k, v] of [['--polyness', o.polyness], ['--step', o.step], ['--out', o.out]] as const) if (!v) throw new MineUsageError(`poly propose needs ${k} <value>`);
  if (o.transcripts && o.runs) throw new MineUsageError('poly propose takes --transcripts or --runs, not both');
  if (!o.transcripts && !o.runs) throw new MineUsageError('poly propose needs --transcripts <folder> or --runs <store>');
  if (o.runs) for (const [k, v] of [['--runs', o.runs.db], ['--build', o.runs.build], ['--certificate', o.runs.certificate]] as const) if (!v) throw new MineUsageError(`poly propose --runs needs ${k} <value>`);
  if (o.runs && !Object.keys(o.runs.trust).length) throw new MineUsageError('poly propose --runs needs --trust <keyId>=<public key file>');
  if (o.step.length > 32 || !STEP_ARG.test(o.step)) throw new MineUsageError('--step is one to four words of lower-case letters and digits, at most 32 characters');
  if (existsSync(o.out)) throw new MineUsageError(`propose does not overwrite a file or folder: ${o.out} exists`);
  if (!o.runs) return proposeFrom(o, o.transcripts!);
  // PT31.10: a store is exported to a corpus in a folder of its own and converted; the folder is removed whatever happens.
  const work = mkdtempSync(join(tmpdir(), 'poly-propose-runs-'));
  try {
    const corpus = join(work, 'corpus.ndjson');
    await exportTraces({ db: o.runs.db, build: o.runs.build, certificate: o.runs.certificate, trust: o.runs.trust, out: corpus });
    const from = join(work, 'transcripts');
    mkdirSync(from);
    for (const [name, text] of Object.entries(transcriptsFromCorpus(readFileSync(corpus, 'utf8')).files)) writeFileSync(join(from, name), text);
    return await proposeFrom(o, from);
  } catch (e) {
    if (e instanceof TraceUsageError) throw new MineUsageError(e.message);
    throw e;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

async function proposeFrom(o: ProposeOptions, from: string): Promise<ProposeResult> {
  let transcripts: string[] = [];
  try { if (statSync(from).isDirectory()) transcripts = readdirSync(from, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => join(from, e.name)).sort(); } catch { transcripts = []; }
  if (!transcripts.length) throw new MineUsageError(`--transcripts ${o.transcripts ?? from} is not a folder holding .jsonl transcripts`);
  if (!existsSync(join(o.polyness, 'bin', 'polyness.mjs'))) throw new AdmitError(`${o.polyness} has no bin/polyness.mjs: it is the directory of a polyness checkout`);
  const pinPath = o.polynessPin ?? join(dirname(resolve(o.out)), 'polyness.pin.json');
  if (!existsSync(pinPath)) throw new MineUsageError(`no polyness pin at ${pinPath}: run poly propose --pin-polyness first`);
  let pin: { version: string };
  try { pin = JSON.parse(readFileSync(pinPath, 'utf8')) as { version: string }; } catch { throw new MineUsageError(`${pinPath} is not a polyness pin`); }

  const seam = await loadSeam();
  const name = o.step.replace(/ /g, '-');
  let run: ReturnType<typeof seam.runPolyness>;
  try {
    run = seam.runPolyness({ polyness: o.polyness, pin, step: o.step, transcripts, timeoutMs: o.timeoutMs, maxOutput: o.maxOutput });
  } catch (e) {
    // A pin that does not match, a timeout and a cap on the output are refusals; any other failure is polyness's.
    if ((e as Error).constructor?.name === 'PolynessRefused') throw new AdmitError((e as Error).message);
    throw e;
  }
  const failed = () => new AdmitError(`polyness failed: ${(run.stderr.trim() || run.stdout.trim()).split('\n').slice(0, 5).join(' | ')}`);
  const folder = run.proposals[`${name}-checked`];
  if (!folder) {
    if ((run.status === 0 || run.status === 1) && run.stderr.trim() === '' && run.stdout.trim() !== '') throw new AdmitError(`polyness proposed nothing: ${first(run.stdout)}`);
    if (run.status !== 0) throw failed();
    throw new AdmitError('polyness proposed nothing: it wrote no proposal');
  }
  if (run.status !== 0) throw failed();
  for (const f of ['polyflow.workflow.json', 'effect-invariants.mjs']) if (typeof folder[f] !== 'string') throw new AdmitError(`polyness wrote no ${f} in its proposal: what polyness writes is no longer what poly reads (PT31.4)`);

  let flow: { tools?: Record<string, { why?: unknown }> };
  try { flow = JSON.parse(folder['polyflow.workflow.json']) as typeof flow; } catch { throw new AdmitError('polyness wrote a polyflow.workflow.json that is not JSON (PT31.4)'); }
  const steps = Object.keys(flow.tools ?? {});
  if (!steps.length) throw new AdmitError('polyness wrote a workflow with no steps (PT31.4)');
  steps.forEach((s, i) => { if (s.length > 32 || !STEP_KEY.test(s)) throw new AdmitError(`polyness named a step that is not one to four words of lower-case letters and digits (step ${i + 1} of the workflow)`); });
  const verify = steps.find((s) => typeof flow.tools![s]?.why === 'string' && (flow.tools![s].why as string).startsWith('the verification')) ?? null;

  const t = translate(folder['effect-invariants.mjs'], steps, verify);
  const source = emitSource(name, steps, t.instances, t.rules);
  const evidence = {
    v: 1, kind: 'poly.proposal', name, steps,
    rules: t.rules.map(({ form: _f, ...r }) => r),
    notTranslatable: t.notTranslatable,
    thresholds: { ...PROPOSAL_THRESHOLDS },
    tool: { name: 'polyness', version: pin.version, pin: sha(canonicalize(pin as never)) },
    corpus: { kind: o.synthetic ? 'synthetic' : 'recorded', sessions: sessionsOf(transcripts) },
  };
  mkdirSync(join(o.out, 'src'), { recursive: true });
  writeFileSync(join(o.out, 'src', `${under(name)}.poly`), source);
  writeFileSync(join(o.out, 'proposal.json'), JSON.stringify(evidence, null, 2) + '\n');
  return { out: o.out, name, steps, rules: t.rules.length, notTranslatable: t.notTranslatable.length };
}
