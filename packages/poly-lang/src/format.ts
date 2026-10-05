// The canonical formatter (PT1.4, PS12).
//
// Layout is a function of the AST alone: one AST, one text. Comments come
// from the parser's side table (Trivia) keyed by node id and are printed at
// their nodes; they never change the layout of the code around them.
//
// Parentheses are minimal, with one exception fixed by PS12: `implies` is
// always parenthesised when it is mixed with `&&` or `||`, in either
// direction, so no reader has to remember that it binds loosest.
import type * as A from '@poly/core';
import type { Trivia } from './parser.js';

const INDENT = '  ';

const PREC: Record<string, number> = {
  '*': 3, '/': 3, '%': 3, '+': 4, '-': 4, '<': 5, '<=': 5, '>': 5, '>=': 5, '==': 6, '!=': 6, '&&': 7, '||': 8, implies: 9,
};

/** One expression, type or pattern as the formatter prints it: the text of a typed edit (PT12.1, S70). */
export function printExpr(e: A.Expr): string { return new Printer().expr(e, 0); }
export function printType(t: A.TypeExpr): string { return new Printer().type(t); }
export function printStmt(s: A.Stmt): string { return (new Printer() as unknown as { stmt(s: A.Stmt): string[] }).stmt(s).join('\n'); }
export function printPattern(p: A.Pattern): string { return (new Printer() as unknown as { pattern(p: A.Pattern): string }).pattern(p); }

/** Review D-F6: the comment anchor of an obligation body line with no expression, as the parser names it. */
const lineOf = (n: A.NodeBase, slot: string): A.NodeBase => ({ id: `${n.id}:${slot}` });

export function format(module: A.Module, trivia?: Trivia): string {
  return new Printer(trivia).module(module);
}

class Printer {
  private out: string[] = [];
  constructor(private readonly trivia?: Trivia) {}

  private lead(n: A.NodeBase, indent: string): void {
    for (const c of this.trivia?.leading.get(n.id) ?? []) this.out.push(indent + '//' + c);
  }
  private trail(n: A.NodeBase): string {
    const c = this.trivia?.trailing.get(n.id);
    return c === undefined ? '' : '  //' + c;
  }
  /** Emits lines for a node: leading comments, the lines, the trailing comment on the last line. */
  private emit(n: A.NodeBase, indent: string, lines: string[]): void {
    this.lead(n, indent);
    lines.forEach((l, k) => this.out.push(indent + l + (k === lines.length - 1 ? this.trail(n) : '')));
  }

  /** PT10: one line per clause; a tool name that is not an identifier is quoted. */
  private workflow(w: A.Workflow): void {
    const q = (s: string) => JSON.stringify(s);
    this.lead(w, '');
    this.out.push(`workflow ${w.name} runs ${w.machine} {`);
    this.out.push(`${INDENT}input ${w.input}`);
    if (w.key) this.emit(w.key, INDENT, [`key ${q(w.key.template)}${w.key.fields.length ? ` where ${w.key.fields.map((f) => `${f.name} matches ${q(f.pattern)}`).join(', ')}` : ''}`]);
    for (const t of w.tools) this.emit(t, INDENT, [`tool ${q(t.effect)} -> ${/^[A-Za-z_][A-Za-z0-9_]*$/.test(t.tool) ? t.tool : q(t.tool)}${t.target === null ? '' : ` target ${q(t.target)}`} why ${q(t.why)}`]);
    this.out.push(`}${this.trail(w)}`);
  }

  module(m: A.Module): string {
    this.lead(m, '');
    this.out.push(`module ${m.name}`);
    for (const d of m.decls) {
      this.out.push('');
      this.decl(d);
    }
    for (const c of this.trivia?.end ?? []) this.out.push('//' + c);
    return this.out.join('\n').replace(/[ \t]+$/gm, '') + '\n';
  }

