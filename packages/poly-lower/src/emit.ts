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
import { effectKind, durationMs, childSpec } from '@poly/core';

/** The module name, from a child spec's machine id or the facts (S28). */
function moduleOf(cx: Cx): string {
  if (!cx.module) throw new Error('poly-lower: a spawn needs the module name');
  return cx.module;
}

/** The family an aggregate reads with `[*]` (S49). */
function starFamilyOf(e: A.Expr): string | null {
  let found: string | null = null;
  const walk = (x: unknown): void => {
    if (!x || typeof x !== 'object' || found) return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    const n = x as A.Expr;
    if (n.kind === 'Index' && n.index.kind === 'Star' && n.object.kind === 'Member') { found = n.object.prop; return; }
    for (const [k, v] of Object.entries(x)) if (k !== 'span') walk(v);
  };
  walk(e);
  return found;
}

/** An intent's arguments against declared parameters, as `"p": value` entries. */
function argList(s: A.IntentStmt, params: A.Param[], cx: Cx): string[] {
  return s.args.map((a, i) => {
    const p = a.name === null ? params[i] : params.find((x) => x.name === a.name)!;
    return `${q(p.name)}: ${expr(a.value, cx)}`;
  });
}

/** An ISO-8601 duration, the form polyrun's `fireIn` reads: 1800000 ms is PT30M, 200 ms is PT0.2S. */
export function isoDuration(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = (ms % 60_000) / 1000;
  return `PT${h ? `${h}H` : ''}${m ? `${m}M` : ''}${s || (!h && !m) ? `${s}S` : ''}`;
}
import { isPayloadUnion, type Layout } from './layout.js';

export type Mode = 'handler' | 'state' | 'step' | 'reject' | 'init' | 'compose';

export interface Cx {
  facts: MachineFacts;
  env: TypeEnv;
  layout: Layout;
  mode: Mode;
  /** The variable that holds the state bare field names read. */
  stateVar: string;
  /** The variable that holds the step's data. */
  dataVar: string;
  /** The module's name and declarations, for spawns and signals (PT6.4). */
  module?: string;
  moduleDecls?: A.Decl[];
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
    if (e.kind === 'Member' && e.object.kind === 'Name' && (e.object.name === 'pre' || e.object.name === 'post') && cx.facts.resolutions.get(e.object.id)?.k === (e.object.name === 'pre' ? 'pre' : 'post')) return `${cx.mode === 'reject' || cx.mode === 'handler' ? cx.stateVar : e.object.name}[${q(e.prop)}]`;
    return `(${code}).$`;
  }
  return code;
}

/**
 * A child's field in a joint state, whose snapshot is the child's flat state (PS9.1b): a union with payloads
 * is rebuilt from its tag and its flat payload fields, with the child's own layout (review finding L5).
 */
