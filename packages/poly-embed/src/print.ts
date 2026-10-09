// The printer (PT2.5, S71): any AST as the embedded TypeScript surface. Reading the text back with read.ts
// gives the same AST, so the same digest (PT1.4); the test runs over every conformance source.
//
// Every AST node has exactly one embedded form, in the table of PT2.5 and the appendix of plan-m2. A name
// is a property of the arrow's parameter, `$.x`. Operators keep TypeScript's precedence, so the printer
// parenthesises by TypeScript's table, not poly's (PS12): the tree TypeScript parses is the AST printed.
import type * as A from '@poly/core';

const q = (s: string) => JSON.stringify(s);
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** The functions of PT2.2 an expression may call by name; any other callee prints as call('f', …). */
export const FUNCTIONS = new Set(['count', 'before', 'rejected', 'init', 'sum', 'all', 'any', 'unknown']);

// TypeScript's binary precedence (higher binds tighter); every operator here is left-associative.
const TS_PREC: Record<string, number> = { '*': 12, '/': 12, '%': 12, '+': 11, '-': 11, '<': 9, '<=': 9, '>': 9, '>=': 9, '==': 8, '!=': 8, '&&': 4, '||': 3 };
const TS_OP: Record<string, string> = { '==': '===', '!=': '!==' };

class Printer {
  readonly used = new Set<string>();

  /**
   * `p` is the arrow parameter a name reads through, `$` unless a fix is spliced where the author named it
   * otherwise; `names` maps a combinator to the local name the file imports it under (M3-3).
   */
  constructor(private readonly p = '$', private readonly names: ReadonlyMap<string, string> = new Map()) {}

  private use(name: string): string { this.used.add(name); return this.names.get(name) ?? name; }

  module(m: A.Module): string {
    const decls = m.decls.map((d) => this.decl(d, '  '));
    const body = `export default ${this.use('module')}(${q(m.name)}, [\n${decls.map((d) => `  ${d},\n`).join('')}]);\n`;
    return `import { ${[...this.used].sort().join(', ')} } from '@cognitive-fab/poly/embed';\n\n${body}`;
  }

