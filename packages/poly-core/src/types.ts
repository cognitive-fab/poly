// Types and check domains (PT3, PS1.4): the declared unions of a module,
// printing, and the finiteness that PT3.2 requires of every checked field.
import type { CheckClause, Domain, Module, TypeExpr, Literal } from './ast.js';

export interface CtorInfo {
  name: string;
  fields: { name: string; type: TypeExpr }[];
}

export interface UnionInfo {
  name: string;
  ctors: CtorInfo[];
  /** Declared with `enum`, or a `type` whose constructors carry no payload. */
  isEnum: boolean;
}

/** A record type (S25): its fields, in declaration order. */
export interface RecordInfo {
  name: string;
  fields: { name: string; type: TypeExpr }[];
}

export interface TypeEnv {
  unions: Map<string, UnionInfo>;
  records: Map<string, RecordInfo>;
  /** Constructor name to the unions that declare it. Two unions may share a name; uses are then resolved by expected type. */
  ctorOwners: Map<string, string[]>;
}

export function buildTypeEnv(module: Module): TypeEnv {
  const unions = new Map<string, UnionInfo>();
  const ctorOwners = new Map<string, string[]>();
  const records = new Map<string, RecordInfo>();
  for (const d of module.decls) {
    if (d.kind === 'RecordDecl') {
      if (!records.has(d.name) && !unions.has(d.name)) records.set(d.name, { name: d.name, fields: d.fields.map((f) => ({ name: f.name, type: f.type })) });
      continue;
    }
    let info: UnionInfo | null = null;
    if (d.kind === 'EnumDecl') info = { name: d.name, ctors: d.members.map((m) => ({ name: m, fields: [] })), isEnum: true };
    if (d.kind === 'TypeDecl') {
      const ctors = d.ctors.map((c) => ({ name: c.name, fields: c.fields.map((f) => ({ name: f.name, type: f.type })) }));
      info = { name: d.name, ctors, isEnum: ctors.every((c) => c.fields.length === 0) };
    }
    if (!info || unions.has(info.name)) continue; // duplicates are reported by the checker (PL1002)
    unions.set(info.name, info);
    for (const c of info.ctors) ctorOwners.set(c.name, [...(ctorOwners.get(c.name) ?? []), info.name]);
  }
  // S76: Tri is usable in machines, as the enum True | False | Unknown, when the module names it and declares no Tri.
  if (!unions.has('Tri') && !records.has('Tri') && namesType(module.decls, 'Tri')) {
    const tri: UnionInfo = { name: 'Tri', ctors: ['True', 'False', 'Unknown'].map((name) => ({ name, fields: [] })), isEnum: true };
    unions.set('Tri', tri);
    for (const c of tri.ctors) ctorOwners.set(c.name, [...(ctorOwners.get(c.name) ?? []), 'Tri']);
  }
  return { unions, ctorOwners, records };
}

export function typeToString(t: TypeExpr): string {
  switch (t.kind) {
    case 'TBool': return 'bool';
    case 'TInt': return 'int';
    case 'TString': return 'string';
    case 'TName': return t.name;
    case 'TRange': return `${t.lo}..${t.hi}`;
    case 'TMap': return `map<${typeToString(t.key)}, ${typeToString(t.value)}>`;
    case 'TRef': return `Ref<${t.machine.join('.')}>`;
    case 'TConf': return 'Conf';
  }
}

export function literalToString(l: Literal): string {
  switch (l.kind) {
    case 'Int': return String(l.value);
    case 'Bool': return String(l.value);
    case 'String': return JSON.stringify(l.value);
    case 'Name': return l.name;
  }
}

export function domainToString(d: Domain): string {
  return d.kind === 'DomainRange' ? `${d.lo}..${d.hi}` : `{${d.values.map(literalToString).join(', ')}}`;
}

export function domainSize(d: Domain): number {
  return d.kind === 'DomainRange' ? Math.max(0, d.hi - d.lo + 1) : d.values.length;
}

/**
 * The number of values a type takes in the checked instance, or null when it
 * is unbounded (PT3.2). `int` and `string` are finite only with a check clause.
 */
export function cardinality(t: TypeExpr, env: TypeEnv, check: CheckClause | null = null, visiting: Set<string> = new Set()): number | null {
  if (check) return domainSize(check.domain);
  switch (t.kind) {
    case 'TBool': return 2;
    case 'TInt':
    case 'TString':
      return null;
    case 'TRange': return Math.max(0, t.hi - t.lo + 1);
    case 'TRef': return 1; // `none` alone in a single-machine check (PS1.6)
    case 'TConf': return 1001; // 0..1000 at runtime; explored by the intervals the program uses (PD1.4b)
    case 'TName': {
      // A type that refers to itself has no finite domain; the checker reports the recursion (S25).
      if (visiting.has(t.name)) return null;
      visiting = new Set([...visiting, t.name]);
      const r = env.records.get(t.name);
      if (r) {
        // A record is finite when its fields are (S25); recursion is refused by the checker, so this ends.
        let k = 1;
        for (const f of r.fields) {
          const m = cardinality(f.type, env, null, visiting);
          if (m === null) return null;
          k *= m;
        }
        return k;
      }
      const u = env.unions.get(t.name);
      if (!u) return null;
      let n = 0;
      for (const c of u.ctors) {
        let k = 1;
        for (const f of c.fields) {
          const m = cardinality(f.type, env, null, visiting);
          if (m === null) return null;
          k *= m;
        }
        n += k;
      }
      return n;
    }
    case 'TMap': {
      const keys = cardinality(t.key, env, null, visiting);
      const vals = cardinality(t.value, env, null, visiting);
      if (keys === null || vals === null) return null;
      return vals ** keys;
    }
  }
}

/** Whether a TName of this name appears anywhere below the node. */
function namesType(n: unknown, name: string): boolean {
  if (!n || typeof n !== 'object') return false;
  if (Array.isArray(n)) return n.some((x) => namesType(x, name));
  const o = n as { kind?: string; name?: string };
  if (o.kind === 'TName' && o.name === name) return true;
  return Object.entries(o).some(([k, v]) => k !== 'span' && namesType(v, name));
}