function childRead(cx: Cx, state: string, machineId: string | undefined, field: string): string {
  const child = cx.moduleDecls?.find((d): d is A.Machine => d.kind === 'Machine' && d.name === machineId?.split('.').pop());
  const f = child?.fields.find((x) => x.name === field);
  const u = f?.type.kind === 'TName' ? cx.env.unions.get(f.type.name) : undefined;
  if (!u || u.isEnum) return `${state}[${q(field)}]`;
  const ctors = Object.fromEntries(u.ctors.map((c) => [c.name, c.fields.map((p) => [p.name, `${field}_${p.name}`])]));
  return `((__s) => { const __o = { $: __s[${q(field)}] }; for (const [__p, __k] of (${JSON.stringify(ctors)}[__s[${q(field)}]] || [])) __o[__p] = __s[__k]; return __o; })(${state})`;
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
        // S58: the kernel replaces the marker with the sender's instance id when it writes the message.
        case 'self': return '({ $ref: "self" })';
        case 'pre':
        case 'post':
        case 'jointParent':
        case 'jointChild':
        case 'recordField':
        case 'jointFamily':
          throw new Error('poly-lower: pre/post outside a member access');
      }
      throw new Error('poly-lower: unreachable');
    }
    case 'Member': {
      // S22: `Type.C` resolved to a constructor.
      const res = cx.facts.resolutions.get(e.id);
      if (res?.k === 'ctor') return cx.env.unions.get(res.union)!.isEnum ? q(res.ctor) : `{ $: ${q(res.ctor)} }`;
      // PT7: the joint state polyrun's check-product passes, { parent: { state }, children: { k: { state } } }.
      // S25: r.f reads a field of a record value, a plain object.
      if (res?.k === 'recordField') return `(${expr(e.object, cx)})[${q(res.field)}]`;
      if (res?.k === 'jointParent') return readField(cx, 'joint.parent.state', res.field);
      if (res?.k === 'jointFamily') {
        const ix = (e.object as A.Index).index;
        const spec = [...cx.facts.children.values()].find((c) => c.key.startsWith(res.family) && /^\d+$/.test(c.key.slice(res.family.length)));
        return childRead(cx, `joint.children[${q(res.family)} + (${expr(ix, cx)})].state`, spec?.machine, res.field);
      }
      if (res?.k === 'jointChild') return childRead(cx, `joint.children[${q(res.key)}].state`, cx.facts.children.get(res.key)?.machine, res.field);
      const obj = (e.object as A.NameRef).name;
      // Reject properties and handlers read pre.f from their state variable (PT5; S19 for handlers).
      const v = cx.mode === 'reject' || cx.mode === 'handler' ? cx.stateVar : obj;
      return readField(cx, v, e.prop);
    }
    case 'Index': return `(${expr(e.object, cx)})[${expr(e.index, cx)}]`;
    case 'Call':
      if (e.callee === 'rejected') return `(!!(v && v.rejected && v.reason === ${q((e.args[0] as A.StringLit).value)}))`;
      if (cx.mode === 'compose' && ['count', 'sum', 'all', 'any'].includes(e.callee)) {
        // S49: an aggregate over the spawned members of one family; [*] is each member's index.
        const fam = starFamilyOf(e.args[0]);
        const r = fam ? cx.facts.families.get(fam) : undefined;
        if (!fam || !r) throw new Error(`poly-lower: ${e.callee} over no family (the checker must refuse it)`);
        const members = `[${Array.from({ length: r.hi - r.lo + 1 }, (_, k) => r.lo + k).join(', ')}].filter((__star) => joint.children[${q(fam)} + __star] !== undefined).map((__star) => ${expr(e.args[0], cx)})`;
        if (e.callee === 'count') return `${members}.filter(Boolean).length`;
        if (e.callee === 'sum') return `${members}.reduce((__a, __b) => __a + __b, 0)`;
        return e.callee === 'all' ? `${members}.every(Boolean)` : `${members}.some(Boolean)`;
      }
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
          const structural = t && (isPayloadUnion(cx.env, t) || t.k === 'map' || t.k === 'record');
          const eq = structural ? `__eq(${a}, ${b})` : `(${a} === ${b})`;
          return e.op === '==' ? eq : `(!${eq})`;
        }
        default: return `(${a} ${e.op} ${b})`;
      }
    }
    case 'Is': return `[${e.ctors.map(q).join(', ')}].includes(${unionTag(cx, e.expr, expr(e.expr, cx))})`;
    case 'In': {
      const t = tyOf(cx, e.expr);
      const structural = t && (isPayloadUnion(cx.env, t) || t.k === 'map' || t.k === 'record');
      const v = expr(e.expr, cx);
      const set = `[${e.set.map((x) => expr(x, cx)).join(', ')}]`;
      return structural ? `${set}.some((__x) => __eq(__x, ${v}))` : `${set}.includes(${v})`;
    }
    case 'CtorExpr': return `{ $: ${q(e.ctor.slice(e.ctor.indexOf('.') + 1))}${e.fields.map((f) => `, ${f.name}: ${expr(f.value, cx)}`).join('')} }`;
    case 'MapLit': {
      const t = tyOf(cx, e);
      if (t?.k === 'map' && t.array) {
        const byKey = new Map(e.entries.map((en) => [(en.key as A.IntLit).value, en.value]));
        const key = t.key as { lo: number; hi: number };
        return `[${Array.from({ length: key.hi - key.lo + 1 }, (_, i) => expr(byKey.get(key.lo + i)!, cx)).join(', ')}]`;
      }
      const keyName = (k: A.Expr) => { const r = cx.facts.resolutions.get(k.id); return r?.k === 'ctor' ? r.ctor : k.kind === 'Member' ? k.prop : (k as A.NameRef).name; };
      return `{ ${e.entries.map((en) => `[${q(keyName(en.key))}]: ${expr(en.value, cx)}`).join(', ')} }`;
    }
    case 'ArrayLit': return `[${e.items.map((x) => expr(x, cx)).join(', ')}]`;
    case 'Spawned': return e.index ? `(joint.children[${q(e.key)} + (${expr(e.index, cx)})] !== undefined)` : `(joint.children[${q(e.key)}] !== undefined)`;
    case 'Star': return '__star';
    case 'Quant': {
      // S49: forall and exists over a family's indices.
      const r = cx.facts.families.get(e.group)!;
      const v = `l_${e.var}`;
      return e.q === 'forall'
        ? `(() => { for (let ${v} = ${r.lo}; ${v} <= ${r.hi}; ${v}++) if (!${expr(e.body, cx)}) return false; return true; })()`
        : `(() => { for (let ${v} = ${r.lo}; ${v} <= ${r.hi}; ${v}++) if (${expr(e.body, cx)}) return true; return false; })()`;
    }
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
      if (s.kind === 'For') walk(s.body);
    }
  };
  walk(body);
  return out;
}