  private decl(d: A.Decl, ind: string): string {
    switch (d.kind) {
      case 'EnumDecl': return `${this.use('enumType')}(${q(d.name)}, [${d.members.map(q).join(', ')}])`;
      case 'TypeDecl': return `${this.use('union')}(${q(d.name)}, { ${d.ctors.map((c) => `${this.key(c.name)}: ${this.fields(c.fields)}`).join(', ')} })`;
      case 'RecordDecl': return `${this.use(d.claims ? 'claims' : 'record')}(${q(d.name)}, ${this.fields(d.fields)})`;
      case 'Use': return `${this.use('use')}(${q(d.path.join('.'))})`;
      case 'Machine': return this.machine(d, ind);
      case 'Configuration': return this.configuration(d, ind);
      // PT1.1a: a policy lives in a .policy.poly file; the embedded surface has none (PT2.5).
      case 'Policy': throw new Error('policy ' + d.name + ' has no embedded form: policies are written in .policy.poly files (PT1.1a)');
      // PT10, PT2.5: a workflow, with its tools keyed by effect kind.
      // PT21.1, S186: a channel, with its Peer bindings keyed by Peer action.
      case 'Channel': {
        const peer = d.maps.map((m) => `${ind}  ${this.key(m.peer)}: ${q(`${m.machine}.${m.action}`)},\n`).join('');
        const starts = d.starts ? `, starts: ${q(`${d.starts.machine}.${d.starts.action}`)}${d.starts.onInbound ? ', onInbound: true' : ''}` : '';
        return `${this.use('channel')}(${q(d.name)}, { kind: ${q(d.channelKind)}${d.adapter === null ? '' : `, adapter: ${q(d.adapter)}`}, thread: ${q(d.thread)}${starts}${d.audience ? `, audience: ${q(d.audience)}` : ''}${d.principalFrom ? `, principal: ${q(d.principalFrom)}` : ''}, peer: {\n${peer}${ind}} })`;
      }
      // PT10e: credential(name, { kind, provider, grant, pkce?, scopes, holder? }).
      case 'Credential': return `${this.use('credential')}(${q(d.name)}, { kind: ${q(d.credKind)}, provider: ${q(d.provider)}, grant: ${q(d.grant)}${d.pkce ? ', pkce: true' : ''}, scopes: [${d.scopes.map(q).join(', ')}]${d.holder === null ? '' : `, holder: ${q(d.holder)}`} })`;
      // PS1.4b, PS17.0: audience([…]) and source(name, { … }).
      case 'Audience': return `${this.use('audience')}([${d.classes.map(q).join(', ')}])`;
      case 'Source': return `${this.use('source')}(${q(d.name)}, { kind: ${q(d.sourceKind)}${d.adapter === null ? '' : `, adapter: ${q(d.adapter)}`}, audience: ${q(d.audience)}${d.owned ? ', owned: true' : ''}${d.freshness === null ? '' : `, freshness: ${q(d.freshness)}`}${d.stale === 'escalate' ? '' : `, stale: ${q(d.stale)}`}${d.keys?.length ? `, keys: [${d.keys.map(q).join(', ')}]` : ''} })`;
      // PT10r: route(name, { tiers: [{ … }], escalate: [[…]], budget? }) and budget(name, { caps: [{ … }], onExhausted? }).
      case 'Route': {
        const tiers = d.tiers.map((t) => `${ind}  { name: ${q(t.name)}, provider: ${q(t.provider)}, prices: ${q(t.prices)}${t.calibration === null ? '' : `, calibration: ${q(t.calibration)}`}, maxInputTokens: ${t.maxInputTokens}, maxTokens: ${t.maxTokens} },\n`).join('');
        const escalate = d.escalate.map((e) => (e.on === 'failed' ? "['failed']" : `[${q(e.on)}, ${decimal(e.below)}]`)).join(', ');
        return `${this.use('route')}(${q(d.name)}, { tiers: [\n${tiers}${ind}], escalate: [${escalate}]${d.budget === null ? '' : `, budget: ${q(d.budget)}`} })`;
      }
      case 'Budget': {
        const caps = d.caps.map((c) => `${ind}  { currency: ${q(c.currency)}, amount: ${money(c.amount)}, per: ${q(c.run ? 'run' : c.period ?? 'scope')}${c.period !== null && c.scope ? ', scope: true' : ''} },\n`).join('');
        return `${this.use('budget')}(${q(d.name)}, { caps: [\n${caps}${ind}]${d.onExhausted === 'deny' ? '' : `, onExhausted: ${q(d.onExhausted)}`} })`;
      }
      case 'Workflow': {
        const key = d.key ? `, key: { template: ${q(d.key.template)}${d.key.fields.length ? `, where: { ${d.key.fields.map((f) => `${this.key(f.name)}: ${q(f.pattern)}`).join(', ')} }` : ''} }` : '';
        const tools = d.tools.map((t) => `${ind}  ${q(t.effect)}: { tool: ${q(t.tool)}${t.target === null ? '' : `, target: ${q(t.target)}`}, why: ${q(t.why)} },\n`).join('');
        return `${this.use('workflow')}(${q(d.name)}, { runs: ${q(d.machine)}, input: ${q(d.input)}${key}, tools: {\n${tools}${ind}} })`;
      }
    }
  }

  private key(name: string): string { return IDENT.test(name) ? name : q(name); }

  private fields(fs: A.PayloadField[]): string {
    return fs.length ? `{ ${fs.map((f) => `${this.key(f.name)}: ${this.type(f.type)}`).join(', ')} }` : '{}';
  }

  type(t: A.TypeExpr): string {
    this.use('t');
    switch (t.kind) {
      case 'TBool': return 't.bool';
      case 'TInt': return 't.int';
      case 'TString': return 't.string';
      case 'TRange': return `t.range(${t.lo}, ${t.hi})`;
      case 'TName': return `t.named(${q(t.name)})`;
      case 'TMap': return `t.map(${this.type(t.key)}, ${this.type(t.value)})`;
      case 'TRef': return `t.ref(${q(t.machine.join('.'))})`;
      case 'TConf': return 't.conf';
    }
  }

  private literal(l: A.Literal): string {
    switch (l.kind) {
      case 'Int': return String(l.value);
      case 'Bool': return String(l.value);
      case 'String': return q(l.value);
      case 'Name': return `${this.use('name')}(${q(l.name)})`;
    }
  }

