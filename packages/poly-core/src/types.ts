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

export interface TypeEnv {
  unions: Map<string, UnionInfo>;
  /** Constructor name to the unions that declare it. Two unions may share a name; uses are then resolved by expected type. */
  ctorOwners: Map<string, string[]>;
}

export function buildTypeEnv(module: Module): TypeEnv {
  const unions = new Map<string, UnionInfo>();
  const ctorOwners = new Map<string, string[]>();
  for (const d of module.decls) {
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
  return { unions, ctorOwners };
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
export function cardinality(t: TypeExpr, env: TypeEnv, check: CheckClause | null = null): number | null {
  if (check) return domainSize(check.domain);
  switch (t.kind) {
    case 'TBool': return 2;
    case 'TInt':
    case 'TString':
      return null;
    case 'TRange': return Math.max(0, t.hi - t.lo + 1);
    case 'TRef': return 1; // `none` alone in a single-machine check (PS1.6)
    case 'TName': {
      const u = env.unions.get(t.name);
      if (!u) return null;
      let n = 0;
      for (const c of u.ctors) {
        let k = 1;
        for (const f of c.fields) {
          const m = cardinality(f.type, env);
          if (m === null) return null;
          k *= m;
        }
        n += k;
      }
      return n;
    }
    case 'TMap': {
      const keys = cardinality(t.key, env);
      const vals = cardinality(t.value, env);
      if (keys === null || vals === null) return null;
      return vals ** keys;
    }
  }
}
