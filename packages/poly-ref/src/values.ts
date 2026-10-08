// Values and states (PS1.2, PS1.4).
//
// A value is an integer, a boolean, a string, a union value (Ctor, record),
// a finite map, or the empty address. A state maps each declared field to a
// value and holds nothing else: no verdict, no pending effects (PS1.2).

export type Value =
  | number
  | boolean
  | string
  | UnionValue
  | MapValue
  | RecordValue
  | TaintedContent
  | null; // `none`, the empty address (PS1.6)

/** A record value (S25): every field of its type, no tag. PS17.1: an Items value carries its taint beside its count. */
export interface RecordValue {
  fields: Record<string, Value>;
  $taint?: Taint;
}

/**
 * PS17.1 (S300): a taint, the class's index in the audience order and the owners, sorted principal representatives.
 * No taint, or ⊥, is the lowest class and no owner; a value that carries ⊥ is written without one.
 */
export interface Taint { c: number; o: string[] }

/** PS17.1: a Content carrying a taint above ⊥, a ghost no handler reads; equality and keys see the digest alone. */
export interface TaintedContent { $content: string | null; $taint: Taint }

export const isTainted = (v: Value): v is TaintedContent => v !== null && typeof v === 'object' && '$content' in v;
/** A value as a handler sees it: a Content's digest without its taint. */
export const bare = (v: Value): Value => (isTainted(v) ? v.$content : v);
export const BOTTOM: Taint = { c: 0, o: [] };
export const isBottom = (t: Taint) => t.c === 0 && t.o.length === 0;
/** PS17.1: the join, the higher class and the union of the owners. */
export function join(a: Taint, b: Taint): Taint {
  return { c: Math.max(a.c, b.c), o: [...new Set([...a.o, ...b.o])].sort() };
}
export const taintText = (t: Taint) => `${t.c}/${t.o.join('+')}`;
/** The taint a value carries: its own for a tainted Content or an Items, ⊥ otherwise. */
export function taintOf(v: Value): Taint {
  if (isTainted(v)) return v.$taint;
  if (v !== null && typeof v === 'object' && 'fields' in v && v.$taint) return v.$taint;
  return BOTTOM;
}
/** A value carrying the taint t joined with its own: a Content is wrapped, an Items record copied; ⊥ changes nothing. */
export function withTaint(v: Value, t: Taint, kind: 'content' | 'items'): Value {
  const tt = join(taintOf(v), t);
  // PS17.1: none names no body, so it carries ⊥ whatever it is given.
  if (isBottom(tt) || (kind === 'content' && bare(v) === null)) return bare(v);
  if (kind === 'content') return { $content: bare(v) as string | null, $taint: tt };
  return { ...(v as RecordValue), $taint: tt };
}
/** PS17.1: every taint a value holds, in a fixed order, for the key of a state with its ghost. */
export function taintsKey(v: Value): string {
  if (v === null || typeof v !== 'object') return '';
  if (isTainted(v)) return `<${taintText(v.$taint)}>`;
  if ('fields' in v) return `${v.$taint ? `<${taintText(v.$taint)}>` : ''}${Object.keys(v.fields).sort().map((k) => taintsKey(v.fields[k])).join('')}`;
  if ('ctor' in v) return Object.keys(v.payload).sort().map((k) => taintsKey(v.payload[k])).join('');
  return v.entries.map(([, x]) => taintsKey(x)).join(',');
}

/** `(C, r)`: a constructor and the record of its payload (PS1.4). An enum member has an empty record. */
export interface UnionValue {
  ctor: string;
  payload: Record<string, Value>;
}

/** A finite map. Entries are keyed by the canonical key of the key value, in key-domain order. */
export interface MapValue {
  entries: [Value, Value][];
}

export type State = Record<string, Value>;

export const isUnion = (v: Value): v is UnionValue => v !== null && typeof v === 'object' && 'ctor' in v;
export const isMap = (v: Value): v is MapValue => v !== null && typeof v === 'object' && 'entries' in v;
export const isRecord = (v: Value): v is RecordValue => v !== null && typeof v === 'object' && 'fields' in v;

/** A canonical text for a value: equal values, equal keys. */
export function keyOf(v: Value): string {
  if (v === null) return 'none';
  // PS17.1: a taint is a ghost; equal digests are equal values.
  if (isTainted(v)) return keyOf(v.$content);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'T' : 'F';
  if (typeof v === 'string') return JSON.stringify(v);
  if (isUnion(v)) {
    const names = Object.keys(v.payload).sort();
    return names.length ? `${v.ctor}{${names.map((n) => `${n}:${keyOf(v.payload[n])}`).join(',')}}` : v.ctor;
  }
  if (isRecord(v)) return `{${Object.keys(v.fields).sort().map((n) => `${n}:${keyOf(v.fields[n])}`).join(',')}}`;
  return `[${v.entries.map(([k, x]) => `${keyOf(k)}:${keyOf(x)}`).join(',')}]`;
}

export function stateKey(s: State, fields: string[]): string {
  return fields.map((f) => keyOf(s[f])).join('|');
}

export function equal(a: Value, b: Value): boolean {
  return keyOf(a) === keyOf(b);
}

/** `m[k]`. */
export function mapGet(m: MapValue, k: Value): Value {
  const kk = keyOf(k);
  const e = m.entries.find(([key]) => keyOf(key) === kk);
  if (!e) throw new Error(`poly-ref: key ${kk} is not in the map`);
  return e[1];
}

/** `m[k := v]`: a new map, the other entries unchanged (PS2.2). */
export function mapSet(m: MapValue, k: Value, v: Value): MapValue {
  const kk = keyOf(k);
  if (!m.entries.some(([key]) => keyOf(key) === kk)) throw new Error(`poly-ref: key ${kk} is not in the map`);
  return { entries: m.entries.map(([key, x]) => [key, keyOf(key) === kk ? v : x]) };
}

/** Plain JSON for witnesses and reports: enum members as names, unions as { Ctor: payload }, maps as objects. */
export function toPlain(v: Value): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (isTainted(v)) return v.$content;
  if (isUnion(v)) {
    const names = Object.keys(v.payload);
    if (!names.length) return v.ctor;
    return { [v.ctor]: Object.fromEntries(names.map((n) => [n, toPlain(v.payload[n])])) };
  }
  if (isRecord(v)) return Object.fromEntries(Object.entries(v.fields).map(([n, x]) => [n, toPlain(x)]));
  return Object.fromEntries(v.entries.map(([k, x]) => [typeof k === 'number' ? String(k) : isUnion(k) ? k.ctor : String(k), toPlain(x)]));
}

export function statePlain(s: State): Record<string, unknown> {
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, toPlain(v)]));
}