  private domain(d: A.Domain): string {
    return d.kind === 'DomainSet' ? `[${d.values.map((v) => this.literal(v)).join(', ')}]` : `{ lo: ${d.lo}, hi: ${d.hi} }`;
  }

  private param(p: A.Param): string {
    let s = this.type(p.type);
    if (p.check) {
      const mode = p.check.mode ? `, ${q(p.check.mode)}` : '';
      s += p.check.domain.kind === 'DomainSet' ? `.check(${this.domain(p.check.domain)}${mode})` : `.check(${p.check.domain.lo}, ${p.check.domain.hi}${mode})`;
    }
    return s;
  }

  private params(ps: A.Param[]): string {
    return ps.length ? `{ ${ps.map((p) => `${this.key(p.name)}: ${this.param(p)}`).join(', ')} }` : '{}';
  }

  /** An arrow whose body is an expression; an object literal there would read as a block. */
  private arrow(e: A.Expr): string { return `(${this.p}) => ${e.kind === 'MapLit' ? `(${this.expr(e, 0)})` : this.expr(e, 0)}`; }

  private machine(m: A.Machine, ind: string): string {
    const inner = ind + '  ';
    const parts: string[] = [];
    if (m.service) parts.push(`${inner}service: true,`);
    if (m.version !== null) parts.push(`${inner}version: ${m.version},`);
    parts.push(`${inner}state: {${m.fields.length ? '\n' + m.fields.map((f) => `${inner}  ${this.key(f.name)}: ${this.field(f)},\n`).join('') + inner : ''}},`);
    parts.push(`${inner}items: [${m.items.length ? '\n' + m.items.map((i) => `${inner}  ${this.item(i, inner + '  ')},\n`).join('') + inner : ''}],`);
    return `${this.use('machine')}(${q(m.name)}, {\n${parts.join('\n')}\n${ind}})`;
  }

  private field(f: A.Field): string {
    const opts: string[] = [];
    if (f.check) {
      opts.push(`check: ${this.domain(f.check.domain)}`);
      if (f.check.mode) opts.push(`mode: ${q(f.check.mode)}`);
    }
    if (f.flag) opts.push(`flag: ${q(f.flag)}`);
    return `${this.use('field')}(${this.type(f.type)}, ${this.arrow(f.init)}${opts.length ? `, { ${opts.join(', ')} }` : ''})`;
  }

  private item(i: A.MachineItem, ind: string): string {
    switch (i.kind) {
      case 'Terminal': return `${this.use('terminal')}(${this.arrow(i.expr)})`;
      case 'Action': return `${this.use('action')}(${q(i.name)}, ${this.params(i.params)})`;
      // PD5.1.2: `by c: C` as an options argument; the parameter list is then written, or null.
      case 'Handler': return `${this.use('on')}(${q(i.action)}, (${this.p}) => ${this.stmts(i.body, ind)}${i.params || i.by ? `, ${i.params ? `[${i.params.map(q).join(', ')}]` : 'null'}` : ''}${i.by ? `, { by: [${q(i.by.name)}, ${q(i.by.type)}] }` : ''})`;
      case 'Guard': return `${this.use('guard')}(${this.arrow(i.cond)}, ${q(i.reason)})`;
      case 'Property': return this.property(i);
      case 'Liveness': return this.liveness(i);
      // PS5.2a, S178: the field filter is an arrow, as its constants are names read through $.
      case 'NeverEmit': return `${this.use('never')}(${q(i.name)}, ${q(i.effect)}, (${this.p}) => (${i.fields.length ? `{ ${i.fields.map((f) => `${this.key(f.name)}: ${this.expr(f.value, 0)}`).join(', ')} }` : '{}'})${i.cond ? `, ${this.arrow(i.cond)}` : ''})`;
      case 'EffectDecl': return `${this.use('effect')}(${q(i.name)}, ${this.params(i.params)}, [${i.items.map((x) => this.effItem(x)).join(', ')}])`;
      case 'Decision': return `${this.use('decision')}(${q(i.name)}, ${this.params(i.params)}, ${this.type(i.result)}, [${i.items.map((x) => this.decisionItem(x)).join(', ')}])`;
    }
  }

  private property(p: A.Property): string {
    const fn = { invariant: 'invariant', step: 'stepProperty', reject: 'rejectProperty', path: 'pathProperty', compose: 'composeInvariant' }[p.form];
    return `${this.use(fn)}(${q(p.name)}, ${this.arrow(p.expr)})`;
  }

