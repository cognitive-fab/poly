// The embedded front end (PT2.5, S71): a TypeScript module written with the poly combinators, read with the
// TypeScript compiler API into the same AST the standalone parser produces, so the same digest (PT1.4).
//
// The mapping is syntactic: which node a form is follows from the combinator's name and the shape of its
// arguments, never from a type (S71). Only the forms of PT2.5's table are accepted, and inside an arrow only
// the PT2.2 subset; anything else is PL0301 OUTSIDE_EMBEDDED_SUBSET, at the offending node.
import ts from 'typescript';
import { assignIds, diag, type Diagnostic } from '@poly/core';
import type * as A from '@poly/core';
import { FUNCTIONS } from './print.js';

export const EMBED_MODULE = '@cognitive-fab/poly/embed';

export interface EmbedResult {
  module: A.Module | null;
  diagnostics: Diagnostic[];
}

class Outside extends Error {
  constructor(readonly node: ts.Node, message: string) { super(message); }
}

const BINARY: Partial<Record<ts.SyntaxKind, A.BinaryOp>> = {
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: '==',
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: '!=',
  [ts.SyntaxKind.AmpersandAmpersandToken]: '&&',
  [ts.SyntaxKind.BarBarToken]: '||',
  [ts.SyntaxKind.PlusToken]: '+',
  [ts.SyntaxKind.MinusToken]: '-',
  [ts.SyntaxKind.AsteriskToken]: '*',
  [ts.SyntaxKind.SlashToken]: '/',
  [ts.SyntaxKind.PercentToken]: '%',
  [ts.SyntaxKind.LessThanToken]: '<',
  [ts.SyntaxKind.LessThanEqualsToken]: '<=',
  [ts.SyntaxKind.GreaterThanToken]: '>',
  [ts.SyntaxKind.GreaterThanEqualsToken]: '>=',
};

const FAIR = /^(?:([A-Za-z_$][\w$]*)(?:\[(\*|\d+)\])?\.)?([A-Za-z_$][\w$]*)(\(\*\))?$/;
const INPUT = /^([A-Za-z_$][\w$]*)(?:\[(\*|\d+)\])?\.([A-Za-z_$][\w$]*)$/;

class Reader {
  /** Local name to combinator name, from the import of EMBED_MODULE. */
  private readonly names = new Map<string, string>();
  /** The parameters of the enclosing arrows, innermost last: `$.x` is a name (PT2.5). */
  private readonly params: string[] = [];

  constructor(private readonly sf: ts.SourceFile) {}

  private fail(node: ts.Node, message: string): never { throw new Outside(node, message); }

  private span(node: ts.Node): A.Span {
    const s = this.sf.getLineAndCharacterOfPosition(node.getStart(this.sf));
    const e = this.sf.getLineAndCharacterOfPosition(node.getEnd());
    return { line: s.line + 1, col: s.character + 1, endLine: e.line + 1, endCol: e.character + 1 };
  }

  private mk<T extends A.NodeBase>(node: ts.Node, fields: Omit<T, 'id' | 'span'>): T {
    return { id: '', ...fields, span: this.span(node) } as T;
  }

  module(): A.Module {
    let result: A.Module | null = null;
    for (const st of this.sf.statements) {
      if (ts.isImportDeclaration(st)) {
        const spec = (st.moduleSpecifier as ts.StringLiteral).text;
        if (spec !== EMBED_MODULE) this.fail(st, `an embedded module imports only ${EMBED_MODULE}, not ${spec}`);
        const named = st.importClause?.namedBindings;
        if (!named || !ts.isNamedImports(named) || st.importClause?.name) this.fail(st, `import the combinators by name: import { … } from '${EMBED_MODULE}'`);
        for (const el of named.elements) this.names.set(el.name.text, (el.propertyName ?? el.name).text);
        continue;
      }
      if (ts.isExportAssignment(st) && !st.isExportEquals && !result) {
        const c = this.call(st.expression, 'module');
        const [name, decls] = this.argsOf(c, 2, 2);
        result = this.mk<A.Module>(st, { kind: 'Module', name: this.str(name), decls: this.arr(decls).map((d) => this.decl(d)) });
        continue;
      }
      this.fail(st, 'an embedded module is its imports and one export default module(…) (PT2.5)');
    }
    if (!result) this.fail(this.sf, 'an embedded module has an export default module(…) (PT2.5)');
    return result;
  }

  // ── helpers ──────────────────────────────────────────────────────────────
  private combinator(node: ts.Expression): string | null {
    return ts.isIdentifier(node) ? this.names.get(node.text) ?? null : null;
  }

  private call(node: ts.Expression, ...want: string[]): { name: string; node: ts.CallExpression } {
    const n = this.unparen(node);
    if (!ts.isCallExpression(n)) this.fail(n, `expected ${want.join(' or ')}(…)`);
    const name = this.combinator(n.expression);
    if (!name) this.fail(n.expression, 'a call to anything but a poly combinator is outside the embedded subset');
    if (want.length && !want.includes(name)) this.fail(n, `expected ${want.join(' or ')}(…), found ${name}(…)`);
    return { name, node: n };
  }

  private argsOf(c: { name: string; node: ts.CallExpression }, min: number, max: number): ts.Expression[] {
    const a = [...c.node.arguments];
    if (a.length < min || a.length > max) this.fail(c.node, `${c.name} takes ${min === max ? min : `${min} to ${max}`} arguments`);
    for (const x of a) if (ts.isSpreadElement(x)) this.fail(x, 'a spread is outside the embedded subset');
    return a;
  }

  private unparen(node: ts.Expression): ts.Expression {
    let n = node;
    while (ts.isParenthesizedExpression(n)) n = n.expression;
    return n;
  }

  private str(node: ts.Expression): string {
    const n = this.unparen(node);
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    this.fail(n, 'expected a string literal');
  }

