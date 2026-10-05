// The flat layout of a machine's state (PS9.1b).
//
// The SAM sealed shape is flat, so a union field whose constructors carry
// payloads lowers to a tag field `f` plus one nullable field `f_<payload>`
// per payload name; constructors that share a payload name share its field
// (S9). An enum is a string, a map keyed by an enum is an object keyed by
// constructor name, and a map keyed by 0..n is an array (S4).
import type * as A from '@poly/core';
import { diag, type Diagnostic, type MachineFacts, type Ty, type TypeEnv } from '@poly/core';

export interface ShapeSpec {
  type: 'boolean' | 'number' | 'string' | 'object' | 'array' | ('string' | 'object')[];
  nullable?: boolean;
}

export interface FieldLayout {
  field: string;
  ty: Ty;
  kind: 'scalar' | 'enum' | 'union' | 'map';
  /** Flat keys, in order: the field itself, then its payload fields. */
  flat: string[];
  shapes: Record<string, ShapeSpec>;
  /** union: constructor to its [payload, flat key] pairs. */
  ctors?: Record<string, [string, string][]>;
  /** union: every [payload, flat key] pair. */
  payloads?: [string, string][];
}

export interface Layout {
  fields: FieldLayout[];
  byField: Map<string, FieldLayout>;
  flatKeys: string[];
}

/**
 * The semantic type of a declared type, for a parameter or a payload field. The one mapping the
 * lowering uses (review finding 9): the program was checked first, so every name is a known type.
 */
export function tyOfTypeExpr(t: A.TypeExpr, env?: TypeEnv): Ty {
  switch (t.kind) {
    case 'TBool': return { k: 'bool' };
    case 'TInt': return { k: 'int', lo: -Infinity, hi: Infinity };
    case 'TString': return { k: 'string' };
    case 'TRange': return { k: 'int', lo: t.lo, hi: t.hi };
    case 'TName':
      if (env?.records.has(t.name)) return { k: 'record', name: t.name };
      // PD5.1.2b: Principal is built in, unless the module declares a type of that name.
      if (t.name === 'Principal' && !env?.unions.has(t.name)) return { k: 'principal' };
      return { k: 'union', name: t.name };
    // S176: spelled as the checker spells it: M for this module's machine, m.M for a used module's.
    case 'TRef': return { k: 'ref', machine: t.machine.length > 1 && env?.module !== undefined && t.machine.slice(0, -1).join('.') !== env.module ? t.machine.join('.') : t.machine[t.machine.length - 1] };
    case 'TMap': return { k: 'map', key: tyOfTypeExpr(t.key, env), value: tyOfTypeExpr(t.value, env), array: t.key.kind === 'TRange' };
    case 'TConf': return { k: 'conf' };
  }
}

/** The values of a check clause, in declaration order (PT3.4): the one enumeration the lowering uses. */
export function checkDomainValues(check: A.CheckClause): unknown[] {
  const d = check.domain;
  return d.kind === 'DomainRange' ? Array.from({ length: d.hi - d.lo + 1 }, (_, i) => d.lo + i) : d.values.map((v) => (v.kind === 'Name' ? v.name : v.value));
}

export function isPayloadUnion(env: TypeEnv, t: Ty): boolean {
  return t.k === 'union' && !env.unions.get(t.name)!.isEnum;
}

function scalarShape(t: Ty, env: TypeEnv): ShapeSpec | null {
  switch (t.k) {
    case 'bool': return { type: 'boolean' };
    case 'int': return { type: 'number' };
    case 'string': return { type: 'string' };
    // S65: a union with payloads below the top of a field is one object, { $: C, payloads }.
    case 'union': return { type: isPayloadUnion(env, t) ? 'object' : 'string' };
    case 'map': return { type: t.array ? 'array' : 'object' };
    // S25: a record lowers to a plain JSON object.
    case 'record': return { type: 'object' };
    // S58: an address is the target instance's id; none is null.
    case 'ref': return { type: 'string', nullable: true };
    // PD5.1.2b: a principal is its identity's string; none is null.
    case 'principal': return { type: 'string', nullable: true };
    default: return null;
  }
}