  private liveness(l: A.Liveness): string {
    const goal = l.from ? `{ from: ${this.arrow(l.from)}, to: ${this.arrow(l.expr)} }` : `{ eventually: ${this.arrow(l.expr)} }`;
    const opts: string[] = [];
    if (l.quant) opts.push(`${l.quant.q}: [${q(l.quant.var)}, ${q(l.quant.group)}]`);
    if (l.fair) opts.push(`fair: [${l.fair.map((g) => `[${g.members.map((m) => q(fairMember(m))).join(', ')}]`).join(', ')}]`);
    return `${this.use('liveness')}(${q(l.name)}, ${goal}${opts.length ? `, { ${opts.join(', ')} }` : ''})`;
  }

  private effItem(x: A.EffectItem): string {
    switch (x.kind) {
      case 'EffKind': return `${this.use('kind')}(${q(x.value)})`;
      case 'EffLabels': return `${this.use('labels')}([${x.labels.map(q).join(', ')}])`;
      case 'EffClass': return `${this.use('cls')}(${q(x.value)})`;
      case 'EffRetry': return `${this.use('retry')}(${x.attempts}, ${q(x.base)}, ${q(x.timeout)})`;
      // PT6.5, S151: one entry per key, in source order.
      case 'EffTargets': return `${this.use('targets')}([${x.targets.map((t) => `[${q(t.key)}, [${t.values.map(q).join(', ')}]]`).join(', ')}])`;
      // PT10e: uses(credential, [scopes], holder?).
      case 'EffUses': return `${this.use('uses')}(${q(x.credential)}, [${x.scopes.map(q).join(', ')}]${x.holder === null ? '' : `, ${q(x.holder)}`})`;
      // PS17.2, PS17.3, PS17.5.
      case 'EffRetrieve': return `${this.use('retrieve')}(${q(x.source)}, { ${x.owner === null ? '' : `owner: ${q(x.owner)}, `}${x.key ? `key: [${q(x.key.name)}, ${q(x.key.param)}], ` : ''}limit: ${x.limit} })`;
      case 'EffRemember': return `${this.use('remember')}(${q(x.source)}, ${q(x.provenance)}, ${q(x.about)})`;
      case 'EffTo': return `${this.use('to')}(${q(x.param)})`;
      case 'EffAudience': return `${this.use('audience')}(${q(x.cls)})`;
      // Outside a handler no arrow gives `$`: arguments that name a constructor or a field take one.
      case 'EffOutcome': {
        const args = x.args.some((a) => readsName(a.value)) ? `(${this.p}) => (${this.args(x.args)})` : this.args(x.args);
        // PD1.2b, S79: `ok(r) -> A(…)` is okWith('r', 'A', …), its arguments naming the reply as $.r.
        return x.bind !== undefined ? `${this.use('okWith')}(${q(x.bind)}, ${q(x.action)}, ${args})` : `${this.use(x.outcome)}(${q(x.action)}, ${args})`;
      }
    }
  }

  private decisionItem(x: A.DecisionItem): string {
    switch (x.kind) {
      case 'DecProvider': return `${this.use('provider')}(${q(x.value)})`;
      case 'DecTimeout': return `${this.use('timeout')}(${q(x.value)})`;
      case 'DecBand': return `${this.use('band')}(${decimal(x.lo)}, ${decimal(x.hi)})`;
      case 'DecCites': return `${this.use('cites')}(${q(x.param)})`;
      case 'DecRoute': return `${this.use('route')}(${q(x.route)})`;
      // PT2.5: PT10r gives the clause of S454 no embedded form, so none is invented here.
      case 'DecBudget': throw new Error('a decision\'s budget clause (prices ... budget b, PS18.4a) has no embedded form (PT10r)');
      default: return this.effItem(x);
    }
  }

  private configuration(c: A.Configuration, ind: string): string {
    const inner = ind + '  ';
    const parts: string[] = [];
    parts.push(`${inner}instances: [${c.instances.map((i) => this.instance(i)).join(', ')}],`);
    parts.push(`${inner}inputs: [${c.inputs.map((r) => q(inputRef(r))).join(', ')}],`);
    if (c.bounds) parts.push(`${inner}bounds: { transit: ${c.bounds.transit}${c.bounds.instances !== null ? `, instances: ${c.bounds.instances}` : ''} },`);
    parts.push(`${inner}properties: [${c.properties.length ? '\n' + c.properties.map((p) => `${inner}  ${p.kind === 'Property' ? this.property(p) : this.liveness(p)},\n`).join('') + inner : ''}],`);
    return `${this.use('configuration')}(${q(c.name)}, {\n${parts.join('\n')}\n${ind}})`;
  }