export interface EmitOptions {
  /** Test-only fault injection (faults.ts). */
  dropFrame?: boolean;
  /**
   * The effects mapper (PT6.1): the handler's control flow over the pre-state and the data, with its writes
   * left out and each `emit` appended to `__E`. A failed require or a reject returns no intents: a
   * rejected step emits nothing, though the kernel calls the mapper on accepted steps only.
   */
  effects?: boolean;
  /** Test-only fault `unnamed-reject`: the first reject of the acceptors loses its reason (S47). */
  unnamedReject?: { done: boolean };
  /** Test-only fault `poison-step`: the first acceptor throws before it writes (S47). */
  poison?: { done: boolean };
  /** Test-only fault `drop-effect`: the first emit is left out of the mapper; `done` records that it was. */
  dropEffect?: { done: boolean };
}

let matchCounter = 0;

/** Match variables are numbered per machine, so the output does not depend on build order. */
export function resetNames(): void {
  matchCounter = 0;
}

/** `reject(reason)`; the unnamed-reject fault drops the reason of the first one. */
function rejectCall(reason: string, opts: EmitOptions): string {
  if (opts.unnamedReject && !opts.unnamedReject.done) { opts.unnamedReject.done = true; return 'reject()'; }
  return `reject(${q(reason)})`;
}

export function stmts(body: A.Stmt[], cx: Cx, indent: string, opts: EmitOptions): string[] {
  const out: string[] = [];
  if (opts.poison && !opts.poison.done && !opts.effects) { opts.poison.done = true; out.push(`${indent}throw new Error('poisoned by a broken lowering');`); }
  for (const s of body) out.push(...stmt(s, cx, indent, opts));
  return out;
}

function frame(keys: Iterable<string>, indent: string, opts: EmitOptions): string[] {
  const list = [...keys];
  if (!list.length || opts.dropFrame || opts.effects) return [];
  return [`${indent}unchanged(${list.map(q).join(', ')});`];
}

function branch(body: A.Stmt[], siblingsWrite: Set<string>, cx: Cx, indent: string, opts: EmitOptions): string[] {
  const mine = mayWrite(body, cx.layout);
  const rest = [...siblingsWrite].filter((k) => !mine.has(k));
  return [...stmts(body, cx, indent, opts), ...frame(rest, indent, opts)];
}