  private decl(d: A.Decl): void {
    switch (d.kind) {
      case 'EnumDecl':
        return this.emit(d, '', [`enum ${d.name} { ${d.members.join(', ')} }`]);
      case 'RecordDecl':
        // PD5.1.2: a claims type, one field per line.
        if (d.claims) {
          // Polywatch: each field line carries its own comments, as a machine's fields do.
          this.lead(d, '');
          this.out.push(`claims ${d.name} {`);
          for (const f of d.fields) this.emit(f, INDENT, [`${f.name}: ${this.type(f.type)}`]);
          this.out.push(`}${this.trail(d)}`);
          return;
        }
        return this.emit(d, '', [`type ${d.name} = { ${d.fields.map((f) => `${f.name}: ${this.type(f.type)}`).join(', ')} }`]);
      case 'TypeDecl': {
        const ctors = d.ctors.map((c) => this.ctor(c));
        const one = `type ${d.name} = ${ctors.join(' | ')}`;
        const commented = d.ctors.some((c) => this.trivia?.leading.has(c.id) || this.trivia?.trailing.has(c.id));
        if (one.length <= 100 && !commented) return this.emit(d, '', [one]);
        this.emit(d, '', [`type ${d.name} =`]);
        d.ctors.forEach((c, k) => this.emit(c, INDENT, [`| ${ctors[k]}`]));
        return;
      }
      case 'Use':
        return this.emit(d, '', [`use ${d.path.join('.')}`]);
      case 'Machine':
        return this.machine(d);
      case 'Configuration':
        return this.configuration(d);
      case 'Policy':
        return this.policy(d);
      case 'Workflow':
        return this.workflow(d);
    }
  }

  /** PT8.1: one canonical text per policy. */
  private policy(p: A.Policy): void {
    const q = (s: string) => JSON.stringify(s);
    this.emit(p, '', [`policy ${p.name} {`]);
    this.out.push(`${INDENT}scope ${q(p.scope)}${p.requiresAttribution ? ' requires attribution' : ''}`);
    for (const v of p.vars) this.emit(v, INDENT, [`var ${v.name}: ${this.type(v.type)} = ${this.expr(v.init, 0)}`]);
    for (const it of p.items) {
      switch (it.kind) {
        // B13: each line of a body carries the comments of the expression on it, before it and at its end.
        case 'RuleObligation': {
          this.lead(it, INDENT);
          this.out.push(`${INDENT}obligation ${it.name} ${q(it.text)} rule {`);
          if (it.when) this.emit(it.when, INDENT + INDENT, [`when ${this.expr(it.when, 0)}`]);
          this.emit(it.require, INDENT + INDENT, [`require ${this.expr(it.require, 0)} else ${it.severity}`]);
          if (it.onUnknown) this.emit(lineOf(it, 'onUnknown'), INDENT + INDENT, [`on unknown ${it.onUnknown}`]);
          this.out.push(`${INDENT}}${this.trail(it)}`);
          break;
        }
        case 'MachineObligation': {
          this.lead(it, INDENT);
          this.out.push(`${INDENT}obligation ${it.name} ${q(it.text)} machine {`);
          this.emit(lineOf(it, 'states'), INDENT + INDENT, [`states ${it.states.join(', ')}`]);
          this.emit(lineOf(it, 'initial'), INDENT + INDENT, [`initial ${it.initial}`]);
          for (const t of it.transitions) this.emit(t.when, INDENT + INDENT, [`from ${t.from === '*' ? '*' : t.from.join(', ')} when ${this.expr(t.when, 0)} -> ${t.to}`]);
          for (const g of it.guards) this.emit(g.when, INDENT + INDENT, [`deny in ${g.in.join(', ')} when ${this.expr(g.when, 0)} reason ${q(g.reason)}`]);
          this.emit(lineOf(it, 'end'), INDENT + INDENT, [`end ${it.end.join(', ')}`]);
          this.out.push(`${INDENT}}${this.trail(it)}`);
          break;
        }
        case 'InvariantObligation':
          this.emit(it, INDENT, [`obligation ${it.name} ${q(it.text)} invariant { ${this.expr(it.expr, 0)} }`]);
          break;
        case 'Recalled':
          this.emit(it, INDENT, [`recalled ${it.name} ${q(it.text)}`]);
          break;
        case 'Never':
          this.emit(it, INDENT, [`never ${it.name} ${q(it.text)}: allow when ${this.expr(it.when, 0)}`]);
          break;
      }
    }
    this.out.push('}');
  }