export function layoutOf(m: A.Machine, facts: MachineFacts, env: TypeEnv, module: string): { layout: Layout; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const refuse = (n: A.NodeBase, msg: string) => diagnostics.push(diag('PL0901', { module, machine: m.name, node: n.id, line: n.span?.line, col: n.span?.col }, msg));
  const fields: FieldLayout[] = [];
  for (const f of m.fields) {
    const ty = facts.fieldTypes.get(f.name)!;
    if (ty.k === 'map' && (ty.value.k === 'map' || ty.value.k === 'ref')) {
      refuse(f, `a map whose values are maps or addresses is lowered after milestone M1: ${f.name}`);
      continue;
    }
    if (isPayloadUnion(env, ty)) {
      const u = env.unions.get((ty as { name: string }).name)!;
      const payloads: [string, string][] = [];
      const shapes: Record<string, ShapeSpec> = { [f.name]: { type: 'string' } };
      const ctors: Record<string, [string, string][]> = {};
      for (const c of u.ctors) {
        ctors[c.name] = [];
        for (const pf of c.fields) {
          const key = `${f.name}_${pf.name}`;
          const pty = tyOfTypeExpr(pf.type, env);
          if (pf.type.kind === 'TMap' || pf.type.kind === 'TRef') refuse(f, `a map or address payload is lowered after milestone M1: ${c.name}.${pf.name}`);
          ctors[c.name].push([pf.name, key]);
          if (!payloads.some(([p]) => p === pf.name)) {
            payloads.push([pf.name, key]);
            shapes[key] = { ...(scalarShape(pty, env) ?? { type: 'string' }), nullable: true };
          }
        }
      }
      fields.push({ field: f.name, ty, kind: 'union', flat: [f.name, ...payloads.map(([, k]) => k)], shapes, ctors, payloads });
      continue;
    }
    let shape = scalarShape(ty, env)!;
    // S78: a field that may hold a detached child's address holds the marker { $ref: "child", key } between the
    // acceptor's write and the kernel's commit, so the sealed shape admits an object there (sam-pattern 2.2, #35).
    if (ty.k === 'ref' && [...facts.detached.values()].includes(ty.machine ?? '')) shape = { type: ['string', 'object'], nullable: true };
    const kind = ty.k === 'map' ? 'map' : ty.k === 'union' ? 'enum' : 'scalar';
    fields.push({ field: f.name, ty, kind, flat: [f.name], shapes: { [f.name]: shape } });
  }
  return {
    layout: { fields, byField: new Map(fields.map((l) => [l.field, l])), flatKeys: fields.flatMap((l) => l.flat) },
    diagnostics,
  };
}

/**
 * JavaScript helpers the generated modules share: reading a flat union field
 * as a structured value, writing one back, and structural equality. They are
 * generated code, emitted into each artefact, so every artefact stands alone.
 */
export function prelude(layout: Layout): string {
  const shapes: Record<string, Record<string, [string, string][]>> = {};
  const flats: Record<string, [string, string][]> = {};
  for (const l of layout.fields) {
    if (l.kind !== 'union') continue;
    shapes[l.field] = l.ctors!;
    flats[l.field] = l.payloads!;
  }
  return [
    `// PS9.1b: each union field with payloads is a tag plus one nullable field per payload name.`,
    `const __SHAPES = ${JSON.stringify(shapes)};`,
    `const __FLAT = ${JSON.stringify(flats)};`,
    `/** The structured value { $: tag, payload… } of a flat union field. */`,
    `const __u = (s, f) => { const t = s[f]; const o = { $: t }; for (const [p, k] of (__SHAPES[f][t] || [])) o[p] = s[k]; return o; };`,
    `/** Writes a structured union value to its flat fields; payloads of other constructors become null. */`,
    `const __w = (next, f, v) => { next[f] = v.$; for (const [p, k] of __FLAT[f]) next[k] = (__SHAPES[f][v.$] || []).some(([q]) => q === p) ? v[p] : null; };`,
    `const __k = (v) => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? '[' + v.map(__k).join(',') + ']' : '{' + Object.keys(v).sort().map((x) => JSON.stringify(x) + ':' + __k(v[x])).join(',') + '}';`,
    `const __eq = (a, b) => __k(a) === __k(b);`,
  ].join('\n');
}