  private instance(i: A.ConfigInstance): string {
    const opts: string[] = [];
    if (i.count !== null) opts.push(`count: ${i.count}`);
    if (i.init.length) opts.push(`init: (${this.p}) => ({ ${i.init.map((x) => `${this.key(x.field)}: ${this.expr(x.value, 0)}`).join(', ')} })`);
    if (i.scope !== undefined) opts.push(`scope: ${q(i.scope)}`);
    return `${this.use('instance')}(${q(i.name)}, ${q(i.machine.join('.'))}${opts.length ? `, { ${opts.join(', ')} }` : ''})`;
  }

  // ── statements ───────────────────────────────────────────────────────────
  private stmts(body: A.Stmt[], ind: string): string {
    if (!body.length) return '[]';
    return `[\n${body.map((s) => `${ind}  ${this.stmt(s, ind + '  ')},\n`).join('')}${ind}]`;
  }

  stmtAt(s: A.Stmt, ind: string): string { return this.stmt(s, ind); }

  private stmt(s: A.Stmt, ind: string): string {
    switch (s.kind) {
      case 'Require': return `${this.use('require')}(${this.expr(s.cond, 0)}, ${q(s.reason)})`;
      case 'Reject': return `${this.use('reject')}(${q(s.reason)})`;
      case 'Let': return `${this.use('let_')}(${q(s.name)}, ${this.expr(s.expr, 0)})`;
      case 'Assign': return `${this.use('set')}(${q(s.field)}, ${this.expr(s.expr, 0)})`;
      case 'MapUpdate': return `${this.use('setEntry')}(${q(s.field)}, ${this.expr(s.key, 0)}, ${this.expr(s.value, 0)}${s.base !== s.field ? `, ${q(s.base)}` : ''})`;
      case 'If': return `${this.use('when')}(${this.expr(s.cond, 0)}, ${this.stmts(s.then, ind)}${s.else ? `, ${this.stmts(s.else, ind)}` : ''})`;
      case 'Match': return `${this.use('match')}(${this.expr(s.scrutinee, 0)}, [${s.arms.length ? '\n' + s.arms.map((a) => `${ind}  ${this.use('arm')}(${this.pattern(a.pattern)}, ${this.stmts(a.body, ind + '  ')}),\n`).join('') + ind : ''}])`;
      case 'For': return `${this.use('forEach')}(${q(s.var)}, ${s.lo}, ${this.expr(s.hi, 0)}, ${this.stmts(s.body, ind)})`;
      case 'Intent': return this.intent(s);
    }
  }

  pattern(p: A.Pattern): string {
    if (p.kind === 'PWild') return `'_'`;
    const fs = p.fields.map((f) => `${this.key(f.name)}: ${f.bind !== null ? `${this.use('bind')}(${q(f.bind)})` : this.literal(f.literal!)}`);
    return `${this.use('pattern')}(${q(p.ctor)}${fs.length ? `, { ${fs.join(', ')} }` : ''})`;
  }

  private args(args: A.NamedArg[]): string {
    if (args.length && args.every((a) => a.name !== null)) return `{ ${args.map((a) => `${this.key(a.name!)}: ${this.expr(a.value, 0)}`).join(', ')} }`;
    return `[${args.map((a) => (a.name === null ? this.expr(a.value, 0) : `${this.use('named')}(${q(a.name)}, ${this.expr(a.value, 0)})`)).join(', ')}]`;
  }

