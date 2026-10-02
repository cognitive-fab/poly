// The text form of a check report (PT12, README): each diagnostic with its
// witness, the stages that ran and did not run, and the verdict with its
// checked instance (PT12.3a). A verdict without its instance is not a valid
// output, so the instance line is printed for every machine that reached
// translation validation, and its absence is stated for any that did not.
import { basename } from 'node:path';
import type { Diagnostic } from '@poly/core';
import type { CheckReport, ConfigCheck, MachineCheck } from './pipeline.js';

function value(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return `[${v.map(value).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 1 && entries[0][1] && typeof entries[0][1] === 'object' && !Array.isArray(entries[0][1])) {
    // A union value { Ctor: { payload } }.
    return `${entries[0][0]}{${Object.entries(entries[0][1] as object).map(([k, x]) => `${k}:${value(x)}`).join(',')}}`;
  }
  return `{${entries.map(([k, x]) => `${k}:${value(x)}`).join(',')}}`;
}

function state(s: unknown): string {
  if (s && typeof s === 'object' && !Array.isArray(s)) return Object.values(s as object).map(value).join('/');
  return value(s);
}

function call(action: string, data: unknown): string {
  const vals = data && typeof data === 'object' ? Object.values(data as object).map(value) : [];
  return `${action}(${vals.join(', ')})`;
}

export function renderDiagnostic(d: Diagnostic, file: string): string[] {
  const where = `${basename(file)}${d.at.line ? `:${d.at.line}` : ''}`;
  // The header names what the finding is about: its property or field, else its machine (README).
  const about = d.property ?? d.field ?? d.at.machine;
  const lines = [`${where}  ${d.code} ${d.name}${about ? `  ${about}` : ''}`, `  ${d.message}`];
  if (d.witness && d.witness.trace.length && d.witness.trace.every((s) => s.global)) {
    // PT7a: a configuration's witness is its global steps, each an input or a delivery at an instance.
    lines.push(`  witness (${d.witness.length} global step${d.witness.length === 1 ? '' : 's'}):`);
    const rows = d.witness.trace.map((s) => [`${s.global!.kind.padEnd(8)}${s.global!.text}`, s.verdict && s.verdict !== 'accepted' ? s.verdict : '']);
    const w = Math.max(...rows.map((r) => r[0].length));
    rows.forEach((r, i) => {
      // A liveness lasso (S74): the prefix, then the cycle, as for a machine (review, minor).
      if (i === d.witness!.cycle) lines.push(`    cycle, repeated for ever:`);
      lines.push(`    ${r[1] ? `${r[0].padEnd(w)}   ${r[1]}` : r[0]}`);
    });
  } else if (d.witness && d.witness.trace.length) {
    lines.push(`  witness (${d.witness.length} step${d.witness.length === 1 ? '' : 's'}):`);
    const note = (s: { verdict?: string; effects?: string[] }) => [s.verdict && s.verdict !== 'accepted' ? s.verdict : '', s.effects?.length ? `emits ${s.effects.join(', ')}` : ''].filter(Boolean).join('   ');
    const rows = d.witness.trace.map((s) => [call(s.action, s.data), state(s.pre), state(s.post), note(s)]);
    const w0 = Math.max(...rows.map((r) => r[0].length));
    const w1 = Math.max(...rows.map((r) => r[1].length));
    // A liveness lasso (S74): the prefix, then the cycle, which returns to its first state.
    rows.forEach((r, i) => {
      if (i === d.witness!.cycle) lines.push(`    cycle, repeated for ever:`);
      lines.push(`    ${r[0].padEnd(w0)}   ${r[1].padEnd(w1)} -> ${r[2]}${r[3] ? `   ${r[3]}` : ''}`);
    });
  }
  if (d.testExport) lines.push(`  ${d.testExport}`);
  const rejections = (d as Diagnostic & { rejections?: string[] }).rejections;
  if (rejections?.length) lines.push(`  then ${rejections.join(', ')}`);
  // PT12.1: each fix by its id, which `poly fix` takes, and what it does.
  for (const f of d.fixes ?? []) {
    const e = f.edit as { op: string; with?: string; stmt?: string };
    lines.push(`  fix ${f.id}: ${e.op}${e.with ? ` with ${e.with.split('\n')[0]}${e.with.includes('\n') ? ' …' : ''}` : e.stmt ? ` ${e.stmt}` : ''}`);
  }
  return lines;
}

function instanceLine(m: MachineCheck, module: string | null): string {
  if (!m.instance) return `${module}.${m.machine}: no checked instance (the machine did not reach translation validation)`;
  const i = m.instance;
  const parts = [...i.domains];
  parts.push(`${i.states} states`);
  if (i.jointStates !== undefined) parts.push(`${i.jointStates} joint states with its attached children`);
  if (i.bounds.length) parts.push(`bound hit: ${i.bounds.join(', ')}`);
  parts.push(`kernel assumptions ${i.kernelAssumptions.join(', ')}`);
  return `${module}.${m.machine}  over ${parts.join('; ')}`;
}

function configLine(c: ConfigCheck, module: string | null): string {
  if (!c.instance) return `${module}.${c.configuration}: no checked instance (the configuration was not explored)`;
  const i = c.instance;
  return `${module}.${c.configuration}  over ${[i.instances.join(', '), ...i.bounds, `${i.states} global states`, `kernel assumptions ${i.kernelAssumptions.join(', ')}`].join('; ')}`;
}

export function render(r: CheckReport): string {
  const out: string[] = [];
  for (const d of r.diagnostics) out.push(...renderDiagnostic(d, r.file));
  for (const m of r.machines) for (const d of m.diagnostics) out.push(...renderDiagnostic(d, r.file));
  for (const c of r.configurations ?? []) for (const d of c.diagnostics) out.push(...renderDiagnostic(d, r.file));
  if (r.error) out.push(`error: ${r.error}`);
  for (const m of r.machines) {
    const ran = m.stages.filter((s) => s.status === 'ran').map((s) => `${s.stage} ${s.verdict}${s.note ? ` (${s.note})` : ''}`);
    const notRun = m.stages.filter((s) => s.status === 'not-run');
    out.push(`${m.machine}: ${ran.join(' · ')}`);
    if (notRun.length) out.push(`  not run: ${notRun.map((s) => s.stage).join(', ')} (${notRun[0].reason})`);
    for (const p of m.notRun) out.push(`  not run: ${p.property}, ${p.reason}`);
    for (const p of m.vacuous) out.push(`  vacuous: ${p.property}, its antecedent ${p.antecedent} is never true${p.member !== undefined ? ` for member ${p.member}` : ''} (PT12.3)`);
    for (const s of m.stages) for (const n of s.notes ?? []) out.push(`  note: ${n}`);
  }
  for (const c of r.configurations ?? []) {
    const ran = c.stages.filter((s) => s.status === 'ran').map((s) => `${s.stage} ${s.verdict}${s.note ? ` (${s.note})` : ''}`);
    const notRun = c.stages.filter((s) => s.status === 'not-run');
    out.push(`configuration ${c.configuration}: ${ran.join(' · ')}`);
    if (notRun.length) out.push(`  not run: ${notRun.map((s) => s.stage).join(', ')} (${notRun[0].reason})`);
    for (const p of c.notRun) out.push(`  not run: ${p.property}, ${p.reason}`);
    for (const p of c.vacuous) out.push(`  vacuous: ${p.property}, its antecedent ${p.antecedent} is never true${p.member !== undefined ? ` for member ${p.member}` : ''} (PT12.3)`);
    for (const s of c.stages) for (const n of s.notes ?? []) out.push(`  note: ${n}`);
  }
  const instances = [...r.machines.map((m) => instanceLine(m, r.module)), ...(r.configurations ?? []).map((c) => configLine(c, r.module))];
  out.push(`verdict: ${r.verdict} (exit ${r.exit})${instances.length ? `  ${instances[0]}` : ''}`);
  for (const line of instances.slice(1)) out.push(`         ${line}`);
  // S35: a reject property that names an action with no handler is decided by poly-ref alone, and says so.
  for (const m of r.machines) for (const x of m.instance?.refOnly ?? []) out.push(`         ${m.machine}: ${x.property} decided by poly-ref alone (it names ${x.actions.join(', ')}, which has no handler; polygraph never takes that step)`);
  // S38: with no path property, polyrun check-effects cannot run, and emission without a state change is poly-ref's alone.
  for (const m of r.machines) if (m.instance?.effectsByRefOnly) out.push(`         ${m.machine}: emission without a state change (PL4002) decided by poly-ref alone (polyrun check-effects did not run: no path property, S38, or the machine spawns detached children, S60)`);
  // A parent with attached children and no compose invariant: check-product needs one, so the joint check is poly-ref's.
  for (const m of r.machines) if (m.instance?.compositionByRefOnly) out.push(`         ${m.machine}: the joint machine decided by poly-ref alone (polyrun check-product did not run: no compose invariant, or the parent spawns detached children, S60)`);
  out.push(`engines: ${Object.entries(r.engines).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  return out.join('\n') + '\n';
}