function stmt(s: A.Stmt, cx: Cx, ind: string, opts: EmitOptions): string[] {
  switch (s.kind) {
    case 'Require': return [`${ind}if (!${expr(s.cond, cx)}) return ${opts.effects ? '[]' : rejectCall(s.reason, opts)};`];
    case 'Reject': return [`${ind}return ${opts.effects ? '[]' : rejectCall(s.reason, opts)};`];
    case 'Let': return [`${ind}const l_${s.name} = ${expr(s.expr, cx)};`];
    case 'Assign':
    case 'MapUpdate':
      if (opts.effects) return [];
      break;
    default:
      break;
  }
  switch (s.kind) {
    case 'Assign': {
      const l = cx.layout.byField.get(s.field)!;
      if (l.kind === 'union') return [`${ind}__w(next, ${q(s.field)}, ${expr(s.expr, cx)});`];
      return [`${ind}next[${q(s.field)}] = ${expr(s.expr, cx)};`];
    }
    case 'MapUpdate': {
      const l = cx.layout.byField.get(s.field)!;
      // S55: entry writes to distinct keys compose, so each builds on the entries written before it.
      if (!opts.effects) {
        const acc = `__m_${s.field}`;
        const array = l.ty.k === 'map' && l.ty.array;
        const upd = array
          ? `{ const __key = ${expr(s.key, cx)}; const __val = ${expr(s.value, cx)}; ${acc} = ${acc}.map((__x, __i) => (__i === __key ? __val : __x)); }`
          : `${acc} = { ...${acc}, [${expr(s.key, cx)}]: ${expr(s.value, cx)} };`;
        return [`${ind}${upd}`, `${ind}next[${q(s.field)}] = ${acc};`];
      }
      const m = `model[${q(s.field)}]`;
      const k = expr(s.key, cx);
      const v = expr(s.value, cx);
      const array = l.ty.k === 'map' && l.ty.array;
      return array
        ? [`${ind}{ const __key = ${k}; const __val = ${v}; next[${q(s.field)}] = ${m}.map((__x, __i) => (__i === __key ? __val : __x)); }`]
        : [`${ind}next[${q(s.field)}] = { ...${m}, [${k}]: ${v} };`];
    }
    case 'For': {
      // S49: `for i in lo..n` runs i from lo while i <= n; n is bounded by its type, so this is the unrolled loop.
      const v = `l_${s.var}`;
      // The handler's map accumulators are declared at its top; a loop that runs no copy still writes its maps,
      // so the frame the lowering derives (the field is written) holds on every path.
      const maps = opts.effects ? [] : [...new Set(s.body.filter((b): b is A.MapUpdate => b.kind === 'MapUpdate').map((b) => b.field))];
      return [
        `${ind}for (let ${v} = ${s.lo}; ${v} <= ${expr(s.hi, cx)}; ${v}++) {`,
        ...stmts(s.body, cx, ind + '  ', opts),
        `${ind}}`,
        ...maps.map((f) => `${ind}next[${q(f)}] = __m_${f};`),
      ];
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
          const parts = [`${v}t === ${q(p.ctor.slice(p.ctor.indexOf('.') + 1))}`];
          for (const f of p.fields) {
            if (f.literal) parts.push(`${v}[${q(f.name)}] === ${f.literal.kind === 'Name' ? q(f.literal.name) : JSON.stringify(f.literal.value)}`);
            // S21: a name that is a constructor of the payload's type is a literal; `_` ignores the payload.
            const ctorLiteral = cx.facts.patternLiterals.get(`${arm.id}:${f.name}`);
            if (ctorLiteral !== undefined) parts.push(`${v}[${q(f.name)}] === ${q(ctorLiteral)}`);
            else if (f.bind && f.bind !== '_') binds.push(`${ind}    const b_${f.bind} = ${v}[${q(f.name)}];`);
          }
          cond = parts.join(' && ');
        }
        lines.push(`${ind}  ${k === 0 ? 'if' : '} else if'} (${cond}) {`, ...binds, ...branch(arm.body, all, cx, ind + '    ', opts));
      });
      // The checker proved the arms exhaustive (PL1501); this line is never reached.
      lines.push(`${ind}  } else {`, `${ind}    throw new Error('non-exhaustive match');`, `${ind}  }`, `${ind}}`);
      return lines;
    }
    case 'Intent': {
      if (s.op === 'spawn' && s.modifier === 'detached') throw new Error('poly-lower: spawn detached reached the lowering (PL0901 must refuse it, S60)');
      // The acceptor writes and frames; the intents are the mapper's (PT6.1).
      if (!opts.effects) return [];
      if (opts.dropEffect && !opts.dropEffect.done) { opts.dropEffect.done = true; return []; }
      if (s.op === 'send') {
        // PT7a, S58: sendTo { target, action, data }; the target is an address, a string, or null for none.
        const t = cx.facts.types.get(s.to!.id);
        const receiver = t?.k === 'ref' ? cx.moduleDecls?.find((d): d is A.Machine => d.kind === 'Machine' && d.name === t.machine) : undefined;
        const act = receiver?.items.find((i): i is A.Action => i.kind === 'Action' && i.name === s.target);
        if (!act) throw new Error(`poly-lower: send … <- ${s.target} is unresolved (the checker must refuse it)`);
        return [`${ind}__E.push({ kind: "sendTo", target: ${expr(s.to!, cx)}, action: ${q(s.target)}, data: { ${argList(s, act.params, cx).join(', ')} } });`];
      }
      // S49: an indexed key k[i] is the string k<i>.
      const keyOf = (name: string) => (s.index ? `${q(name)} + (${expr(s.index, cx)})` : q(name));
      if (s.op === 'cancel') return [`${ind}__E.push({ kind: "cancelTimer", key: ${keyOf(s.target)} });`];
      if (s.op === 'spawn') {
        // PT6.4, S43: spawnChild with the creation action and the wiring; absent parts are left out.
        const spec = childSpec(s, moduleOf(cx));
        const child = cx.moduleDecls?.find((d): d is A.Machine => d.kind === 'Machine' && d.name === spec.machine.split('.').pop());
        const parts = [`kind: "spawnChild"`, `machineId: ${q(spec.machine)}`, `childKey: ${keyOf(spec.key)}`];
        if (spec.create) {
          const act = child?.items.find((i): i is A.Action => i.kind === 'Action' && i.name === spec.create);
          if (!act) throw new Error(`poly-lower: no creation action ${spec.create} (the checker must refuse it)`);
          parts.push(`creation: { action: ${q(spec.create)}, data: { ${argList(s, act.params, cx).join(', ')} } }`);
        }
        if (spec.onComplete) parts.push(`onComplete: ${q(spec.onComplete)}`);
        if (spec.onParentTerminal) parts.push(`onParentTerminal: ${q(spec.onParentTerminal)}`);
        return [`${ind}__E.push({ ${parts.join(', ')} });`];
      }
      if (s.op === 'signal') {
        const spec = s.index ? [...cx.facts.children.values()].find((c) => c.key.startsWith(s.extra[0]) && /^\d+$/.test(c.key.slice(s.extra[0].length))) : cx.facts.children.get(s.extra[0]);
        const child = cx.moduleDecls?.find((d): d is A.Machine => d.kind === 'Machine' && d.name === spec?.machine.split('.').pop());
        const act = child?.items.find((i): i is A.Action => i.kind === 'Action' && i.name === s.target);
        if (!spec || !act) throw new Error(`poly-lower: signal ${s.extra[0]} -> ${s.target} is unresolved (the checker must refuse it)`);
        return [`${ind}__E.push({ kind: "signalChild", childKey: ${keyOf(s.extra[0])}, action: ${q(s.target)}, data: { ${argList(s, act.params, cx).join(', ')} } });`];
      }
      if (s.op === 'after') {
        // PT6.3, S26: the compiler cannot know whether the key is armed, so it cancels, then arms.
        const act = cx.facts.machine.items.find((x): x is A.Action => x.kind === 'Action' && x.name === s.target);
        if (!act || !s.as || !s.modifier) throw new Error(`poly-lower: after … -> ${s.target} is incomplete (the checker must refuse it)`);
        const data = s.args.map((a, i) => {
          const p = a.name === null ? act.params[i] : act.params.find((x) => x.name === a.name)!;
          return `${q(p.name)}: ${expr(a.value, cx)}`;
        });
        return [
          `${ind}__E.push({ kind: "cancelTimer", key: ${keyOf(s.as)} });`,
          `${ind}__E.push({ kind: "timer", key: ${keyOf(s.as)}, fireIn: ${q(isoDuration(durationMs(s.modifier)!))}, action: ${q(s.target)}, data: { ${data.join(', ')} } });`,
        ];
      }
      const eff = cx.facts.effects.get(s.target);
      if (!eff) throw new Error(`poly-lower: no effect ${s.target} (PL1001 must refuse it)`);
      const kind = effectKind(eff);
      const payload = s.args.map((a, i) => {
        const p = a.name === null ? eff.params[i] : eff.params.find((x) => x.name === a.name)!;
        return `${q(p.name)}: ${expr(a.value, cx)}`;
      });
      return [`${ind}__E.push({ kind: ${q(kind)}, payload: { ${payload.join(', ')} } });`];
    }
    default:
      return [];
  }
}