  private intent(s: A.IntentStmt): string {
    const idx = s.index ? `, ${this.expr(s.index, 0)}` : '';
    switch (s.op) {
      case 'emit': return `${this.use('emit')}(${q(s.target)}, ${this.args(s.args)})`;
      case 'decide': return `${this.use('decide')}(${q(s.target)}, ${this.args(s.args)})`;
      case 'adjudicate': return `${this.use('adjudicate')}(${q(s.target)}, ${q(s.modifier!)})`;
      case 'after': return `${this.use('after')}(${q(s.modifier!)}, ${q(s.target)}, ${this.args(s.args)}, ${q(s.as!)}${idx})`;
      case 'cancel': return `${this.use('cancel')}(${q(s.target)}${idx})`;
      case 'send': return `${this.use('send')}(${this.expr(s.to!, 0)}, ${q(s.target)}, ${this.args(s.args)}${s.as ? `, ${q(s.as)}` : ''})`;
      case 'signal': return `${this.use('signal')}(${q(s.extra[0])}, ${s.index ? this.expr(s.index, 0) : 'null'}, ${q(s.target)}, ${this.args(s.args)})`;
      case 'spawn': {
        const opts: string[] = [];
        if (s.index) opts.push(`index: ${this.expr(s.index, 0)}`);
        if (s.modifier === 'detached') opts.push('detached: true');
        const pair = (tag: string) => { const i = s.extra.indexOf(tag); return i >= 0 ? s.extra[i + 1] : null; };
        const create = pair('create');
        if (create) opts.push(`create: [${q(create)}, ${this.args(s.args)}]`);
        const complete = pair('complete');
        if (complete) opts.push(`complete: ${q(complete)}`);
        const parentTerminal = pair('parent-terminal');
        if (parentTerminal) opts.push(`parentTerminal: ${q(parentTerminal)}`);
        return `${this.use('spawn')}(${q(s.target)}, ${q(s.as!)}${opts.length ? `, { ${opts.join(', ')} }` : ''})`;
      }
    }
  }

  // ── expressions ──────────────────────────────────────────────────────────
  /** `ctx` is the TypeScript precedence the context requires; a lower one is parenthesised. */
  expr(e: A.Expr, ctx: number): string {
    switch (e.kind) {
      case 'Int': return e.value < 0 ? `(${e.value})` : String(e.value);
      case 'Decimal': return decimal(e.value);
      case 'Bool': return String(e.value);
      case 'String': return q(e.value);
      case 'Name': return IDENT.test(e.name) ? `${this.p}.${e.name}` : `${this.p}[${q(e.name)}]`;
      case 'Primed': return `${this.use('primed')}(${q(e.name)})`;
      case 'Member': return `${this.postfixable(e.object)}.${e.prop}`;
      case 'Index': return `${this.postfixable(e.object)}[${e.index.kind === 'Star' ? this.use('ALL') : this.expr(e.index, 0)}]`;
      case 'Star': return this.use('ALL');
      case 'Call': return FUNCTIONS.has(e.callee) ? `${this.use(e.callee)}(${e.args.map((a) => this.expr(a, 0)).join(', ')})` : `${this.use('call')}(${[q(e.callee), ...e.args.map((a) => this.expr(a, 0))].join(', ')})`;
      case 'Unary': {
        // `- -x` would read as a decrement, and `!` binds tighter than any binary operator.
        const arg = e.arg.kind === 'Unary' || e.arg.kind === 'Binary' || (e.arg.kind === 'Int' && e.arg.value < 0) ? `(${this.expr(e.arg, 0)})` : this.operand(e.arg, 15);
        return `${e.op}${arg}`;
      }
      case 'Binary': {
        if (e.op === 'implies') return `${this.use('implies')}(${this.expr(e.left, 0)}, ${this.expr(e.right, 0)})`;
        const p = TS_PREC[e.op];
        const text = `${this.operand(e.left, p)} ${TS_OP[e.op] ?? e.op} ${this.operand(e.right, p + 1)}`;
        return p < ctx ? `(${text})` : text;
      }
      case 'Is': return `${this.use('is')}(${[this.expr(e.expr, 0), ...e.ctors.map(q)].join(', ')})`;
      case 'In': return `${this.use('isIn')}(${this.expr(e.expr, 0)}, [${e.set.map((x) => this.expr(x, 0)).join(', ')}])`;
      case 'CtorExpr': return `${this.use('ctor')}(${q(e.ctor)}, ${e.fields.length ? `{ ${e.fields.map((f) => `${this.key(f.name)}: ${this.expr(f.value, 0)}`).join(', ')} }` : '{}'})`;
      case 'MapLit': return `{ ${e.entries.map((x) => `${this.mapKey(x.key)}: ${this.expr(x.value, 0)}`).join(', ')} }`;
      case 'ArrayLit': return `[${e.items.map((x) => this.expr(x, 0)).join(', ')}]`;
      case 'Spawned': return `${this.use('spawned')}(${e.index ? `${this.p}.${e.key}[${this.expr(e.index, 0)}]` : `${this.p}.${e.key}`})`;
      case 'Quant': return `${this.use(e.q)}(${q(e.var)}, ${q(e.group)}, ${this.arrow(e.body)})`;
      case 'Emits': return `${this.use('emits')}(${q(e.effect)}${e.fields.length ? `, { ${e.fields.map((f) => `${this.key(f.name)}: ${this.expr(f.value, 0)}`).join(', ')} }` : ''})`;
    }
  }

