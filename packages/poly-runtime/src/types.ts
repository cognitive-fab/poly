// T(a), read from the certified contract (S140). PS3.2 defines steps only for data in the action's type, so the
// runtime refuses anything else before any step. The contract states each parameter's type in the lowering's type
// grammar (`'A' | 'B'`, `0..2`, `number`, `string`, `boolean`, `conf`, `address of M | null`, records and tagged
// objects `{ $: 'C', f: T }`); it is read back against the source by poly-ref on every check, so it is the type
// the program was checked at. A type the reader does not know refuses the load: nothing is accepted unchecked.

export type TypeNode =
  | { k: 'lit'; value: string }
  | { k: 'range'; lo: number; hi: number }
  | { k: 'int' }
  | { k: 'string' }
  | { k: 'bool' }
  | { k: 'null' }
  | { k: 'address'; machine: string }
  /** PS1.4a, S180: a body's digest, sha256:<64 hex>. */
  | { k: 'content' }
  /** PS1.4c, PT10j (S451): a key, a non-empty string. */
  | { k: 'key' }
  /** PS1.4b: the runtime's reference to retrieved items, { ref, count }. */
  | { k: 'items' }
  | { k: 'record'; fields: [string, TypeNode][] }
  | { k: 'union'; alts: TypeNode[] };

/** Splits `text` at top-level occurrences of `sep`, outside braces and quotes. */
function split(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = false, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") quote = !quote;
    else if (!quote && c === '{') depth++;
    else if (!quote && c === '}') depth--;
    else if (!quote && depth === 0 && text.startsWith(sep, i)) { out.push(text.slice(start, i)); start = i + sep.length; i += sep.length - 1; }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim());
}

export function parseType(text: string): TypeNode {
  const alts = split(text, '|');
  if (alts.length > 1) return { k: 'union', alts: alts.map(parseType) };
  const t = text.trim();
  let m: RegExpExecArray | null;
  if ((m = /^'([^']*)'$/.exec(t))) return { k: 'lit', value: m[1] };
  if ((m = /^(-?\d+)\.\.(-?\d+)$/.exec(t))) return { k: 'range', lo: Number(m[1]), hi: Number(m[2]) };
  if (t === 'number') return { k: 'int' };
  // PD5.1.2b: a principal is a non-empty string; none is null.
  if (t === 'principal') return { k: 'string' };
  if (t === 'conf') return { k: 'range', lo: 0, hi: 1000 };
  // PS1.4a, S180: a Content is a body's digest; none is null.
  if (t === 'content') return { k: 'content' };
  // PS1.4c, PT10j (S451): a Key is a non-empty string; none is null.
  if (t === 'key') return { k: 'key' };
  if (t === 'items') return { k: 'items' };
  if (t === 'string') return { k: 'string' };
  if (t === 'boolean') return { k: 'bool' };
  if (t === 'null') return { k: 'null' };
  // S176: a used module's machine is spelled m.M, with the module's dots.
  if ((m = /^address of (\w+(?:\.\w+)*)$/.exec(t))) return { k: 'address', machine: m[1] };
  if (t.startsWith('{') && t.endsWith('}')) {
    const inner = t.slice(1, -1).trim();
    const fields = (inner ? split(inner, ',') : []).map((f): [string, TypeNode] => {
      const at = f.indexOf(':');
      if (at < 0) throw new Error(`unreadable record field '${f}'`);
      return [f.slice(0, at).trim(), parseType(f.slice(at + 1))];
    });
    return { k: 'record', fields };
  }
  throw new Error(`unreadable type '${t}'`);
}

/** Whether an instance id names a live instance of a machine (by its name in the program); review C9. */
export type InstanceOf = (machine: string, id: string) => boolean;

