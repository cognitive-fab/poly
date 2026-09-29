// Expressions and handler bodies to JavaScript for the SAM v2 strict profile
// (PT4.1, PT4.2, PS2.2).
//
// Reads go to the frozen pre-state `model`, writes to `next` (PS2.3). The
// frame is derived per path (PT4.2): after a block runs normally, every path
// through it has written or framed exactly the flat keys the block may
// write, so each branch frames what its siblings write and it does not, and
// the handler frames everything its body never writes.
import type * as A from '@poly/core';
import type { MachineFacts, Ty, TypeEnv } from '@poly/core';
import { isPayloadUnion, type Layout } from './layout.js';

export type Mode = 'handler' | 'state' | 'step' | 'reject' | 'init';

export interface Cx {
  facts: MachineFacts;
  env: TypeEnv;
  layout: Layout;
  mode: Mode;
  /** The variable that holds the state bare field names read. */
  stateVar: string;
  /** The variable that holds the step's data. */
  dataVar: string;
}

const q = (s: string) => JSON.stringify(s);

function tyOf(cx: Cx, e: A.Expr): Ty | undefined {
  return cx.facts.types.get(e.id);
}

function unionTag(cx: Cx, e: A.Expr, code: string): string {
  const t = tyOf(cx, e);
  if (t && isPayloadUnion(cx.env, t)) {
    // A field read directly: its flat tag is the field itself.
    const r = e.kind === 'Name' ? cx.facts.resolutions.get(e.id) : undefined;
    if (r?.k === 'field') return `${cx.stateVar}[${q(r.name)}]`;
    if (e.kind === 'Member' && e.object.kind === 'Name') return `${cx.mode === 'reject' ? cx.stateVar : e.object.name}[${q(e.prop)}]`;
    return `(${code}).$`;
  }
  return code;
}

function readField(cx: Cx, stateVar: string, name: string): string {
  const l = cx.layout.byField.get(name);
  if (!l) throw new Error(`poly-lower: no layout for field ${name}`);
  return l.kind === 'union' ? `__u(${stateVar}, ${q(name)})` : `${stateVar}[${q(name)}]`;
}

export function expr(e: A.Expr, cx: Cx): string {
  switch (e.kind) {
    case 'Int': return String(e.value);
    case 'Bool': return String(e.value);
    case 'String': return q(e.value);
    case 'Primed': throw new Error("poly-lower: a primed read reached the lowering (PL1202 must refuse it)");
    case 'Name': {
      const r = cx.facts.resolutions.get(e.id);
      if (!r) throw new Error(`poly-lower: unresolved name ${e.name}`);
      switch (r.k) {
        case 'field': return readField(cx, cx.stateVar, r.name);
        case 'param': return `${cx.dataVar}[${q(r.name)}]`;
        case 'let': return `l_${r.name}`;
        case 'bind': return `b_${r.name}`;
        case 'ctor': return cx.env.unions.get(r.union)!.isEnum ? q(r.ctor) : `{ $: ${q(r.ctor)} }`;
        case 'action': return q(r.name);
        case 'actionVar': return 'action';
        case 'none': return 'null';
        case 'pre':
        case 'post':
          throw new Error('poly-lower: pre/post outside a member access');
      }
      throw new Error('poly-lower: unreachable');
    }
    case 'Member': {
      const obj = (e.object as A.NameRef).name;
      const v = cx.mode === 'reject' ? cx.stateVar : obj;
      return readField(cx, v, e.prop);
    }
    case 'Index': return `(${expr(e.object, cx)})[${expr(e.index, cx)}]`;
    case 'Call':
      if (e.callee === 'rejected') return `(!!(v && v.rejected && v.reason === ${q((e.args[0] as A.StringLit).value)}))`;
      throw new Error(`poly-lower: call ${e.callee} reached the lowering`);
    case 'Unary': return `(${e.op}${expr(e.arg, cx)})`;
    case 'Binary': {
      const a = expr(e.left, cx);
      const b = expr(e.right, cx);
      switch (e.op) {
        case 'implies': return `(!${a} || ${b})`;
        case '&&': return `(${a} && ${b})`;
        case '||': return `(${a} || ${b})`;
        case '/': return `Math.trunc(${a} / ${b})`; // S12: truncation toward zero
        case '==':
        case '!=': {
          const t = tyOf(cx, e.left);
          const structural = t && (isPayloadUnion(cx.env, t) || t.k === 'map');
          const eq = structural ? `__eq(${a}, ${b})` : `(${a} === ${b})`;
          return e.op === '==' ? eq : `(!${eq})`;
        }
        default: return `(${a} ${e.op} ${b})`;
      }
    }
    case 'Is': return `[${e.ctors.map(q).join(', ')}].includes(${unionTag(cx, e.expr, expr(e.expr, cx))})`;
    case 'In': {
      const t = tyOf(cx, e.expr);
      const structural = t && (isPayloadUnion(cx.env, t) || t.k === 'map');
      const v = expr(e.expr, cx);
      const set = `[${e.set.map((x) => expr(x, cx)).join(', ')}]`;
      return structural ? `${set}.some((__x) => __eq(__x, ${v}))` : `${set}.includes(${v})`;
    }
    case 'CtorExpr': return `{ $: ${q(e.ctor)}${e.fields.map((f) => `, ${f.name}: ${expr(f.value, cx)}`).join('')} }`;
    case 'MapLit': {
      const t = tyOf(cx, e);
      if (t?.k === 'map' && t.array) {
        const byKey = new Map(e.entries.map((en) => [(en.key as A.IntLit).value, en.value]));
        const key = t.key as { lo: number; hi: number };
        return `[${Array.from({ length: key.hi - key.lo + 1 }, (_, i) => expr(byKey.get(key.lo + i)!, cx)).join(', ')}]`;
      }
      return `{ ${e.entries.map((en) => `${q((en.key as A.NameRef).name)}: ${expr(en.value, cx)}`).join(', ')} }`;
    }
    case 'ArrayLit': return `[${e.items.map((x) => expr(x, cx)).join(', ')}]`;
  }
}

