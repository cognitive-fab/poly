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
  type: 'boolean' | 'number' | 'string' | 'object' | 'array';
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

/** The semantic type of a payload field's declared type (a payload has no check clause, PT2). */
export function payloadTy(t: A.TypeExpr): Ty {
  switch (t.kind) {
    case 'TBool': return { k: 'bool' };
    case 'TInt': return { k: 'int', lo: -Infinity, hi: Infinity };
    case 'TString': return { k: 'string' };
    case 'TRange': return { k: 'int', lo: t.lo, hi: t.hi };
    case 'TName': return { k: 'union', name: t.name };
    case 'TRef': return { k: 'ref' };
    case 'TMap': return { k: 'error' };
  }
}

export function isPayloadUnion(env: TypeEnv, t: Ty): boolean {
  return t.k === 'union' && !env.unions.get(t.name)!.isEnum;
}

function scalarShape(t: Ty): ShapeSpec | null {
  switch (t.k) {
    case 'bool': return { type: 'boolean' };
    case 'int': return { type: 'number' };
    case 'string': return { type: 'string' };
    case 'union': return { type: 'string' };
    case 'map': return { type: t.array ? 'array' : 'object' };
    default: return null;
  }
}

export function layoutOf(m: A.Machine, facts: MachineFacts, env: TypeEnv, module: string): { layout: Layout; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const refuse = (n: A.NodeBase, msg: string) => diagnostics.push(diag('PL0901', { module, machine: m.name, node: n.id, line: n.span?.line, col: n.span?.col }, msg));
  const fields: FieldLayout[] = [];
  for (const f of m.fields) {
    const ty = facts.fieldTypes.get(f.name)!;
    if (ty.k === 'ref') { refuse(f, `Ref fields are lowered from milestone M1 (S18): ${f.name}`); continue; }
    if (ty.k === 'map' && (isPayloadUnion(env, ty.value) || ty.value.k === 'map' || ty.value.k === 'ref')) {
      refuse(f, `a map whose values are unions with payloads, maps or addresses is lowered after milestone M0: ${f.name}`);
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
          const pty = payloadTy(pf.type);
          if (pf.type.kind === 'TName' && !env.unions.get(pf.type.name)?.isEnum) refuse(f, `a payload that is itself a union with payloads is lowered after milestone M0: ${c.name}.${pf.name}`);
          if (pf.type.kind === 'TMap' || pf.type.kind === 'TRef') refuse(f, `a map or address payload is lowered after milestone M0: ${c.name}.${pf.name}`);
          ctors[c.name].push([pf.name, key]);
          if (!payloads.some(([p]) => p === pf.name)) {
            payloads.push([pf.name, key]);
            shapes[key] = { ...(scalarShape(pty) ?? { type: 'string' }), nullable: true };
          }
        }
      }
      fields.push({ field: f.name, ty, kind: 'union', flat: [f.name, ...payloads.map(([, k]) => k)], shapes, ctors, payloads });
      continue;
    }
    const shape = scalarShape(ty)!;
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