/** Why `v` is not in `t`, or null when it is. Without `exists`, an address is only checked to be a string. */
export function outside(t: TypeNode, v: unknown, at = 'the value', exists?: InstanceOf): string | null {
  switch (t.k) {
    case 'lit': return v === t.value ? null : `${at} is ${JSON.stringify(v)}, not '${t.value}'`;
    case 'range': return Number.isInteger(v) && (v as number) >= t.lo && (v as number) <= t.hi ? null : `${at} is ${JSON.stringify(v)}, outside ${t.lo}..${t.hi}`;
    case 'int': return Number.isInteger(v) ? null : `${at} is ${JSON.stringify(v)}, not an integer`;
    case 'string': return typeof v === 'string' ? null : `${at} is ${JSON.stringify(v)}, not a string`;
    case 'bool': return typeof v === 'boolean' ? null : `${at} is ${JSON.stringify(v)}, not a boolean`;
    case 'null': return v === null ? null : `${at} is ${JSON.stringify(v)}, not none`;
    case 'content': return typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v) ? null : `${at} is ${JSON.stringify(v)}, not a body's digest (sha256:<64 hex digits>)`;
    case 'key': return typeof v === 'string' && v.length > 0 ? null : `${at} is ${JSON.stringify(v)}, not a key (a non-empty string)`;
    // PS1.4b: an Items is the runtime's reference, with its count; nothing else gives one.
    case 'items': return v !== null && typeof v === 'object' && !Array.isArray(v) && typeof (v as { ref?: unknown }).ref === 'string' && (v as { ref: string }).ref.startsWith('items:') && Number.isInteger((v as { count?: unknown }).count) && ((v as { count: number }).count >= 0) ? null : `${at} is ${JSON.stringify(v)}, not the runtime's reference to retrieved items`;
    case 'address': {
      if (typeof v !== 'string' || v === '') return `${at} is ${JSON.stringify(v)}, not an address of ${t.machine}`;
      // Review C9, PS2.1: Ref<M> holds the addresses of instances of M, so an id naming no instance of M is outside it.
      return !exists || exists(t.machine, v) ? null : `${at} is ${JSON.stringify(v)}, and there is no instance of ${t.machine} with that id`;
    }
    case 'record': {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return `${at} is ${JSON.stringify(v)}, not a record`;
      const o = v as Record<string, unknown>;
      for (const [k, ft] of t.fields) {
        if (!(k in o)) return `${at} has no ${k}`;
        const p = outside(ft, o[k], `${at}.${k}`, exists);
        if (p) return p;
      }
      const extra = Object.keys(o).filter((k) => !t.fields.some(([f]) => f === k));
      return extra.length ? `${at} has ${extra.join(', ')}, which its type does not` : null;
    }
    case 'union': {
      if (t.alts.some((x) => outside(x, v, at, exists) === null)) return null;
      // A Ref<M> with none: say why the address is not one, rather than that no alternative matched.
      const address = t.alts.find((x) => x.k === 'address');
      if (address && typeof v === 'string' && v !== '') return outside(address, v, at, exists);
      return `${at} is ${JSON.stringify(v)}, in none of its type's alternatives`;
    }
  }
}

/** Each action's parameter types, from a contract's `actions[a].dataFields`. Throws on a type it cannot read. */
export function actionTypes(contract: { actions?: Record<string, { dataFields?: Record<string, string> }> }): Map<string, [string, TypeNode][]> {
  const out = new Map<string, [string, TypeNode][]>();
  for (const [a, decl] of Object.entries(contract.actions ?? {})) {
    out.set(a, Object.entries(decl.dataFields ?? {}).map(([p, t]) => [p, parseType(t)]));
  }
  return out;
}

/**
 * Why `data` is outside the type of action `a`, or null. Keys that are not parameters are left to the kernel,
 * which supplies some itself (a child's completion, a failure's reason).
 */
/** S180: the Content values of an action's data, by its contract's types: each parameter of type Content. */
export function contentValues(types: Map<string, [string, TypeNode][]>, action: string, data: unknown): string[] {
  const params = types.get(action);
  if (!params || !data || typeof data !== 'object') return [];
  const isContent = (t: TypeNode): boolean => t.k === 'content' || (t.k === 'union' && t.alts.some(isContent));
  return params.filter(([p, t]) => isContent(t) && typeof (data as Record<string, unknown>)[p] === 'string').map(([p]) => (data as Record<string, string>)[p]);
}

export function dataOutside(types: Map<string, [string, TypeNode][]>, action: string, data: unknown, exists?: InstanceOf): string | null {
  const params = types.get(action);
  if (!params) return null; // not in the module: the kernel answers it (unhandled, PS9.1a)
  if (data !== undefined && data !== null && (typeof data !== 'object' || Array.isArray(data))) return `${action}'s data is ${JSON.stringify(data)}, not a record of its parameters`;
  const d = (data ?? {}) as Record<string, unknown>;
  for (const [p, t] of params) {
    // PD5.1.2c: the claims are the runtime's to supply, and PS3.2's claims row is the module's to apply.
    if (p === '$claims') continue;
    if (!(p in d)) return `${action} has no ${p}`;
    const why = outside(t, d[p], `${action}.${p}`, exists);
    if (why) return why;
  }
  return null;
}
