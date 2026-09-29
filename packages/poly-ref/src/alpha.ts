// The abstraction function α of PS9.1b, and its inverse on the checked
// instance, written from the semantics, not from poly-lower.
//
// PS9.1b: a union field f lowers to a tag field f plus one nullable field
// f_<payload> per payload name of any constructor; constructors sharing a
// payload name share its field. PT3.1 (S4): an enum is its constructor's
// name, an enum-keyed map is an object keyed by constructor name, and a map
// keyed by 0..n is an array.
import type { RMachine, RType } from './model.js';
import { isMap, isUnion, type State, type Value } from './values.js';
import { valuesOf } from './model.js';

type Flat = Record<string, unknown>;

function hasPayloads(t: RType, M: RMachine): boolean {
  return t.k === 'union' && M.unions.get(t.name)!.ctors.some((c) => c.fields.length > 0);
}

/** Payload names of a union, each once, in declaration order. */
function payloadNames(t: RType, M: RMachine): string[] {
  if (t.k !== 'union') return [];
  const out: string[] = [];
  for (const c of M.unions.get(t.name)!.ctors) for (const f of c.fields) if (!out.includes(f.name)) out.push(f.name);
  return out;
}

function flatValue(v: Value, t: RType, M: RMachine): unknown {
  if (t.k === 'union') return isUnion(v) ? v.ctor : v; // an enum member is its name
  if (t.k === 'map') {
    if (!isMap(v)) return v;
    const vt = t.value;
    if (t.key.k === 'int') return v.entries.map(([, x]) => flatValue(x, vt, M));
    return Object.fromEntries(v.entries.map(([k, x]) => [isUnion(k) ? k.ctor : String(k), flatValue(x, vt, M)]));
  }
  return v;
}

/** The flat state a structured state lowers to. */
export function flatten(s: State, M: RMachine): Flat {
  const out: Flat = {};
  for (const f of M.fields) {
    const v = s[f.name];
    if (hasPayloads(f.type, M)) {
      const u = v as { ctor: string; payload: Record<string, Value> };
      out[f.name] = u.ctor;
      for (const p of payloadNames(f.type, M)) {
        const ptype = M.unions.get((f.type as { name: string }).name)!.ctors.flatMap((c) => c.fields).find((x) => x.name === p)!.type;
        out[`${f.name}_${p}`] = p in u.payload ? flatValue(u.payload[p], ptype, M) : null;
      }
    } else out[f.name] = flatValue(v, f.type, M);
  }
  return out;
}

/** Flat data for an action's parameters. */
export function flattenData(d: Record<string, Value>, action: string, M: RMachine): Flat {
  const a = M.actions.find((x) => x.name === action)!;
  return Object.fromEntries(a.params.map((p) => [p.name, flatValue(d[p.name], p.type, M)]));
}

function structValue(x: unknown, t: RType, M: RMachine): Value {
  if (t.k === 'union') return typeof x === 'string' ? { ctor: x, payload: {} } : (x as Value);
  if (t.k === 'map') {
    const keys = valuesOf(t.key, M);
    if (Array.isArray(x)) return { entries: keys.map((k, i) => [k, structValue(x[i], t.value, M)] as [Value, Value]) };
    if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      return { entries: keys.map((k) => [k, structValue(o[isUnion(k) ? k.ctor : String(k)], t.value, M)] as [Value, Value]) };
    }
  }
  return x as Value;
}

/**
 * α: a flat state back to a structured one (PS9.1b). A union value takes the
 * payload fields of its constructor; fields of other constructors are
 * ignored here, and checked by the lowered `shape:` invariant.
 */
export function alpha(flat: Flat, M: RMachine): State {
  const s: State = {};
  for (const f of M.fields) {
    if (hasPayloads(f.type, M)) {
      const tag = flat[f.name] as string;
      const c = M.unions.get((f.type as { name: string }).name)!.ctors.find((x) => x.name === tag);
      const payload: Record<string, Value> = {};
      for (const pf of c?.fields ?? []) payload[pf.name] = structValue(flat[`${f.name}_${pf.name}`], pf.type, M);
      s[f.name] = { ctor: tag, payload };
    } else s[f.name] = structValue(flat[f.name], f.type, M);
  }
  return s;
}
