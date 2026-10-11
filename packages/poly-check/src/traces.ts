// `poly export traces` (PF10.1, PS19, PT29): the journals of one certified build as a trace corpus. The corpus is a
// projection: values for what has a declared check domain, a salted token for everything else, no body, no run id,
// no time of day. Erased steps are left out and counted, never named (PS19.5). It reads the store and writes no chain.
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { canonicalize } from '@poly/core';
import type * as A from '@poly/core';
import { alphaData, buildMachine, inCheckDomain, type RMachine, type RType } from '@poly/ref';
import { certifiedProgram } from './replay.js';

export class TraceUsageError extends Error {}

export interface TraceOptions {
  db: string;
  build: string;
  certificate: string;
  /** keyId to the public key's text, as `poly journal replay` takes it. */
  trust: Record<string, string>;
  out: string;
  runs?: string[];
}

export interface TraceHeader {
  v: 1;
  kind: 'poly.traces';
  project: string;
  certificate: string;
  episodes: number;
  omitted: { adviceEvents: number; runtimeRuns: number; archivedRuns: number; erasedSteps: number; gappedRuns: number; erasedRuns: number };
  unknown: { consequence: number };
}

// The kernel's own rows (PS3.3, S89): they have no action of the module, so their data has no parameters to read.
const KERNEL_ROWS = new Set(['$create', '$undeliverable', '$migrate']);
const DIGEST = /^sha256:[0-9a-f]{64}$/;
// The gate's decisions (PT9); the worker also records a gate verdict when it settles the effect (outcome 'settled'), which decides nothing.
const GATE_OUTCOMES = new Set(['allowed', 'denied', 'escalated', 'late', 'held']);

/** PS19.4: a type whose every value has a declared domain, so its value may leave as itself. A string has one only through a check clause. */
function plainType(t: RType, M: RMachine, seen = new Set<string>()): boolean {
  switch (t.k) {
    case 'bool': case 'conf': return true;
    case 'int': return Number.isFinite(t.lo) && Number.isFinite(t.hi);
    case 'union': {
      if (seen.has(t.name)) return true;
      seen.add(t.name);
      return M.unions.get(t.name)!.ctors.every((c) => c.fields.every((f) => plainType(f.type, M, seen)));
    }
    case 'record': {
      if (seen.has(t.name)) return true;
      seen.add(t.name);
      return M.records.get(t.name)!.fields.every((f) => plainType(f.type, M, seen));
    }
    case 'map': return plainType(t.key, M, seen) && plainType(t.value, M, seen);
    default: return false;
  }
}

/** Every digest in a journal value, to meet the forget events' erased set (PS11.3a). */
function digestsIn(x: unknown, acc: Set<string> = new Set()): Set<string> {
  if (typeof x === 'string') { if (DIGEST.test(x)) acc.add(x); } else if (x && typeof x === 'object') for (const v of Object.values(x)) digestsIn(v, acc);
  return acc;
}