// ── statements ────────────────────────────────────────────────────────────

/** Flat keys a block may write, on any path (MW in the frame argument above). */
export function mayWrite(body: A.Stmt[], layout: Layout): Set<string> {
  const out = new Set<string>();
  const add = (field: string) => { for (const k of layout.byField.get(field)?.flat ?? [field]) out.add(k); };
  const walk = (b: A.Stmt[]) => {
    for (const s of b) {
      if (s.kind === 'Assign' || s.kind === 'MapUpdate') add(s.field);
      if (s.kind === 'If') { walk(s.then); walk(s.else ?? []); }
      if (s.kind === 'Match') for (const a of s.arms) walk(a.body);
    }
  };
  walk(body);
  return out;
}

export interface EmitOptions {
  /** Test-only fault injection (faults.ts). */
  dropFrame?: boolean;
}

let matchCounter = 0;

/** Match variables are numbered per machine, so the output does not depend on build order. */
export function resetNames(): void {
  matchCounter = 0;
}

export function stmts(body: A.Stmt[], cx: Cx, indent: string, opts: EmitOptions): string[] {
  const out: string[] = [];
  for (const s of body) out.push(...stmt(s, cx, indent, opts));
  return out;
}

function frame(keys: Iterable<string>, indent: string, opts: EmitOptions): string[] {
  const list = [...keys];
  if (!list.length || opts.dropFrame) return [];
  return [`${indent}unchanged(${list.map(q).join(', ')});`];
}

function branch(body: A.Stmt[], siblingsWrite: Set<string>, cx: Cx, indent: string, opts: EmitOptions): string[] {
  const mine = mayWrite(body, cx.layout);
  const rest = [...siblingsWrite].filter((k) => !mine.has(k));
  return [...stmts(body, cx, indent, opts), ...frame(rest, indent, opts)];
}

function stmt(s: A.Stmt, cx: Cx, ind: string, opts: EmitOptions): string[] {
  switch (s.kind) {
    case 'Require': return [`${ind}if (!${expr(s.cond, cx)}) return reject(${q(s.reason)});`];
    case 'Reject': return [`${ind}return reject(${q(s.reason)});`];
    case 'Let': return [`${ind}const l_${s.name} = ${expr(s.expr, cx)};`];
    case 'Assign': {
      const l = cx.layout.byField.get(s.field)!;
      if (l.kind === 'union') return [`${ind}__w(next, ${q(s.field)}, ${expr(s.expr, cx)});`];
      return [`${ind}next[${q(s.field)}] = ${expr(s.expr, cx)};`];
    }
    case 'MapUpdate': {
      const l = cx.layout.byField.get(s.field)!;
      const m = `model[${q(s.field)}]`;
      const k = expr(s.key, cx);
      const v = expr(s.value, cx);
      const array = l.ty.k === 'map' && l.ty.array;
      return array
        ? [`${ind}{ const __key = ${k}; const __val = ${v}; next[${q(s.field)}] = ${m}.map((__x, __i) => (__i === __key ? __val : __x)); }`]
        : [`${ind}next[${q(s.field)}] = { ...${m}, [${k}]: ${v} };`];
    }
    case 'If': {
      const all = mayWrite([s], cx.layout);
      const lines = [`${ind}if (${expr(s.cond, cx)}) {`, ...branch(s.then, all, cx, ind + '  ', opts), `${ind}} else {`, ...branch(s.else ?? [], all, cx, ind + '  ', opts), `${ind}}`];
      return lines;
    }
    case 'Match': {
      const n = ++matchCounter;
      const all = mayWrite([s], cx.layout);
      const v = `__m${n}`;
      const t = tyOf(cx, s.scrutinee);
      const payload = t !== undefined && isPayloadUnion(cx.env, t);
      const lines = [`${ind}{`, `${ind}  const ${v} = ${expr(s.scrutinee, cx)};`, `${ind}  const ${v}t = ${payload ? `${v}.$` : v};`];
      s.arms.forEach((arm, k) => {
        const p = arm.pattern;
        let cond = 'true';
        const binds: string[] = [];
        if (p.kind === 'PCtor') {
          const parts = [`${v}t === ${q(p.ctor)}`];
          for (const f of p.fields) {
            if (f.literal) parts.push(`${v}[${q(f.name)}] === ${f.literal.kind === 'Name' ? q(f.literal.name) : JSON.stringify(f.literal.value)}`);
            if (f.bind) binds.push(`${ind}    const b_${f.bind} = ${v}[${q(f.name)}];`);
          }
          cond = parts.join(' && ');
        }
        lines.push(`${ind}  ${k === 0 ? 'if' : '} else if'} (${cond}) {`, ...binds, ...branch(arm.body, all, cx, ind + '    ', opts));
      });
      // The checker proved the arms exhaustive (PL1501); this line is never reached.
      lines.push(`${ind}  } else {`, `${ind}    throw new Error('non-exhaustive match');`, `${ind}  }`, `${ind}}`);
      return lines;
    }
    case 'Intent':
      throw new Error(`poly-lower: ${s.op} reached the lowering (PL0901 must refuse it)`);
  }
}