  private ctor(c: A.Ctor): string {
    if (c.fields.length === 0) return c.name;
    return `${c.name} { ${c.fields.map((f) => `${f.name}: ${this.type(f.type)}`).join(', ')} }`;
  }

  type(t: A.TypeExpr): string {
    switch (t.kind) {
      case 'TBool': return 'bool';
      case 'TInt': return 'int';
      case 'TString': return 'string';
      case 'TName': return t.name;
      case 'TRange': return `${t.lo}..${t.hi}`;
      case 'TMap': return `map<${this.type(t.key)}, ${this.type(t.value)}>`;
      case 'TRef': return `Ref<${t.machine.join('.')}>`;
      case 'TConf': return 'Conf';
    }
  }

  private check(c: A.CheckClause | null): string {
    if (!c) return '';
    const d = c.domain.kind === 'DomainRange' ? `${c.domain.lo}..${c.domain.hi}` : `{ ${c.domain.values.map((v) => this.expr(v, 0)).join(', ')} }`;
    return ` check ${d}${c.mode ? ' ' + c.mode : ''}`;
  }

  private machine(m: A.Machine): void {
    const head = `${m.service ? 'service ' : ''}machine ${m.name} {`;
    this.emit(m, '', [head]);
    const ind = INDENT;
    if (m.version !== null) this.out.push(`${ind}version ${m.version}`);
    this.out.push(`${ind}state {`);
    const width = Math.max(0, ...m.fields.map((f) => f.name.length));
    for (const f of m.fields) {
      const line = `${f.name.padEnd(width)} : ${this.type(f.type)}${this.check(f.check)} = ${this.expr(f.init, 0)}${f.flag ? ' ' + f.flag : ''}`;
      this.emit(f, ind + INDENT, [line]);
    }
    this.out.push(`${ind}}`);
    let prev: A.MachineItem | null = null;
    for (const it of m.items) {
      const lines = this.item(it);
      // A blank line between items, except between one-line items of the same kind.
      const sameKind = prev && prev.kind === it.kind && (it.kind !== 'Property' || (prev as A.Property).form === it.form);
      if (!(sameKind && lines.length === 1 && this.lastItemLines === 1)) this.out.push('');
      this.emit(it, ind, lines);
      this.lastItemLines = lines.length;
      prev = it;
    }
    this.out.push('}');
  }
  private lastItemLines = 0;

  /** PS5.2: `(f: v, …)` after a never's effect, or `, f: v, …` inside emits(…); nothing when there is no filter. */
  private emitsFields(fs: A.EmitsField[], open: '(' | ', '): string {
    if (!fs.length) return '';
    const list = fs.map((f) => `${f.name}: ${this.expr(f.value, 0)}`).join(', ');
    return open === '(' ? `(${list})` : `, ${list}`;
  }

  private item(it: A.MachineItem): string[] {
    switch (it.kind) {
      case 'Terminal': return [`terminal ${this.expr(it.expr, 0)}`];
      case 'Action': return [`action ${it.name}(${it.params.map((p) => this.param(p)).join(', ')})`];
      case 'Guard': return [`guard all when ${this.expr(it.cond, 0)} reject ${JSON.stringify(it.reason)}`];
      case 'Property': {
        const kw = it.form === 'invariant' ? 'invariant' : it.form === 'compose' ? 'compose invariant' : `${it.form} property`;
        return [`${kw} ${it.name}: ${this.expr(it.expr, 0)}`];
      }
      case 'Liveness': return this.liveness(it);
      // PS5.2a, S178.
      case 'NeverEmit': return [`never ${it.name}: emit ${it.effect}${this.emitsFields(it.fields, '(')}${it.cond ? ` while ${this.expr(it.cond, 0)}` : ''}`];
      case 'Handler': {
        const head = `on ${it.action}${it.params ? `(${it.params.join(', ')})` : ''}${it.by ? ` by ${it.by.name}: ${it.by.type}` : ''}`;
        return this.blockLines(head, it.body);
      }
      case 'EffectDecl': {
        const lines = [`effect ${it.name}(${it.params.map((p) => this.param(p)).join(', ')}) {`];
        for (const e of it.items) lines.push(INDENT + this.effectItem(e));
        lines.push('}');
        return lines;
      }
      case 'Decision': {
        const lines = [`decision ${it.name}(${it.params.map((p) => this.param(p)).join(', ')}) -> ${this.type(it.result)} {`];
        for (const e of it.items) lines.push(INDENT + this.decisionItem(e));
        lines.push('}');
        return lines;
      }
    }
  }