  private int(node: ts.Expression): number {
    const n = this.unparen(node);
    if (ts.isNumericLiteral(n)) return this.integer(n, Number(n.text));
    if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(n.operand)) return this.integer(n, -Number(n.operand.text));
    this.fail(n, 'expected an integer literal');
  }

  private integer(node: ts.Node, v: number): number {
    // As the standalone lexer reads them: decimal digits only, so `1e3` and `0x10` are not ints here.
    if (ts.isNumericLiteral(node) && !/^\d+$/.test(node.getText(this.sf))) this.fail(node, 'an integer is written in decimal digits');
    if (!Number.isSafeInteger(v)) this.fail(node, 'poly numbers are safe integers');
    return v;
  }

  private arr(node: ts.Expression): ts.Expression[] {
    const n = this.unparen(node);
    if (!ts.isArrayLiteralExpression(n)) this.fail(n, 'expected an array literal');
    for (const x of n.elements) if (ts.isSpreadElement(x) || ts.isOmittedExpression(x)) this.fail(x, 'a spread or a hole is outside the embedded subset');
    return [...n.elements];
  }

  /** PT6.5, S455: a target, a string or `{ exact: '<url>' }`, the embedded form of `exact "<url>"`. */
  private target(node: ts.Expression): A.TargetValue {
    if (!ts.isObjectLiteralExpression(this.unparen(node))) return this.str(node);
    const entries = this.obj(node);
    if (entries.length !== 1 || entries[0][0] !== 'exact') this.fail(node, "a target is a string or { exact: '<url>' } (S455)");
    return { exact: this.str(entries[0][1]) };
  }

  /** An object literal as [key, value, key node] entries, in order; only plain `key: value`. */
  private obj(node: ts.Expression): [string, ts.Expression, ts.PropertyName][] {
    const n = this.unparen(node);
    if (!ts.isObjectLiteralExpression(n)) this.fail(n, 'expected an object literal');
    return n.properties.map((p) => {
      if (!ts.isPropertyAssignment(p)) this.fail(p, 'only `key: value` entries are in the embedded subset');
      if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name)) return [p.name.text, p.initializer, p.name];
      this.fail(p.name, 'expected a name or a string as the key');
    });
  }

  private opts(node: ts.Expression | undefined, allowed: string[]): Map<string, ts.Expression> {
    const out = new Map<string, ts.Expression>();
    if (!node) return out;
    for (const [k, v, kn] of this.obj(node)) {
      if (!allowed.includes(k)) this.fail(kn, `${k} is not an option here; the options are ${allowed.join(', ')}`);
      out.set(k, v);
    }
    return out;
  }

  /** An arrow `($) => e` or `() => e`: its body, read with its parameter as the scope of names. */
  private arrow<T>(node: ts.Expression, read: (body: ts.Expression) => T): T {
    const n = this.unparen(node);
    if (!ts.isArrowFunction(n)) this.fail(n, 'expected an arrow ($) => …');
    if (n.parameters.length > 1) this.fail(n, 'an arrow takes one parameter, $');
    const p = n.parameters[0];
    if (p && (!ts.isIdentifier(p.name) || p.initializer || p.dotDotDotToken || p.type)) this.fail(p, 'the parameter of an arrow is a plain name, $');
    if (ts.isBlock(n.body)) this.fail(n.body, 'an arrow returns an expression, not a block');
    this.params.push(p ? (p.name as ts.Identifier).text : '');
    try { return read(n.body); } finally { this.params.pop(); }
  }

  // ── declarations ─────────────────────────────────────────────────────────
  private decl(node: ts.Expression): A.Decl {
    const c = this.call(node, 'enumType', 'union', 'record', 'claims', 'use', 'machine', 'configuration', 'workflow', 'channel', 'credential', 'audience', 'source', 'route', 'budget');
    switch (c.name) {
      case 'enumType': {
        const [name, members] = this.argsOf(c, 2, 2);
        return this.mk<A.EnumDecl>(c.node, { kind: 'EnumDecl', name: this.str(name), members: this.arr(members).map((m) => this.str(m)) });
      }
      case 'union': {
        const [name, ctors] = this.argsOf(c, 2, 2);
        return this.mk<A.TypeDecl>(c.node, { kind: 'TypeDecl', name: this.str(name), ctors: this.obj(ctors).map(([k, v, kn]) => this.mk<A.Ctor>(kn, { kind: 'Ctor', name: k, fields: this.payload(v) })) });
      }
      case 'record':
      case 'claims': {
        const [name, fields] = this.argsOf(c, 2, 2);
        return this.mk<A.RecordDecl>(c.node, { kind: 'RecordDecl', name: this.str(name), fields: this.payload(fields), ...(c.name === 'claims' ? { claims: true as const } : {}) });
      }
      case 'use': {
        const [path] = this.argsOf(c, 1, 1);
        return this.mk<A.UseDecl>(c.node, { kind: 'Use', path: this.str(path).split('.') });
      }
      case 'machine': return this.machine(c);
      case 'workflow': return this.workflow(c);
      case 'channel': {
        // PT21.1, S186: channel(name, { kind, adapter?, thread, starts?, onInbound?, peer: { P: 'A.X' } }).
        const [name, body] = this.argsOf(c, 2, 2);
        const o = this.opts(body, ['kind', 'adapter', 'thread', 'starts', 'onInbound', 'peer', 'audience', 'principal']);
        const dotted = (node: ts.Expression) => { const s = this.str(node); const i = s.indexOf('.'); if (i < 1) this.fail(node, 'expected Machine.Action'); return [s.slice(0, i), s.slice(i + 1)]; };
        const onIn = o.get('onInbound');
        const st = o.get('starts');
        const starts = st ? { machine: dotted(st)[0], action: dotted(st)[1], onInbound: !!onIn && this.unparen(onIn).kind === ts.SyntaxKind.TrueKeyword } : null;
        const maps = this.obj(o.get('peer')!).map(([peer, v, kn]) => { const [machine, action] = dotted(v); return this.mk<A.ChannelMap>(kn, { kind: 'ChannelMap', peer, machine, action }); });
        return this.mk<A.Channel>(c.node, { kind: 'Channel', name: this.str(name), channelKind: this.str(o.get('kind')!), adapter: o.has('adapter') ? this.str(o.get('adapter')!) : null, thread: this.str(o.get('thread')!), starts, maps, ...(o.has('audience') ? { audience: this.str(o.get('audience')!) } : {}), ...(o.has('principal') ? { principalFrom: this.str(o.get('principal')!) } : {}) });
      }
      case 'credential': {
        // PT10e: credential(name, { kind, provider, grant, pkce?, scopes, holder? }).
        const [name, body] = this.argsOf(c, 2, 2);
        const o = this.opts(body, ['kind', 'provider', 'grant', 'pkce', 'scopes', 'holder']);
        if (!o.has('kind') || !o.has('provider') || !o.has('grant') || !o.has('scopes')) this.fail(body, 'a credential names its kind, provider, grant and scopes (PT10e)');
        const grant = this.str(o.get('grant')!);
        if (grant !== 'authorization_code' && grant !== 'client_credentials') this.fail(o.get('grant')!, 'expected authorization_code or client_credentials');
        const pk = o.get('pkce');
        const pkce = !!pk && this.unparen(pk).kind === ts.SyntaxKind.TrueKeyword;
        if (pk && !pkce) this.fail(pk, 'pkce is written true, or left out');
        if (pkce && grant !== 'authorization_code') this.fail(pk!, 'pkce goes with authorization_code (PT10e)');
        return this.mk<A.Credential>(c.node, { kind: 'Credential', name: this.str(name), credKind: this.str(o.get('kind')!), provider: this.str(o.get('provider')!), grant, pkce, scopes: this.arr(o.get('scopes')!).map((s) => this.str(s)), holder: o.has('holder') ? this.str(o.get('holder')!) : null });
      }
      case 'audience': {
        // PS1.4b: audience([a1, a2, …]), the lowest first.
        const [classes] = this.argsOf(c, 1, 1);
        return this.mk<A.AudienceDecl>(c.node, { kind: 'Audience', classes: this.arr(classes).map((s) => this.str(s)) });
      }
      case 'source': {
        // PS17.0: source(name, { kind, adapter?, audience, owned?, freshness?, stale?, keys? }), keys ['k', …] (S451).
        const [name, body] = this.argsOf(c, 2, 2);
        const o = this.opts(body, ['kind', 'adapter', 'audience', 'owned', 'freshness', 'stale', 'keys']);
        if (!o.has('kind') || !o.has('audience')) this.fail(body, 'a source names its kind and audience (PS17.0)');
        const ow = o.get('owned');
        const owned = !!ow && this.unparen(ow).kind === ts.SyntaxKind.TrueKeyword;
        if (ow && !owned) this.fail(ow, 'owned is written true, or left out');
        const stale = o.has('stale') ? this.str(o.get('stale')!) : 'escalate';
        if (stale !== 'escalate' && stale !== 'deny') this.fail(o.get('stale')!, 'expected escalate or deny');
        const keys = o.has('keys') ? this.arr(o.get('keys')!).map((k) => this.str(k)) : null;
        if (keys && !keys.length) this.fail(o.get('keys')!, 'keys names at least one key, or is left out (PS17.0)');
        if (keys) for (const [i, k] of keys.entries()) { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) this.fail(o.get('keys')!, `the key ${JSON.stringify(k)} is not an identifier`); if (keys.indexOf(k) !== i) this.fail(o.get('keys')!, `a source names its key ${k} once`); }
        return this.mk<A.SourceDecl>(c.node, { kind: 'Source', name: this.str(name), sourceKind: this.str(o.get('kind')!), adapter: o.has('adapter') ? this.str(o.get('adapter')!) : null, audience: this.str(o.get('audience')!), owned, freshness: o.has('freshness') ? this.str(o.get('freshness')!) : null, stale, ...(keys ? { keys } : {}) });
      }
      case 'route': {
        // PT10r: route(name, { tiers: [{ name, provider, prices, calibration?, maxTokens }], escalate: [['conf', 0.8], ['failed']], budget? }).
        const [name, body] = this.argsOf(c, 2, 2);
        const o = this.opts(body, ['tiers', 'escalate', 'budget']);
        if (!o.has('tiers') || !o.has('escalate')) this.fail(body, 'a route names its tiers and when it escalates (PT10r)');
        const tiers = this.arr(o.get('tiers')!).map((t) => {
          const to = this.opts(t, ['name', 'provider', 'prices', 'calibration', 'maxInputTokens', 'maxTokens']);
          if (!to.has('name') || !to.has('provider') || !to.has('prices') || !to.has('maxInputTokens') || !to.has('maxTokens')) this.fail(t, 'a tier names its name, provider, prices, maxInputTokens and maxTokens (PT10r, S360)');
          return this.mk<A.RouteTier>(t, { kind: 'RouteTier', name: this.str(to.get('name')!), provider: this.str(to.get('provider')!), prices: this.str(to.get('prices')!), calibration: to.has('calibration') ? this.str(to.get('calibration')!) : null, maxInputTokens: this.int(to.get('maxInputTokens')!), maxTokens: this.int(to.get('maxTokens')!) });
        });
        const escalate = this.arr(o.get('escalate')!).map((e): A.RouteTerm => {
          const parts = this.arr(e);
          const on = parts.length ? this.str(parts[0]) : '';
          if (on === 'failed' && parts.length === 1) return { on: 'failed' };
          if ((on === 'conf' || on === 'margin') && parts.length === 2) return { on, below: this.decimal(parts[1]) };
          this.fail(e, "expected ['conf', c], ['margin', c] or ['failed']");
        });
        return this.mk<A.Route>(c.node, { kind: 'Route', name: this.str(name), tiers, escalate, budget: o.has('budget') ? this.str(o.get('budget')!) : null });
      }
      case 'budget': {
        // PT10r: budget(name, { caps: [{ currency, amount, per, scope? }], onExhausted? }), the amount a decimal as written.
        const [name, body] = this.argsOf(c, 2, 2);
        const o = this.opts(body, ['caps', 'onExhausted']);
        if (!o.has('caps')) this.fail(body, 'a budget names its caps (PT10r)');
        const caps = this.arr(o.get('caps')!).map((x) => {
          const co = this.opts(x, ['currency', 'amount', 'per', 'scope']);
          if (!co.has('currency') || !co.has('amount') || !co.has('per')) this.fail(x, 'a cap names its currency, amount and per (PT10r)');
          const per = this.str(co.get('per')!);
          if (!['run', 'scope', 'hour', 'day', 'month'].includes(per)) this.fail(co.get('per')!, 'expected run, scope, hour, day or month');
          const sc = co.get('scope');
          const scope = !!sc && this.unparen(sc).kind === ts.SyntaxKind.TrueKeyword;
          if (sc && (!scope || !['hour', 'day', 'month'].includes(per))) this.fail(sc, 'scope: true goes with a period (hour, day or month), or is left out');
          return this.mk<A.BudgetCap>(x, { kind: 'BudgetCap', currency: this.str(co.get('currency')!), amount: this.amount(co.get('amount')!), run: per === 'run', period: per === 'hour' || per === 'day' || per === 'month' ? per : null, scope: per === 'scope' || scope });
        });
        const ex = o.has('onExhausted') ? this.str(o.get('onExhausted')!) : 'deny';
        if (ex !== 'deny' && ex !== 'escalate') this.fail(o.get('onExhausted')!, 'expected deny or escalate');
        return this.mk<A.Budget>(c.node, { kind: 'Budget', name: this.str(name), caps, onExhausted: ex });
      }
      default: return this.configuration(c);
    }
  }

  /** PS18.3: an amount as written, `0.50` or `20`, in micro-units; at most three places, as the standalone lexer reads it. */
  private amount(node: ts.Expression): number {
    const n = this.unparen(node);
    const raw = ts.isNumericLiteral(n) ? n.getText(this.sf) : '';
    if (!/^\d+(\.\d{1,3})?$/.test(raw)) this.fail(n, 'expected an amount such as 0.50, with at most three digits after the point');
    const [w, f = ''] = raw.split('.');
    const v = Number(w) * 1_000_000 + Number(f.padEnd(6, '0'));
    if (!Number.isSafeInteger(v)) this.fail(n, `the amount ${raw} is out of range`);
    return v;
  }

  /** PT10: `workflow(name, { runs, input, key?: { template, where? }, tools: { kind: { tool, target?, why } } })`. */
  private workflow(c: { name: string; node: ts.CallExpression }): A.Workflow {
    const [name, body] = this.argsOf(c, 2, 2);
    const o = this.opts(body, ['runs', 'input', 'key', 'tools']);
    if (!o.has('runs') || !o.has('input') || !o.has('tools')) this.fail(body, 'a workflow names runs, input and tools (PT10)');
    let key: A.Workflow['key'] = null;
    if (o.has('key')) {
      const k = this.opts(o.get('key')!, ['template', 'where']);
      if (!k.has('template')) this.fail(o.get('key')!, 'a key names its template (PT10)');
      const fields = k.has('where') ? this.obj(k.get('where')!).map(([f, v, kn]) => this.mk<A.WorkflowKeyField>(kn, { kind: 'WorkflowKeyField', name: f, pattern: this.str(v) })) : [];
      key = this.mk<A.WorkflowKey>(o.get('key')!, { kind: 'WorkflowKey', template: this.str(k.get('template')!), fields });
    }
    const tools = this.obj(o.get('tools')!).map(([effect, v, kn]) => {
      const t = this.opts(v, ['tool', 'target', 'why']);
      if (!t.has('tool') || !t.has('why')) this.fail(v, 'a tool names tool and why (PT10)');
      return this.mk<A.WorkflowTool>(kn, { kind: 'WorkflowTool', effect, tool: this.str(t.get('tool')!), target: t.has('target') ? this.str(t.get('target')!) : null, why: this.str(t.get('why')!) });
    });
    return this.mk<A.Workflow>(c.node, { kind: 'Workflow', name: this.str(name), machine: this.str(o.get('runs')!), input: this.str(o.get('input')!), key, tools });
  }

  private payload(node: ts.Expression): A.PayloadField[] {
    return this.obj(node).map(([k, v, kn]) => this.mk<A.PayloadField>(kn, { kind: 'PayloadField', name: k, type: this.type(v) }));
  }

  private type(node: ts.Expression): A.TypeExpr {
    const n = this.unparen(node);
    if (ts.isPropertyAccessExpression(n) && this.combinator(n.expression) === 't') {
      const w = n.name.text;
      if (w === 'bool') return this.mk<A.TBool>(n, { kind: 'TBool' });
      if (w === 'int') return this.mk<A.TInt>(n, { kind: 'TInt' });
      if (w === 'string') return this.mk<A.TString>(n, { kind: 'TString' });
      if (w === 'conf') return this.mk<A.TConf>(n, { kind: 'TConf' });
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && this.combinator(n.expression.expression) === 't') {
      const w = n.expression.name.text;
      const a = [...n.arguments];
      if (w === 'range' && a.length === 2) return this.mk<A.TRange>(n, { kind: 'TRange', lo: this.int(a[0]), hi: this.int(a[1]) });
      if (w === 'named' && a.length === 1) return this.mk<A.TName>(n, { kind: 'TName', name: this.str(a[0]) });
      if (w === 'ref' && a.length === 1) return this.mk<A.TRef>(n, { kind: 'TRef', machine: this.str(a[0]).split('.') });
      if (w === 'map' && a.length === 2) {
        const key = this.type(a[0]);
        if (key.kind !== 'TName' && key.kind !== 'TRange') this.fail(a[0], 'a map key is an enum or a range 0..n (PT3.1)');
        return this.mk<A.TMap>(n, { kind: 'TMap', key, value: this.type(a[1]) });
      }
    }
    this.fail(n, 'expected a type: t.bool, t.int, t.string, t.range(lo, hi), t.named(N), t.map(K, V) or t.ref(M)');
  }

  private literal(node: ts.Expression): A.Literal {
    const n = this.unparen(node);
    if (ts.isStringLiteral(n)) return this.mk<A.StringLit>(n, { kind: 'String', value: n.text });
    if (n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword) return this.mk<A.BoolLit>(n, { kind: 'Bool', value: n.kind === ts.SyntaxKind.TrueKeyword });
    if (ts.isCallExpression(n) && this.combinator(n.expression) === 'name' && n.arguments.length === 1) return this.mk<A.NameRef>(n, { kind: 'Name', name: this.str(n.arguments[0]) });
    return this.mk<A.IntLit>(n, { kind: 'Int', value: this.int(n) });
  }

  /** A check clause: `[v, …]` or `{ lo, hi }` for a field, `.check([…], mode?)` or `.check(lo, hi, mode?)` for a parameter. */
  private domain(node: ts.Expression): A.Domain {
    const n = this.unparen(node);
    if (ts.isArrayLiteralExpression(n)) return this.mk<A.DomainSet>(n, { kind: 'DomainSet', values: this.arr(n).map((v) => this.literal(v)) });
    const o = this.opts(n, ['lo', 'hi']);
    if (!o.has('lo') || !o.has('hi')) this.fail(n, 'a range domain is { lo, hi }');
    return this.mk<A.DomainRange>(n, { kind: 'DomainRange', lo: this.int(o.get('lo')!), hi: this.int(o.get('hi')!) });
  }

  private mode(node: ts.Expression | undefined): A.CheckMode | null {
    if (!node) return null;
    const m = this.str(node);
    if (m !== 'strict' && m !== 'disclosed') this.fail(node, 'a check mode is strict or disclosed');
    return m;
  }

  private param(k: string, v: ts.Expression, kn: ts.Node): A.Param {
    const n = this.unparen(v);
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'check') {
      const type = this.type(n.expression.expression);
      const a = [...n.arguments];
      const set = a.length > 0 && ts.isArrayLiteralExpression(this.unparen(a[0]));
      const domain: A.Domain = set ? this.domain(a[0]) : this.mk<A.DomainRange>(n, { kind: 'DomainRange', lo: this.int(a[0]), hi: this.int(a[1]) });
      const mode = this.mode(set ? a[1] : a[2]);
      if (a.length > (set ? 2 : 3)) this.fail(n, 'check takes a domain and a mode');
      return this.mk<A.Param>(kn, { kind: 'Param', name: k, type, check: this.mk<A.CheckClause>(n, { kind: 'Check', domain, mode }) });
    }
    return this.mk<A.Param>(kn, { kind: 'Param', name: k, type: this.type(v), check: null });
  }

  private paramList(node: ts.Expression): A.Param[] {
    return this.obj(node).map(([k, v, kn]) => this.param(k, v, kn));
  }

  // ── machines ─────────────────────────────────────────────────────────────
  private machine(c: { name: string; node: ts.CallExpression }): A.Machine {
    const [name, body] = this.argsOf(c, 2, 2);
    const o = this.opts(body, ['service', 'version', 'state', 'items']);
    const service = o.has('service') ? this.bool(o.get('service')!) : false;
    const fields = o.has('state') ? this.obj(o.get('state')!).map(([k, v, kn]) => this.field(k, v, kn)) : [];
    const items = o.has('items') ? this.arr(o.get('items')!).map((i) => this.item(i)) : [];
    return this.mk<A.Machine>(c.node, { kind: 'Machine', name: this.str(name), service, version: o.has('version') ? this.int(o.get('version')!) : null, fields, items });
  }

  private bool(node: ts.Expression): boolean {
    const n = this.unparen(node);
    if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
    this.fail(n, 'expected true or false');
  }

  private field(k: string, v: ts.Expression, kn: ts.Node): A.Field {
    const c = this.call(v, 'field');
    const [type, init, opts] = this.argsOf(c, 2, 3);
    const o = this.opts(opts, ['check', 'mode', 'flag']);
    const check = o.has('check') ? this.mk<A.CheckClause>(o.get('check')!, { kind: 'Check', domain: this.domain(o.get('check')!), mode: this.mode(o.get('mode')) }) : null;
    if (!check && o.has('mode')) this.fail(o.get('mode')!, 'a mode belongs to a check');
    let flag: A.Field['flag'] = null;
    if (o.has('flag')) {
      const f = this.str(o.get('flag')!);
      if (f !== 'internal' && f !== 'derived') this.fail(o.get('flag')!, 'a flag is internal or derived');
      flag = f;
    }
    return this.mk<A.Field>(kn, { kind: 'Field', name: k, type: this.type(type), check, init: this.arrow(init, (b) => this.expr(b)), flag });
  }

  private item(node: ts.Expression): A.MachineItem {
    const c = this.call(node, 'terminal', 'action', 'on', 'guard', 'invariant', 'stepProperty', 'rejectProperty', 'pathProperty', 'composeInvariant', 'liveness', 'never', 'effect', 'decision');
    switch (c.name) {
      case 'terminal': {
        const [e] = this.argsOf(c, 1, 1);
        return this.mk<A.Terminal>(c.node, { kind: 'Terminal', expr: this.arrow(e, (b) => this.expr(b)) });
      }
      case 'action': {
        const [name, params] = this.argsOf(c, 2, 2);
        return this.mk<A.Action>(c.node, { kind: 'Action', name: this.str(name), params: this.paramList(params) });
      }
      case 'on': {
        const [action, body, params, opts] = this.argsOf(c, 2, 4);
        const none = !params || this.unparen(params).kind === ts.SyntaxKind.NullKeyword;
        // PD5.1.2: `{ by: ['c', 'C'] }` is `by c: C`.
        let by: A.Handler['by'];
        for (const [k, v] of opts ? this.obj(opts) : []) {
          if (k !== 'by') throw new Outside(v, `on(…) takes the option by, not ${k}`);
          const [bn, bt] = this.arr(v);
          by = { name: this.str(bn), type: this.str(bt) };
        }
        return this.mk<A.Handler>(c.node, { kind: 'Handler', action: this.str(action), params: none ? null : this.arr(params).map((p) => this.str(p)), ...(by ? { by } : {}), body: this.arrow(body, (b) => this.stmts(b)) });
      }
      case 'guard': {
        const [cond, reason] = this.argsOf(c, 2, 2);
        return this.mk<A.Guard>(c.node, { kind: 'Guard', cond: this.arrow(cond, (b) => this.expr(b)), reason: this.str(reason) });
      }
      case 'liveness': return this.liveness(c);
      // PS5.2a, S178: never(name, effect, ($) => ({ f: v }), ($) => P?).
      case 'never': {
        const [name, effect, fields, cond] = this.argsOf(c, 3, 4);
        return this.mk<A.NeverEmit>(c.node, { kind: 'NeverEmit', name: this.str(name), effect: this.str(effect), fields: this.arrow(fields, (b) => this.emitsFields(b)), cond: cond ? this.arrow(cond, (b) => this.expr(b)) : null });
      }
      case 'decision': {
        const [name, params, result, items] = this.argsOf(c, 4, 4);
        return this.mk<A.Decision>(c.node, { kind: 'Decision', name: this.str(name), params: this.paramList(params), result: this.type(result), items: this.arr(items).map((i) => this.decisionItem(i)) });
      }
      case 'effect': {
        const [name, params, items] = this.argsOf(c, 3, 3);
        return this.mk<A.EffectDecl>(c.node, { kind: 'EffectDecl', name: this.str(name), params: this.paramList(params), items: this.arr(items).map((i) => this.effItem(i)) });
      }
      default: return this.property(c);
    }
  }

  /** PS5.2: a field filter `{ f: v, … }`, each value an expression. */
  private emitsFields(node: ts.Expression): A.EmitsField[] {
    return this.obj(node).map(([k, v, kn]) => this.mk<A.EmitsField>(kn, { kind: 'EmitsField', name: k, value: this.expr(v) }));
  }

  private property(c: { name: string; node: ts.CallExpression }): A.Property {
    const form = ({ invariant: 'invariant', stepProperty: 'step', rejectProperty: 'reject', pathProperty: 'path', composeInvariant: 'compose' } as const)[c.name as 'invariant'];
    if (!form) this.fail(c.node, `expected a property, found ${c.name}(…)`);
    const [name, e] = this.argsOf(c, 2, 2);
    return this.mk<A.Property>(c.node, { kind: 'Property', form, name: this.str(name), expr: this.arrow(e, (b) => this.expr(b)) });
  }

  private liveness(c: { name: string; node: ts.CallExpression }): A.Liveness {
    const [name, goal, opts] = this.argsOf(c, 2, 3);
    const g = this.opts(goal, ['eventually', 'from', 'to']);
    let from: A.Expr | null = null;
    let expr: A.Expr;
    if (g.has('eventually') && !g.has('from') && !g.has('to')) expr = this.arrow(g.get('eventually')!, (b) => this.expr(b));
    else if (g.has('from') && g.has('to') && !g.has('eventually')) { from = this.arrow(g.get('from')!, (b) => this.expr(b)); expr = this.arrow(g.get('to')!, (b) => this.expr(b)); }
    else this.fail(goal, 'a liveness goal is { eventually } or { from, to }');
    const o = this.opts(opts, ['forall', 'exists', 'fair']);
    let quant: A.Liveness['quant'] = null;
    for (const q of ['forall', 'exists'] as const) {
      if (!o.has(q)) continue;
      if (quant) this.fail(o.get(q)!, 'one quantifier');
      const [v, grp] = this.arr(o.get(q)!).map((x) => this.str(x));
      quant = { q, var: v, group: grp };
    }
    const fair = o.has('fair') ? this.arr(o.get('fair')!).map((grp) => this.mk<A.FairGroup>(grp, { kind: 'FairGroup', members: this.arr(grp).map((m) => this.fairMember(m)) })) : null;
    return this.mk<A.Liveness>(c.node, { kind: 'Liveness', name: this.str(name), from, expr, fair, quant });
  }

  private fairMember(node: ts.Expression): A.FairGroup['members'][number] {
    const m = FAIR.exec(this.str(node));
    if (!m) this.fail(node, "a fair member is 'A', 'A(*)', or an input such as 'g[*].A'");
    const action = m[3];
    const perValue = m[4] !== undefined;
    if (m[1] === undefined) return { action, perValue };
    return { action, perValue, input: { instance: m[1], index: m[2] === undefined ? null : m[2] === '*' ? '*' : Number(m[2]) } };
  }

  /** A decimal literal (S76), in thousandths. */
  private decimal(node: ts.Expression): number {
    const n = this.unparen(node);
    // The source text, not TypeScript's normalised value: `1.0` is the decimal 1.0, not the int 1 (review A1).
    const raw = ts.isNumericLiteral(n) ? n.getText(this.sf) : '';
    if (!/^\d+\.\d{1,3}$/.test(raw)) this.fail(n, 'expected a decimal such as 0.3, with at most three digits after the point');
    const [w, f] = raw.split('.');
    return Number(w) * 1000 + Number(f.padEnd(3, '0'));
  }

  private decisionItem(node: ts.Expression): A.DecisionItem {
    const c = this.call(node, 'provider', 'route', 'labels', 'timeout', 'band', 'cites', 'ok', 'okWith', 'failed', 'exhausted');
    const mk = (fields: Record<string, unknown>) => ({ id: '', ...fields, span: this.span(c.node) }) as unknown as A.DecisionItem;
    if (c.name === 'provider') return mk({ kind: 'DecProvider', value: this.str(this.argsOf(c, 1, 1)[0]) });
    if (c.name === 'timeout') return mk({ kind: 'DecTimeout', value: this.str(this.argsOf(c, 1, 1)[0]) });
    if (c.name === 'route') return mk({ kind: 'DecRoute', route: this.str(this.argsOf(c, 1, 1)[0]) });
    if (c.name === 'band') { const [lo, hi] = this.argsOf(c, 2, 2); return mk({ kind: 'DecBand', lo: this.decimal(lo), hi: this.decimal(hi) }); }
    // PS17.6: cites(param).
    if (c.name === 'cites') return mk({ kind: 'DecCites', param: this.str(this.argsOf(c, 1, 1)[0]) });
    return this.effItem(node) as A.DecisionItem;
  }

  private effItem(node: ts.Expression): A.EffectItem {
    const c = this.call(node, 'kind', 'labels', 'targets', 'uses', 'retrieve', 'remember', 'to', 'audience', 'cls', 'retry', 'ok', 'okWith', 'failed', 'exhausted');
    const mk = (fields: Record<string, unknown>) => ({ id: '', ...fields, span: this.span(c.node) }) as unknown as A.EffectItem;
    switch (c.name) {
      case 'kind': return mk({ kind: 'EffKind', value: this.str(this.argsOf(c, 1, 1)[0]) });
      case 'labels': return mk({ kind: 'EffLabels', labels: this.arr(this.argsOf(c, 1, 1)[0]).map((l) => this.str(l)) });
      case 'cls': return mk({ kind: 'EffClass', value: this.str(this.argsOf(c, 1, 1)[0]) });
      case 'targets': return mk({ kind: 'EffTargets', targets: this.arr(this.argsOf(c, 1, 1)[0]).map((p) => { const [k, v] = this.arr(p); return { key: this.str(k), values: this.arr(v).map((s) => this.target(s)) }; }) });
      case 'uses': {
        // PT10e: uses(credential, [scopes], holder?).
        const [cred, scopes, holder] = this.argsOf(c, 2, 3);
        return mk({ kind: 'EffUses', credential: this.str(cred), scopes: this.arr(scopes).map((s) => this.str(s)), holder: holder ? this.str(holder) : null });
      }
      case 'retrieve': {
        // PS17.2: retrieve(source, { owner?, key?, limit }), key ['k', 'x'] for `k == x` (S451).
        const [src, body] = this.argsOf(c, 2, 2);
        const o = this.opts(body, ['owner', 'key', 'limit']);
        if (!o.has('limit')) this.fail(body, 'a retrieval names its limit (PS17.2)');
        const kv = o.has('key') ? this.arr(o.get('key')!).map((x) => this.str(x)) : null;
        if (kv && kv.length !== 2) this.fail(o.get('key')!, "a key predicate is written ['k', 'x'], the key and its Key parameter (PS17.2)");
        return mk({ kind: 'EffRetrieve', source: this.str(src), owner: o.has('owner') ? this.str(o.get('owner')!) : null, limit: this.int(o.get('limit')!), ...(kv ? { key: { name: kv[0], param: kv[1] } } : {}) });
      }
      case 'remember': {
        // PS17.5: remember(source, provenance, about).
        const [src, prov, about] = this.argsOf(c, 3, 3);
        const provenance = this.str(prov);
        if (provenance !== 'observed' && provenance !== 'derived' && provenance !== 'verified') this.fail(prov, 'expected observed, derived or verified');
        return mk({ kind: 'EffRemember', source: this.str(src), provenance, about: this.str(about) });
      }
      // PS17.3: to(param) and audience(class), an effect's recipient.
      case 'to': return mk({ kind: 'EffTo', param: this.str(this.argsOf(c, 1, 1)[0]) });
      case 'audience': return mk({ kind: 'EffAudience', cls: this.str(this.argsOf(c, 1, 1)[0]) });
      case 'retry': {
        const [n, base, timeout] = this.argsOf(c, 3, 3);
        return mk({ kind: 'EffRetry', attempts: this.int(n), base: this.str(base), timeout: this.str(timeout) });
      }
      default: {
        // `okWith('r', 'A', args)` is `ok(r) -> A(args)` (PD1.2b, S79).
        const bound = c.name === 'okWith';
        const a = this.argsOf(c, bound ? 3 : 2, bound ? 3 : 2);
        const [action, args] = bound ? a.slice(1) : a;
        // The arguments, or an arrow that gives them `$` (PT2.5, plan-m2 appendix).
        const read = ts.isArrowFunction(this.unparen(args)) ? this.arrow(args, (b) => this.args(b)) : this.args(args);
        return mk({ kind: 'EffOutcome', outcome: bound ? 'ok' : c.name, action: this.str(action), args: read, ...(bound ? { bind: this.str(a[0]) } : {}) });
      }
    }
  }

  // ── configurations ───────────────────────────────────────────────────────
  private configuration(c: { name: string; node: ts.CallExpression }): A.Configuration {
    const [name, body] = this.argsOf(c, 2, 2);
    const o = this.opts(body, ['instances', 'inputs', 'bounds', 'properties']);
    const instances = o.has('instances') ? this.arr(o.get('instances')!).map((i) => this.instance(i)) : [];
    const inputs = o.has('inputs') ? this.arr(o.get('inputs')!).map((r) => {
      const m = INPUT.exec(this.str(r));
      if (!m) this.fail(r, "an input is 'x.A', 'g[k].A' or 'g[*].A' (S31)");
      return this.mk<A.InputRef>(r, { kind: 'InputRef', instance: m[1], index: m[2] === undefined ? null : m[2] === '*' ? '*' : Number(m[2]), action: m[3] });
    }) : [];
    let bounds: A.ConfigBounds | null = null;
    if (o.has('bounds')) {
      const b = this.opts(o.get('bounds')!, ['transit', 'instances']);
      if (!b.has('transit')) this.fail(o.get('bounds')!, 'bounds name transit (S62)');
      bounds = this.mk<A.ConfigBounds>(o.get('bounds')!, { kind: 'ConfigBounds', transit: this.int(b.get('transit')!), instances: b.has('instances') ? this.int(b.get('instances')!) : null });
    }
    const properties = o.has('properties') ? this.arr(o.get('properties')!).map((p) => {
      const pc = this.call(p, 'invariant', 'liveness');
      return pc.name === 'liveness' ? this.liveness(pc) : this.property(pc);
    }) : [];
    return this.mk<A.Configuration>(c.node, { kind: 'Configuration', name: this.str(name), instances, inputs, bounds, properties });
  }

  private instance(node: ts.Expression): A.ConfigInstance {
    const c = this.call(node, 'instance');
    const [name, machine, opts] = this.argsOf(c, 2, 3);
    const o = this.opts(opts, ['count', 'init', 'scope']);
    const init: A.ConfigInstance['init'] = o.has('init') ? this.arrow(o.get('init')!, (b) => this.obj(b).map(([k, v]) => ({ field: k, value: this.expr(v) }))) : [];
    return this.mk<A.ConfigInstance>(c.node, { kind: 'ConfigInstance', name: this.str(name), count: o.has('count') ? this.int(o.get('count')!) : null, machine: this.str(machine).split('.'), init, ...(o.has('scope') ? { scope: this.str(o.get('scope')!) } : {}) });
  }

  // ── statements ───────────────────────────────────────────────────────────
  private stmts(node: ts.Expression): A.Stmt[] {
    return this.arr(node).map((s) => this.stmt(s));
  }

  private stmt(node: ts.Expression): A.Stmt {
    const c = this.call(node, 'require', 'reject', 'let_', 'set', 'setEntry', 'when', 'match', 'forEach', 'emit', 'decide', 'adjudicate', 'after', 'cancel', 'spawn', 'send', 'signal');
    const n = c.node;
    switch (c.name) {
      case 'require': {
        const [cond, reason] = this.argsOf(c, 2, 2);
        return this.mk<A.Require>(n, { kind: 'Require', cond: this.expr(cond), reason: this.str(reason) });
      }
      case 'reject': return this.mk<A.Reject>(n, { kind: 'Reject', reason: this.str(this.argsOf(c, 1, 1)[0]) });
      case 'let_': {
        const [name, e] = this.argsOf(c, 2, 2);
        return this.mk<A.Let>(n, { kind: 'Let', name: this.str(name), expr: this.expr(e) });
      }
      case 'set': {
        const [field, e] = this.argsOf(c, 2, 2);
        return this.mk<A.Assign>(n, { kind: 'Assign', field: this.str(field), expr: this.expr(e) });
      }
      case 'setEntry': {
        const [field, key, value, base] = this.argsOf(c, 3, 4);
        const f = this.str(field);
        return this.mk<A.MapUpdate>(n, { kind: 'MapUpdate', field: f, base: base ? this.str(base) : f, key: this.expr(key), value: this.expr(value) });
      }
      case 'when': {
        const [cond, then, els] = this.argsOf(c, 2, 3);
        return this.mk<A.If>(n, { kind: 'If', cond: this.expr(cond), then: this.stmts(then), else: els ? this.stmts(els) : null });
      }
      case 'match': {
        const [scrutinee, arms] = this.argsOf(c, 2, 2);
        return this.mk<A.Match>(n, { kind: 'Match', scrutinee: this.expr(scrutinee), arms: this.arr(arms).map((a) => this.arm(a)) });
      }
      case 'forEach': {
        const [v, lo, hi, body] = this.argsOf(c, 4, 4);
        return this.mk<A.For>(n, { kind: 'For', var: this.str(v), lo: this.int(lo), hi: this.expr(hi), body: this.stmts(body) });
      }
      default: return this.intent(c);
    }
  }

  private arm(node: ts.Expression): A.Arm {
    const c = this.call(node, 'arm');
    const [p, body] = this.argsOf(c, 2, 2);
    return this.mk<A.Arm>(c.node, { kind: 'Arm', pattern: this.pattern(p), body: this.stmts(body) });
  }

  private pattern(node: ts.Expression): A.Pattern {
    const n = this.unparen(node);
    if (ts.isStringLiteral(n) && n.text === '_') return this.mk<A.PWild>(n, { kind: 'PWild' });
    const c = this.call(n, 'pattern');
    const [ctor, fields] = this.argsOf(c, 1, 2);
    const fs: A.PCtor['fields'] = fields ? this.obj(fields).map(([k, v]) => {
      const vn = this.unparen(v);
      if (ts.isCallExpression(vn) && this.combinator(vn.expression) === 'bind') return { name: k, bind: this.str(vn.arguments[0]), literal: null };
      return { name: k, bind: null, literal: this.literal(v) };
    }) : [];
    return this.mk<A.PCtor>(c.node, { kind: 'PCtor', ctor: this.str(ctor), fields: fs });
  }

  private args(node: ts.Expression): A.NamedArg[] {
    const n = this.unparen(node);
    if (ts.isObjectLiteralExpression(n)) return this.obj(n).map(([k, v]) => ({ name: k, value: this.expr(v) }));
    return this.arr(n).map((x) => {
      const xn = this.unparen(x);
      if (ts.isCallExpression(xn) && this.combinator(xn.expression) === 'named') return { name: this.str(xn.arguments[0]), value: this.expr(xn.arguments[1]) };
      return { name: null, value: this.expr(x) };
    });
  }

  private intent(c: { name: string; node: ts.CallExpression }): A.IntentStmt {
    const base: Omit<A.IntentStmt, 'id' | 'span'> = { kind: 'Intent', op: c.name as A.IntentStmt['op'], target: '', args: [], to: null, modifier: null, as: null, index: null, extra: [] };
    switch (c.name) {
      case 'emit':
      case 'decide': {
        const [k, args] = this.argsOf(c, 2, 2);
        base.target = this.str(k);
        base.args = this.args(args);
        break;
      }
      case 'adjudicate': {
        // PD2.4, S129: adjudicate('d', 'Correct' | 'Wrong').
        const [d, o] = this.argsOf(c, 2, 2);
        base.target = this.str(d);
        base.modifier = this.str(o);
        if (base.modifier !== 'Correct' && base.modifier !== 'Wrong') this.fail(o, 'an adjudication is Correct or Wrong');
        break;
      }
      case 'after': {
        const [d, a, args, key, i] = this.argsOf(c, 4, 5);
        base.modifier = this.str(d);
        base.target = this.str(a);
        base.args = this.args(args);
        base.as = this.str(key);
        base.index = i ? this.expr(i) : null;
        break;
      }
      case 'cancel': {
        const [key, i] = this.argsOf(c, 1, 2);
        base.target = this.str(key);
        base.index = i ? this.expr(i) : null;
        break;
      }
      case 'send': {
        const [to, a, args, as] = this.argsOf(c, 3, 4);
        base.to = this.expr(to);
        base.target = this.str(a);
        base.args = this.args(args);
        base.as = as ? this.str(as) : null;
        break;
      }
      case 'signal': {
        const [key, i, a, args] = this.argsOf(c, 4, 4);
        base.extra = [this.str(key)];
        base.index = this.unparen(i).kind === ts.SyntaxKind.NullKeyword ? null : this.expr(i);
        base.target = this.str(a);
        base.args = this.args(args);
        break;
      }
      case 'spawn': {
        const [m, key, opts] = this.argsOf(c, 2, 3);
        base.target = this.str(m);
        base.as = this.str(key);
        const o = this.opts(opts, ['index', 'detached', 'create', 'complete', 'parentTerminal']);
        if (o.has('detached')) {
          if (!this.bool(o.get('detached')!)) this.fail(o.get('detached')!, 'write detached: true, or leave it out');
          base.modifier = 'detached';
        }
        base.index = o.has('index') ? this.expr(o.get('index')!) : null;
        if (o.has('create')) {
          const [a, args] = this.arr(o.get('create')!);
          base.extra.push('create', this.str(a));
          base.args = this.args(args);
        }
        if (o.has('complete')) base.extra.push('complete', this.str(o.get('complete')!));
        if (o.has('parentTerminal')) {
          if (!o.has('complete')) this.fail(o.get('parentTerminal')!, 'on parent terminal follows on complete (PT2)');
          base.extra.push('parent-terminal', this.str(o.get('parentTerminal')!));
        }
        break;
      }
    }
    return this.mk<A.IntentStmt>(c.node, base);
  }

  // ── expressions (PT2.2) ──────────────────────────────────────────────────
  private isParam(node: ts.Expression): boolean {
    const p = this.params[this.params.length - 1];
    return ts.isIdentifier(node) && p !== undefined && p !== '' && node.text === p;
  }

  expr(node: ts.Expression): A.Expr {
    const n = this.unparen(node);
    if (ts.isNumericLiteral(n) && n.getText(this.sf).includes('.')) return this.mk<A.DecimalLit>(n, { kind: 'Decimal', value: this.decimal(n) });
    if (ts.isNumericLiteral(n)) return this.mk<A.IntLit>(n, { kind: 'Int', value: this.integer(n, Number(n.text)) });
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return this.mk<A.StringLit>(n, { kind: 'String', value: n.text });
    if (n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword) return this.mk<A.BoolLit>(n, { kind: 'Bool', value: n.kind === ts.SyntaxKind.TrueKeyword });
    if (ts.isPropertyAccessExpression(n)) {
      if (n.questionDotToken) this.fail(n, '?. is outside the embedded subset');
      if (this.isParam(n.expression)) return this.mk<A.NameRef>(n, { kind: 'Name', name: n.name.text });
      return this.mk<A.Member>(n, { kind: 'Member', object: this.expr(n.expression), prop: n.name.text });
    }
    if (ts.isElementAccessExpression(n)) {
      if (n.questionDotToken) this.fail(n, '?. is outside the embedded subset');
      if (this.isParam(n.expression)) return this.mk<A.NameRef>(n, { kind: 'Name', name: this.str(n.argumentExpression) });
      const idx = this.unparen(n.argumentExpression);
      const index = this.combinator(idx) === 'ALL' ? this.mk<A.Star>(idx, { kind: 'Star' }) : this.expr(idx);
      return this.mk<A.Index>(n, { kind: 'Index', object: this.expr(n.expression), index });
    }
    if (ts.isPrefixUnaryExpression(n)) {
      const op = n.operator === ts.SyntaxKind.ExclamationToken ? '!' : n.operator === ts.SyntaxKind.MinusToken ? '-' : null;
      if (!op) this.fail(n, 'only ! and - are unary operators here');
      return this.mk<A.Unary>(n, { kind: 'Unary', op, arg: this.operand(n.operand) });
    }
    if (ts.isBinaryExpression(n)) {
      const op = BINARY[n.operatorToken.kind];
      if (!op) this.fail(n.operatorToken, `${n.operatorToken.getText(this.sf)} is outside the embedded subset; equality is === and !==`);
      return this.mk<A.Binary>(n, { kind: 'Binary', op, left: this.operand(n.left), right: this.operand(n.right) });
    }
    if (ts.isObjectLiteralExpression(n)) {
      return this.mk<A.MapLit>(n, {
        kind: 'MapLit',
        entries: n.properties.map((p) => {
          if (!ts.isPropertyAssignment(p)) this.fail(p, 'only `key: value` entries are in the embedded subset');
          const k = p.name;
          const key: A.Expr = ts.isIdentifier(k) ? this.mk<A.NameRef>(k, { kind: 'Name', name: k.text })
            : ts.isNumericLiteral(k) ? this.mk<A.IntLit>(k, { kind: 'Int', value: this.integer(k, Number(k.text)) })
            : ts.isStringLiteral(k) ? this.mk<A.StringLit>(k, { kind: 'String', value: k.text })
            : ts.isComputedPropertyName(k) ? this.expr(k.expression)
            : this.fail(k, 'a key is a name, a number, a string or [e]');
          return { key, value: this.expr(p.initializer) };
        }),
      });
    }
    if (ts.isArrayLiteralExpression(n)) return this.mk<A.ArrayLit>(n, { kind: 'ArrayLit', items: this.arr(n).map((x) => this.expr(x)) });
    if (ts.isIdentifier(n)) {
      if (this.combinator(n) === 'ALL') return this.mk<A.Star>(n, { kind: 'Star' });
      this.fail(n, `a name is $.${n.text}, a property of the arrow's parameter (PT2.5)`);
    }
    if (ts.isCallExpression(n)) return this.callExpr(n);
    this.fail(n, 'outside the expression subset of PT2.2');
  }

  /** S84: an operand; a record or map literal there is lit({ … }), and a bare one is refused, as tsc refuses it. */
  private operand(node: ts.Expression): A.Expr {
    const n = this.unparen(node);
    if (ts.isObjectLiteralExpression(n) || ts.isArrayLiteralExpression(n)) this.fail(n, 'a record or map literal as an operand is written lit({ … }) (S84)');
    if (ts.isCallExpression(n) && this.combinator(n.expression) === 'lit') {
      const [v] = this.argsOf({ name: 'lit', node: n }, 1, 1);
      const inner = this.unparen(v);
      if (!ts.isObjectLiteralExpression(inner) && !ts.isArrayLiteralExpression(inner)) this.fail(v, 'lit takes a record or map literal (S84)');
      return this.expr(inner);
    }
    return this.expr(n);
  }

  private callExpr(n: ts.CallExpression): A.Expr {
    const name = this.combinator(n.expression);
    if (!name) this.fail(n.expression, 'a call to anything but a poly combinator is outside the embedded subset');
    const c = { name, node: n };
    switch (name) {
      case 'implies': {
        const [a, b] = this.argsOf(c, 2, 2);
        return this.mk<A.Binary>(n, { kind: 'Binary', op: 'implies', left: this.expr(a), right: this.expr(b) });
      }
      case 'is': {
        const [e, ...ctors] = this.argsOf(c, 2, 64);
        return this.mk<A.Is>(n, { kind: 'Is', expr: this.expr(e), ctors: ctors.map((x) => this.str(x)) });
      }
      case 'isIn': {
        const [e, set] = this.argsOf(c, 2, 2);
        return this.mk<A.In>(n, { kind: 'In', expr: this.expr(e), set: this.arr(set).map((x) => this.expr(x)) });
      }
      case 'ctor': {
        const [ctor, fields] = this.argsOf(c, 2, 2);
        return this.mk<A.CtorExpr>(n, { kind: 'CtorExpr', ctor: this.str(ctor), fields: this.obj(fields).map(([k, v]) => ({ name: k, value: this.expr(v) })) });
      }
      case 'spawned': {
        const [k] = this.argsOf(c, 1, 1);
        const e = this.expr(k);
        if (e.kind === 'Name') return this.mk<A.Spawned>(n, { kind: 'Spawned', key: e.name, index: null });
        if (e.kind === 'Index' && e.object.kind === 'Name') return this.mk<A.Spawned>(n, { kind: 'Spawned', key: e.object.name, index: e.index });
        this.fail(k, 'spawned takes $.k or $.f[i] (S48, S49)');
      }
      case 'forall':
      case 'exists': {
        const [v, g, body] = this.argsOf(c, 3, 3);
        return this.mk<A.Quant>(n, { kind: 'Quant', q: name, var: this.str(v), group: this.str(g), body: this.arrow(body, (b) => this.expr(b)) });
      }
      case 'emits': {
        // PS5.2, S178: emits('k', { f: v }?).
        const [effect, fields] = this.argsOf(c, 1, 2);
        return this.mk<A.Emits>(n, { kind: 'Emits', effect: this.str(effect), fields: fields ? this.emitsFields(fields) : [] });
      }
      case 'primed': return this.mk<A.PrimedRef>(n, { kind: 'Primed', name: this.str(this.argsOf(c, 1, 1)[0]) });
      case 'lit': this.fail(n, 'lit({ … }) is written only as an operand of an operator; elsewhere a literal is plain (S84)');
      case 'call': {
        const [callee, ...args] = this.argsOf(c, 1, 64);
        return this.mk<A.Call>(n, { kind: 'Call', callee: this.str(callee), args: args.map((a) => this.expr(a)) });
      }
    }
    if (FUNCTIONS.has(name)) return this.mk<A.Call>(n, { kind: 'Call', callee: name, args: this.argsOf(c, 0, 64).map((a) => this.expr(a)) });
    this.fail(n, `${name}(…) is not an expression`);
  }
}

/** Reads an embedded module (PT2.5): the AST, with ids, or PL0001 / PL0301 at the offending node. */
export function readEmbedded(text: string, file = 'module.ts'): EmbedResult {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const syntax = (sf as unknown as { parseDiagnostics: ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
  if (syntax.length) {
    const d = syntax[0];
    const at = sf.getLineAndCharacterOfPosition(d.start);
    return { module: null, diagnostics: [diag('PL0001', { line: at.line + 1, col: at.character + 1 }, ts.flattenDiagnosticMessageText(d.messageText, ' '))] };
  }
  try {
    const module = new Reader(sf).module();
    assignIds(module as unknown as Record<string, unknown>);
    return { module, diagnostics: [] };
  } catch (e) {
    if (!(e instanceof Outside)) throw e;
    const at = sf.getLineAndCharacterOfPosition(e.node.getStart(sf));
    return { module: null, diagnostics: [diag('PL0301', { line: at.line + 1, col: at.character + 1 }, e.message)] };
  }
}
