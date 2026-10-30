// Goals (PS13.10, PT14a): `poly check --goals <file>`. A goal is a predicate on a configuration's global states,
// written like a configuration invariant and expected to fail; it is reached when some explored state breaks it. Goals
// replace the probe copies a host used to write (agentapp's witness.mjs): each joins its configuration's exploration,
// and none is a property of the program, so the configuration's verdict is the same with or without them.
import { readFileSync } from 'node:fs';
import { parse } from '@poly/lang';
import type { Diagnostic, Module } from '@poly/core';
import type * as A from '@poly/core';
import type { ConfigGoal } from '@poly/ref';

/** A usage error in what a check was asked (PT14a): a configuration, goal or defect the program does not have. */
export class CheckUsageError extends Error {}

/** One goal as the file states it. */
export interface GoalSpec {
  configuration: string;
  name: string;
  expr: string;
  /** What the goal stands for, in words; printed beside it. */
  path?: string;
}

/** A goal ready for poly-ref: its name, its predicate as parsed and type-checked in its configuration, and its words. */
export interface TypedGoal extends ConfigGoal {
  path?: string;
}

/** Reads a goals file: a JSON array of { configuration, name, expr, path? }. */
export function readGoals(file: string): GoalSpec[] {
  let list: unknown;
  try { list = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new CheckUsageError(`the goals file ${file} is not JSON: ${(e as Error).message}`); }
  if (!Array.isArray(list)) throw new CheckUsageError(`the goals file ${file} is not an array of goals`);
  const seen = new Set<string>();
  return list.map((g, i) => {
    const x = g as Record<string, unknown>;
    for (const k of ['configuration', 'name', 'expr']) if (typeof x?.[k] !== 'string' || !(x[k] as string).trim()) throw new CheckUsageError(`goal ${i + 1} of ${file} has no ${k}`);
    if (x.path !== undefined && typeof x.path !== 'string') throw new CheckUsageError(`goal ${x.name} of ${file}: path is not text`);
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(x.name as string)) throw new CheckUsageError(`goal ${x.name} of ${file}: a name is a letter or _ then letters, digits, _ or -`);
    const id = `${x.configuration}/${x.name}`;
    if (seen.has(id)) throw new CheckUsageError(`goal ${x.name} is named twice in configuration ${x.configuration}`);
    seen.add(id);
    return { configuration: x.configuration as string, name: x.name as string, expr: x.expr as string, ...(x.path ? { path: x.path as string } : {}) };
  });
}

/**
 * PT14a: each goal parsed and type-checked as an invariant of its configuration. The goals are written into a copy of
 * the source, at the end of their configurations, and the copy is checked with `check`, which runs stage 0 as the check
 * does. It is called only on a source stage 0 accepts, so an error of the copy is a goal's, and it refuses the goals
 * file (a usage error naming the goal). The predicates handed to poly-ref are the copy's, which mean what they say in the source.
 */
export function typedGoals(src: string, original: Module, specs: GoalSpec[], check: (copy: Module) => Diagnostic[]): Map<string, TypedGoal[]> {
  const out = new Map<string, TypedGoal[]>();
  if (!specs.length) return out;
  const configs = new Map(original.decls.filter((d): d is A.Configuration => d.kind === 'Configuration').map((d) => [d.name, d]));
  for (const g of specs) {
    const c = configs.get(g.configuration);
    if (!c) throw new CheckUsageError(`goal ${g.name} names the configuration ${g.configuration}, which module ${original.name} does not declare`);
    if (c.properties.some((p) => p.name === g.name)) throw new CheckUsageError(`goal ${g.name} has the name of a property of configuration ${g.configuration}`);
    if (!c.span) throw new CheckUsageError(`configuration ${g.configuration} has no source position to add goals to`);
  }
  // Each configuration's closing brace, found back from the end of its span; the goals go in before it, last first so
  // that an earlier insertion does not move a later one.
  const text = src.replace(/\r\n/g, '\n');
  const lineStart: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStart.push(i + 1);
  const inserted: { config: string; at: number; lines: string[] }[] = [];
  for (const name of [...new Set(specs.map((g) => g.configuration))]) {
    const span = configs.get(name)!.span!;
    const end = (lineStart[span.endLine - 1] ?? text.length) + span.endCol;
    const brace = text.lastIndexOf('}', Math.min(end, text.length - 1));
    if (brace < 0) throw new CheckUsageError(`configuration ${name}: its closing brace was not found`);
    inserted.push({ config: name, at: brace, lines: specs.filter((g) => g.configuration === name).map((g) => `  invariant ${g.name}: ${g.expr}`) });
  }
  inserted.sort((a, b) => b.at - a.at);
  let copyText = text;
  for (const x of inserted) copyText = `${copyText.slice(0, x.at)}\n${x.lines.join('\n')}\n${copyText.slice(x.at)}`;
  const parsed = parse(copyText);
  const goalNames = new Set(specs.map((g) => g.name));
  if (!parsed.module) {
    const first = parsed.diagnostics.find((d) => d.severity === 'error');
    throw new CheckUsageError(`the goals do not parse in their configurations: ${first?.message ?? 'no module'}`);
  }
  const parseErrors = parsed.diagnostics.filter((d) => d.severity === 'error');
  if (parseErrors.length) throw new CheckUsageError(`the goals do not parse in their configurations: ${parseErrors[0].message}`);
  // Called only on a source stage 0 accepts, so every error of the copy is a goal's.
  const errors = check(parsed.module).filter((d) => d.severity === 'error');
  if (errors.length) {
    const d = errors[0];
    // The goal is named by the line it was written on in the copy, or by its node.
    const lineOf = new Map(copyText.split('\n').flatMap((l, i) => { const m = /^ {2}invariant ([A-Za-z0-9_-]+): /.exec(l); return m && goalNames.has(m[1]) ? [[i + 1, m[1]] as const] : []; }));
    const named = (d.at.line !== undefined ? lineOf.get(d.at.line) : undefined) ?? [...goalNames].find((n) => d.at.node?.includes(`/prop:${n}`));
    throw new CheckUsageError(`${named ? `goal ${named}` : 'a goal'} is refused in its configuration: ${d.code} ${d.message}`);
  }
  for (const g of specs) {
    const decl = parsed.module.decls.find((d): d is A.Configuration => d.kind === 'Configuration' && d.name === g.configuration)!;
    const p = decl.properties.find((x) => x.name === g.name);
    if (!p || p.kind !== 'Property') throw new CheckUsageError(`goal ${g.name}: its predicate did not parse as an invariant of ${g.configuration}`);
    out.set(g.configuration, [...(out.get(g.configuration) ?? []), { name: g.name, expr: p.expr, ...(g.path ? { path: g.path } : {}) }]);
  }
  return out;
}