  private liveness(it: A.Liveness): string[] {
    const body = it.from ? `${this.expr(it.from, 0)} leads to ${this.expr(it.expr, 0)}` : `eventually ${this.expr(it.expr, 0)}`;
    const q = it.quant ? `${it.quant.q} ${it.quant.var} in ${it.quant.group}: ` : '';
    // S56: in a configuration the fairness clause may be left out.
    if (!it.fair) return [`liveness ${it.name}: ${q}${body}`];
    const fair = it.fair.map((g) => g.members.map((m) => (m.input ? `${m.input.instance}${m.input.index === null ? '' : `[${m.input.index}]`}.` : '') + m.action + (m.perValue ? '(*)' : '')).join(' | ')).join(', ');
    return [`liveness ${it.name}: ${q}${body}`, `${INDENT}under fair { ${fair} }`];
  }

  /** PT7a: instances, inputs, bounds, then properties, each on its own line. */
  private configuration(c: A.Configuration): void {
    this.emit(c, '', [`configuration ${c.name} {`]);
    const heads = c.instances.map((i) => `${i.name}${i.count !== null ? `[${i.count}]` : ''}`);
    const width = Math.max(0, ...heads.map((h) => h.length));
    c.instances.forEach((i, k) => {
      const init = i.init.length ? ` { ${i.init.map((x) => `${x.field}: ${this.expr(x.value, 0)}`).join(', ')} }` : '';
      this.emit(i, INDENT, [`${heads[k].padEnd(width)} : ${i.machine.join('.')}${init}${i.scope !== undefined ? ` scope ${JSON.stringify(i.scope)}` : ''}`]);
    });
    if (c.inputs.length) {
      const refs = c.inputs.map((r) => `${r.instance}${r.index === null ? '' : `[${r.index}]`}.${r.action}`);
      this.out.push(`${INDENT}inputs { ${refs.join(', ')} }`);
    }
    if (c.bounds) this.emit(c.bounds, INDENT, [`bounds { transit ${c.bounds.transit}${c.bounds.instances !== null ? `, instances ${c.bounds.instances}` : ''} }`]);
    for (const p of c.properties) this.emit(p, INDENT, p.kind === 'Liveness' ? this.liveness(p) : [`invariant ${p.name}: ${this.expr(p.expr, 0)}`]);
    this.out.push('}');
  }

  private effectItem(e: A.EffectItem): string {
    switch (e.kind) {
      case 'EffKind': return `kind ${JSON.stringify(e.value)}`;
      case 'EffClass': return `class ${e.value}`;
      case 'EffLabels': return `labels { ${e.labels.join(', ')} }`;
      case 'EffRetry': return `retry { attempts ${e.attempts}, base ${e.base}, timeout ${e.timeout} }`;
      case 'EffTargets': return `targets { ${e.targets.map((t) => `${t.key}: ${t.key === 'egress' && t.values.length === 1 ? JSON.stringify(t.values[0]) : `[${t.values.map((v) => JSON.stringify(v)).join(', ')}]`}`).join(', ')} }`;
      case 'EffOutcome': return `${e.outcome}${e.bind !== undefined ? `(${e.bind})` : ''} -> ${e.action}(${this.args(e.args)})`;
    }
  }

  private decisionItem(e: A.DecisionItem): string {
    switch (e.kind) {
      case 'DecProvider': return `provider ${JSON.stringify(e.value)}`;
      case 'DecTimeout': return `timeout ${e.value}`;
      case 'DecBand': return `band ${decimalText(e.lo)}..${decimalText(e.hi)}`;
      default: return this.effectItem(e);
    }
  }

  private param(p: A.Param): string {
    return `${p.name}: ${this.type(p.type)}${this.check(p.check)}`;
  }

  // Statements print into a line list so comments can be placed per statement.
  private blockLines(head: string, body: A.Stmt[]): string[] {
    if (body.length === 0) return [`${head} {}`];
    const lines = [`${head} {`];
    for (const s of body) lines.push(...this.stmtLines(s, INDENT));
    lines.push('}');
    return lines;
  }