export async function exportTraces(o: TraceOptions): Promise<{ header: TraceHeader; path: string }> {
  if (!o.out) throw new TraceUsageError('poly export traces needs --out <file>');
  if (existsSync(o.out)) throw new TraceUsageError(`${o.out} exists: poly export traces does not overwrite a file`);
  // The runtime is loaded only here, as journal.ts does, so `poly check` runs in a toolchain without it.
  const { load } = await import('@poly/runtime');
  const rt = await load(o.build, { certificate: o.certificate, trust: o.trust, store: { sqlite: o.db } });
  try {
    const { modules, program } = certifiedProgram(rt);
    // PS19.4, PT29.4: the salt lives here and nowhere else.
    const salt = randomBytes(32);
    const token = (x: unknown) => `d:${createHmac('sha256', salt).update(canonicalize(x)).digest('hex').slice(0, 32)}`;
    const erased = rt.forgottenBodies();
    const instances = (await rt.instances()).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const live = new Map(instances.map((i) => [i.id, i]));
    const want = o.runs && o.runs.length ? new Set(o.runs) : null;
    const header: TraceHeader = {
      v: 1, kind: 'poly.traces', project: rt.certificate.subject.project, certificate: rt.certificate.digest, episodes: 0,
      omitted: { adviceEvents: 0, runtimeRuns: 0, archivedRuns: 0, erasedSteps: 0, gappedRuns: 0, erasedRuns: 0 },
      unknown: { consequence: 0 },
    };
    const lines: string[] = [];
    const machines = new Map<string, RMachine>();

    for (const run of await rt.runs()) {
      if (want && !want.has(run.run)) continue;
      const inst = live.get(run.run);
      if (run.run.startsWith('runtime:')) { header.omitted.runtimeRuns++; continue; }
      if (!inst) { header.omitted.archivedRuns++; continue; }
      if (rt.modelOf(inst.machineId)) { header.omitted.runtimeRuns++; continue; }
      const chain = await rt.chain(inst.id);
      header.omitted.adviceEvents += chain.filter((e) => e.kind === 'advice').length;
    }

    for (const inst of instances) {
      if (want && !want.has(inst.id)) continue;
      if (inst.id.startsWith('runtime:') || rt.modelOf(inst.machineId)) continue;
      const modName = inst.machineId.slice(0, inst.machineId.indexOf('.'));
      const machineName = inst.machineId.slice(inst.machineId.indexOf('.') + 1);
      const module = modules.get(modName) as A.Module | undefined;
      if (!module) continue;
      let M = machines.get(inst.machineId);
      if (!M) { M = buildMachine(module, machineName, { program }); machines.set(inst.machineId, M); }
      const rows = (await rt.getJournal(inst.id)) as unknown as { seq: number; action: string; data: Record<string, unknown>; pre: Record<string, unknown>; post: Record<string, unknown>; step_kind: string; reject_reason: string | null }[];
      const chain = await rt.chain(inst.id);
      const outbox = (await rt.outbox(inst.id)) as unknown as { intent_id: string; seq: number | string; kind: string }[];
      const manifest = rt.verified.machines.find((m) => m.id === inst.machineId)?.manifest?.effects ?? {};
      // PT29.6, S503: the manifest writes class none for an effect that declares none, so what the source declared is read
      // from the certified module. An effect whose `class` the source omits has no known consequence.
      const declared = new Map<string, string | null>();
      const machineDecl = module.decls.find((d): d is A.Machine => d.kind === 'Machine' && d.name === machineName);
      for (const it of machineDecl?.items ?? []) {
        if (it.kind !== 'EffectDecl') continue;
        const k = it.items.find((x) => x.kind === 'EffKind');
        const c = it.items.find((x) => x.kind === 'EffClass');
        declared.set(k && k.kind === 'EffKind' ? k.value : it.name, c && c.kind === 'EffClass' ? c.value : null);
      }
      // The gate's last decision on each intent of the run (a re-proposal after an approval supersedes the escalation).
      const gate = new Map<string, { outcome: string; reason: string | null }>();
      for (const e of chain) {
        const b = e.body as Record<string, unknown> | null;
        if (e.kind === 'verdict' && b?.stage === 'gate' && typeof b.intent === 'string' && GATE_OUTCOMES.has(String(b.outcome))) gate.set(b.intent, { outcome: String(b.outcome), reason: typeof b.reason === 'string' ? b.reason : null });
      }

      const fieldOf = new Map<string, { type: RType; check: unknown[] | null }>();
      for (const f of M.fields) {
        fieldOf.set(f.name, { type: f.type, check: f.check });
        if (f.type.k === 'union') for (const c of M.unions.get(f.type.name)?.ctors ?? []) for (const pf of c.fields) fieldOf.set(`${f.name}_${pf.name}`, { type: pf.type, check: null });
      }
      const state = (flat: Record<string, unknown>) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(flat ?? {})) {
          const f = fieldOf.get(k);
          if (!f) continue;
          out[k] = (f.check ? f.type.k !== 'string' || (typeof v === 'string' && f.check.some((c) => c === v)) : plainType(f.type, M!)) ? v : token(v);
        }
        return out;
      };

      const steps: unknown[] = [];
      let gapped = false;
      for (const row of rows) {
        const named = new Set([...digestsIn(row.data), ...digestsIn(row.pre), ...digestsIn(row.post)]);
        if ([...named].some((d) => erased.has(d))) { gapped = true; header.omitted.erasedSteps++; continue; }
        const data: Record<string, unknown> = {};
        const outside: string[] = [];
        const action = M.actions.find((a) => a.name === row.action);
        if (action && !KERNEL_ROWS.has(row.action)) {
          let structured: Record<string, unknown> | null = null;
          try { structured = alphaData(row.data ?? {}, row.action, M) as Record<string, unknown>; } catch { structured = null; }
          for (const p of action.params) {
            if (!(p.name in (row.data ?? {}))) continue;
            const v = row.data[p.name];
            let inDomain = true;
            try { inDomain = structured ? inCheckDomain(structured[p.name] as never, p, M) : false; } catch { inDomain = false; }
            const hasDomain = p.check !== null || plainType(p.type, M);
            // S504: only a disclosed parameter can be journaled outside its check domain; a strict one is rejected at dispatch.
            if (!p.strict && hasDomain && !inDomain) outside.push(p.name);
            // A string leaves as itself only inside a declared domain; a number or a flag is no body, in or out of it.
            const plain = p.check ? (p.type.k === 'string' ? inDomain : true) : plainType(p.type, M);
            data[p.name] = plain && (p.type.k === 'int' || p.type.k === 'bool' || p.type.k === 'conf' || inDomain) ? v : token(v);
          }
        }
        const effects = outbox.filter((x) => Number(x.seq) === row.seq).map((x) => {
          const m = manifest[x.kind] as { labels?: string[]; class?: string } | undefined;
          const consequence = (declared.has(x.kind) ? declared.get(x.kind) : m?.class) ?? 'unknown';
          if (consequence === 'unknown') header.unknown.consequence++;
          return { kind: x.kind, labels: m?.labels ?? [], consequence, gate: gate.get(x.intent_id) ?? null };
        });
        steps.push({ seq: row.seq, action: row.action, stepKind: row.step_kind, rejectReason: row.reject_reason ?? null, pre: state(row.pre), data, post: state(row.post), effects, outsideCheckDomain: outside });
      }
      if (rows.length && !steps.length) { header.omitted.erasedRuns++; continue; }
      if (gapped) header.omitted.gappedRuns++;
      const outcomes = chain.filter((e) => e.kind === 'outcome').map((e) => { const b = e.body as { decision?: string; outcome?: string }; return { decision: b.decision ?? null, outcome: b.outcome ?? null }; });
      header.episodes++;
      lines.push(JSON.stringify({ episode: token(inst.id), machine: inst.machineId, gapped, steps, outcomes }));
    }
    writeFileSync(o.out, [JSON.stringify(header), ...lines].join('\n') + '\n', { flag: 'wx' });
    return { header, path: o.out };
  } finally { await rt.close(); }
}
