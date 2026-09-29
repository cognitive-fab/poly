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
  | null; // `none`, the empty address (PS1.6)

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

/** A canonical text for a value: equal values, equal keys. */
export function keyOf(v: Value): string {
  if (v === null) return 'none';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'T' : 'F';
  if (typeof v === 'string') return JSON.stringify(v);
  if (isUnion(v)) {
    const names = Object.keys(v.payload).sort();
    return names.length ? `${v.ctor}{${names.map((n) => `${n}:${keyOf(v.payload[n])}`).join(',')}}` : v.ctor;
  }
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
  if (isUnion(v)) {
    const names = Object.keys(v.payload);
    if (!names.length) return v.ctor;
    return { [v.ctor]: Object.fromEntries(names.map((n) => [n, toPlain(v.payload[n])])) };
  }
  return Object.fromEntries(v.entries.map(([k, x]) => [typeof k === 'number' ? String(k) : isUnion(k) ? k.ctor : String(k), toPlain(x)]));
}

export function statePlain(s: State): Record<string, unknown> {
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, toPlain(v)]));
}