  private stmtLines(s: A.Stmt, indent: string): string[] {
    const out: string[] = [];
    for (const c of this.trivia?.leading.get(s.id) ?? []) out.push(indent + '//' + c);
    const own = this.stmt(s);
    own.forEach((l, k) => out.push(indent + l + (k === own.length - 1 ? this.trail(s) : '')));
    return out;
  }

  private stmt(s: A.Stmt): string[] {
    switch (s.kind) {
      case 'Require': return [`require ${this.expr(s.cond, 0)} else reject ${JSON.stringify(s.reason)}`];
      case 'Reject': return [`reject ${JSON.stringify(s.reason)}`];
      case 'Let': return [`let ${s.name} = ${this.expr(s.expr, 0)}`];
      case 'Assign': return [`${s.field}' = ${this.expr(s.expr, 0)}`];
      case 'MapUpdate': return [`${s.field}' = ${s.base} with [${this.expr(s.key, 0)}] = ${this.expr(s.value, 0)}`];
      case 'If': {
        const head = `if ${this.expr(s.cond, 0, true)}`;
        // An empty then-block prints as one line `if c {}`; with an else it must open and close on its own lines.
        const lines = s.else && s.then.length === 0 ? [`${head} {`, '}'] : this.blockLines(head, s.then);
        if (s.else) {
          const els = this.blockLines('', s.else);
          lines[lines.length - 1] = `} else${els[0]}`;
          lines.push(...els.slice(1));
        }
        return lines;
      }
      case 'Match': {
        const lines = [`match ${this.expr(s.scrutinee, 0, true)} {`];
        for (const arm of s.arms) {
          for (const c of this.trivia?.leading.get(arm.id) ?? []) lines.push(INDENT + '//' + c);
          const pat = this.pattern(arm.pattern);
          let armLines: string[];
          if (arm.body.length === 1 && !this.trivia?.leading.has(arm.body[0].id)) {
            const inner = this.stmt(arm.body[0]);
            armLines = [`${pat} => ${inner[0]}`, ...inner.slice(1)];
            const t = this.trail(arm.body[0]);
            armLines[armLines.length - 1] += t;
          } else {
            armLines = this.blockLines(`${pat} =>`, arm.body);
          }
          armLines[armLines.length - 1] += this.trail(arm);
          for (const l of armLines) lines.push(INDENT + l);
        }
        lines.push('}');
        return lines;
      }
      case 'Intent': return [this.intent(s)];
      case 'For': return this.blockLines(`for ${s.var} in ${s.lo}..${this.expr(s.hi, 0)}`, s.body);
    }
  }

  private intent(s: A.IntentStmt): string {
    const call = `${s.target}(${this.args(s.args)})`;
    const idx = s.index ? `[${this.expr(s.index, 0)}]` : '';
    switch (s.op) {
      case 'emit': return `emit ${call}`;
      case 'after': return `after ${s.modifier} -> ${call} as ${s.as}${idx}`;
      case 'cancel': return `cancel ${s.target}${idx}`;
      case 'send': return `send ${this.expr(s.to!, 0)} <- ${call}${s.as ? ` as ${s.as}` : ''}`;
      case 'signal': return `signal ${s.extra[0]}${idx} -> ${call}`;
      case 'decide': return `decide ${call}`;
      case 'adjudicate': return `adjudicate ${s.target} as ${s.modifier}`;
      case 'spawn': {
        let w = `spawn ${s.modifier ? s.modifier + ' ' : ''}${s.target} as ${s.as}${idx}`;
        for (let k = 0; k < s.extra.length; k += 2) {
          if (s.extra[k] === 'create') w += ` -> ${s.extra[k + 1]}(${this.args(s.args)})`;
          else w += s.extra[k] === 'complete' ? ` on complete -> ${s.extra[k + 1]}` : ` on parent terminal -> ${s.extra[k + 1]}`;
        }
        return w;
      }
    }
  }

  private args(args: A.NamedArg[]): string {
    return args.map((a) => (a.name ? `${a.name}: ` : '') + this.expr(a.value, 0)).join(', ');
  }

