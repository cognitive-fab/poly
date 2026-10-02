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
  if (t === 'conf') return { k: 'range', lo: 0, hi: 1000 };
  if (t === 'string') return { k: 'string' };
  if (t === 'boolean') return { k: 'bool' };
  if (t === 'null') return { k: 'null' };
  if ((m = /^address of (\w+)$/.exec(t))) return { k: 'address', machine: m[1] };
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

/** Why `v` is not in `t`, or null when it is. */
export function outside(t: TypeNode, v: unknown, at = 'the value'): string | null {
  switch (t.k) {
    case 'lit': return v === t.value ? null : `${at} is ${JSON.stringify(v)}, not '${t.value}'`;
    case 'range': return Number.isInteger(v) && (v as number) >= t.lo && (v as number) <= t.hi ? null : `${at} is ${JSON.stringify(v)}, outside ${t.lo}..${t.hi}`;
    case 'int': return Number.isInteger(v) ? null : `${at} is ${JSON.stringify(v)}, not an integer`;
    case 'string': return typeof v === 'string' ? null : `${at} is ${JSON.stringify(v)}, not a string`;
    case 'bool': return typeof v === 'boolean' ? null : `${at} is ${JSON.stringify(v)}, not a boolean`;
    case 'null': return v === null ? null : `${at} is ${JSON.stringify(v)}, not none`;
    case 'address': return typeof v === 'string' && v !== '' ? null : `${at} is ${JSON.stringify(v)}, not an address of ${t.machine}`;
    case 'record': {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return `${at} is ${JSON.stringify(v)}, not a record`;
      const o = v as Record<string, unknown>;
      for (const [k, ft] of t.fields) {
        if (!(k in o)) return `${at} has no ${k}`;
        const p = outside(ft, o[k], `${at}.${k}`);
        if (p) return p;
      }
      const extra = Object.keys(o).filter((k) => !t.fields.some(([f]) => f === k));
      return extra.length ? `${at} has ${extra.join(', ')}, which its type does not` : null;
    }
    case 'union': return t.alts.some((x) => outside(x, v, at) === null) ? null : `${at} is ${JSON.stringify(v)}, in none of its type's alternatives`;
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
export function dataOutside(types: Map<string, [string, TypeNode][]>, action: string, data: unknown): string | null {
  const params = types.get(action);
  if (!params) return null; // not in the module: the kernel answers it (unhandled, PS9.1a)
  const d = (data ?? {}) as Record<string, unknown>;
  for (const [p, t] of params) {
    if (!(p in d)) return `${action} has no ${p}`;
    const why = outside(t, d[p], `${action}.${p}`);
    if (why) return why;
  }
  return null;
}