  /** S84: a record or map literal as an operand is lit({ … }), since tsc refuses `===` with an object literal. */
  private operand(e: A.Expr, ctx: number): string {
    return e.kind === 'MapLit' || e.kind === 'ArrayLit' ? `${this.use('lit')}(${this.expr(e, 0)})` : this.expr(e, ctx);
  }

  /** The object of a member access or an index: a primary, or parenthesised. */
  private postfixable(e: A.Expr): string {
    const s = this.expr(e, 0);
    return e.kind === 'Unary' || e.kind === 'Binary' || e.kind === 'MapLit' || (e.kind === 'Int') ? `(${s})` : s;
  }

  /** PT2.5: an identifier key is a name, a numeric key an int, a string key a string, `[e]` any other. */
  private mapKey(k: A.Expr): string {
    if (k.kind === 'Name' && IDENT.test(k.name)) return k.name;
    if (k.kind === 'Int' && k.value >= 0) return String(k.value);
    if (k.kind === 'String') return q(k.value);
    return `[${this.expr(k, 0)}]`;
  }
}

/** A decimal literal (S76) from thousandths, always with a point, so that it reads back as a decimal. */
/** PS18.3: an amount of micro-units as a decimal literal, `0.5` or `20`. */
function money(micro: number): string {
  const whole = Math.trunc(micro / 1_000_000);
  const frac = String(micro % 1_000_000).padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

function decimal(v: number): string {
  const whole = Math.trunc(v / 1000);
  const frac = String(v % 1000).padStart(3, '0').replace(/0+$/, '');
  return `${whole}.${frac || '0'}`;
}

/** Whether an expression names something, so that it needs the arrow's `$`. */
function readsName(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  if (Array.isArray(e)) return e.some(readsName);
  const o = e as { kind?: string };
  if (o.kind === 'Name' || o.kind === 'Spawned') return true;
  return Object.entries(o).some(([k, v]) => k !== 'span' && readsName(v));
}

function fairMember(m: A.FairGroup['members'][number]): string {
  const at = m.input ? `${m.input.instance}${m.input.index === null ? '' : `[${m.input.index}]`}.` : '';
  return `${at}${m.action}${m.perValue ? '(*)' : ''}`;
}

function inputRef(r: A.InputRef): string {
  return `${r.instance}${r.index === null ? '' : `[${r.index}]`}.${r.action}`;
}

/** A module as embedded TypeScript (PT2.5). */
export function printModule(m: A.Module): string {
  return new Printer().module(m);
}

export type NodeKind = 'expr' | 'stmt' | 'pattern' | 'type';

/**
 * One node as embedded TypeScript, for a fix spliced into an embedded module at the node's span (M3-3). A
 * statement's inner lines are indented from `indent`; an expression that is not a primary is parenthesised, since
 * the context it lands in is not known here. `used` lists the combinators it calls, which the file must import.
 */
export function printNode(kind: NodeKind, node: unknown, opts: { indent?: string; param?: string; names?: ReadonlyMap<string, string> } = {}): { text: string; used: string[] } {
  const pr = new Printer(opts.param, opts.names);
  let text: string;
  switch (kind) {
    case 'expr': {
      const e = node as A.Expr;
      text = pr.expr(e, 0);
      if (e.kind === 'Binary' || e.kind === 'Unary') text = `(${text})`;
      break;
    }
    case 'stmt': text = pr.stmtAt(node as A.Stmt, opts.indent ?? ''); break;
    case 'pattern': text = pr.pattern(node as A.Pattern); break;
    case 'type': text = pr.type(node as A.TypeExpr); break;
  }
  return { text, used: [...pr.used] };
}