  private pattern(p: A.Pattern): string {
    if (p.kind === 'PWild') return '_';
    if (p.fields.length === 0) return p.ctor;
    return `${p.ctor} { ${p.fields.map((f) => `${f.name}: ${f.bind ?? this.expr(f.literal!, 0)}`).join(', ')} }`;
  }

  // ── expressions ─────────────────────────────────────────────────────────
  /**
   * `ctx` is the precedence level the surrounding position accepts (0: any).
   * `noStruct` marks an `if` condition or `match` scrutinee (S10): a
   * constructor with a payload, or a map literal, must be parenthesised there.
   */
  expr(e: A.Expr, ctx: number, noStruct = false, parentOp: string | null = null): string {
    const wrap = (s: string, prec: number): string => {
      const mixed = parentOp !== null && ((parentOp === 'implies' && (prec === 7 || prec === 8)) || (prec === 9 && (parentOp === '&&' || parentOp === '||')));
      return (ctx !== 0 && prec > ctx) || mixed ? `(${s})` : s;
    };
    switch (e.kind) {
      case 'Int': return String(e.value);
      case 'Decimal': return decimalText(e.value);
      case 'Bool': return String(e.value);
      case 'String': return JSON.stringify(e.value);
      case 'Name': return e.name;
      case 'Primed': return `${e.name}'`;
      case 'Member': return `${this.expr(e.object, 1, noStruct)}.${e.prop}`;
      case 'Index': return `${this.expr(e.object, 1, noStruct)}[${this.expr(e.index, 0)}]`;
      // PT8.1: `s has x`, which the parser reads as the call has(s, x).
      case 'Call': return e.callee === 'has' && e.args.length === 2 ? wrap(`${this.expr(e.args[0], 4, noStruct)} has ${this.expr(e.args[1], 4, noStruct)}`, 5) : `${e.callee}(${e.args.map((a) => this.expr(a, 0)).join(', ')})`;
      case 'Unary': return wrap(`${e.op}${this.expr(e.arg, 2, noStruct)}`, 2);
      case 'Spawned': return `${e.key}${e.index ? `[${this.expr(e.index, 0)}]` : ''} spawned`;
      case 'Star': return '*';
      case 'Emits': return `emits(${e.effect}${this.emitsFields(e.fields, ', ')})`;
      case 'Quant': { const q = `${e.q} ${e.var} in ${e.group}: ${this.expr(e.body, 0)}`; return ctx === 0 && parentOp === null ? q : `(${q})`; }
      case 'Is': return wrap(`${this.expr(e.expr, 4, noStruct)} is ${e.ctors.join(' | ')}`, 5);
      case 'In': return wrap(`${this.expr(e.expr, 4, noStruct)} in { ${e.set.map((x) => this.expr(x, 0)).join(', ')} }`, 5);
      case 'Binary': {
        const p = PREC[e.op];
        // Left-associative levels accept their own level on the left; right-associative on the right; non-associative on neither.
        const assoc = e.op === 'implies' ? 'right' : p === 5 || p === 6 ? 'none' : 'left';
        const lctx = assoc === 'left' ? p : p - 1;
        const rctx = assoc === 'right' ? p : p - 1;
        const s = `${this.expr(e.left, lctx, noStruct, e.op)} ${e.op} ${this.expr(e.right, rctx, noStruct, e.op)}`;
        return wrap(s, p);
      }
      case 'CtorExpr': {
        const s = `${e.ctor} { ${e.fields.map((f) => `${f.name}: ${this.expr(f.value, 0)}`).join(', ')} }`;
        return noStruct ? `(${s})` : s;
      }
      case 'MapLit': {
        const s = `{ ${e.entries.map((x) => `${this.expr(x.key, 0)}: ${this.expr(x.value, 0)}`).join(', ')} }`;
        return noStruct ? `(${s})` : s;
      }
      case 'ArrayLit': return `[${e.items.map((x) => this.expr(x, 0)).join(', ')}]`;
    }
  }
}

/** A decimal literal (S76) from thousandths: 800 is 0.8, 1000 is 1.0, 50 is 0.05. */
export function decimalText(v: number): string {
  const whole = Math.trunc(v / 1000);
  const frac = String(v % 1000).padStart(3, '0').replace(/0+$/, '');
  return `${whole}.${frac || '0'}`;
}
