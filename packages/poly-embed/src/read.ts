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
    const c = this.call(node, 'enumType', 'union', 'record', 'use', 'machine', 'configuration');
    switch (c.name) {
      case 'enumType': {
        const [name, members] = this.argsOf(c, 2, 2);
        return this.mk<A.EnumDecl>(c.node, { kind: 'EnumDecl', name: this.str(name), members: this.arr(members).map((m) => this.str(m)) });
      }
      case 'union': {
        const [name, ctors] = this.argsOf(c, 2, 2);
        return this.mk<A.TypeDecl>(c.node, { kind: 'TypeDecl', name: this.str(name), ctors: this.obj(ctors).map(([k, v, kn]) => this.mk<A.Ctor>(kn, { kind: 'Ctor', name: k, fields: this.payload(v) })) });
      }
      case 'record': {
        const [name, fields] = this.argsOf(c, 2, 2);
        return this.mk<A.RecordDecl>(c.node, { kind: 'RecordDecl', name: this.str(name), fields: this.payload(fields) });
      }
      case 'use': {
        const [path] = this.argsOf(c, 1, 1);
        return this.mk<A.UseDecl>(c.node, { kind: 'Use', path: this.str(path).split('.') });
      }
      case 'machine': return this.machine(c);
      default: return this.configuration(c);
    }
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
    const c = this.call(node, 'terminal', 'action', 'on', 'guard', 'invariant', 'stepProperty', 'rejectProperty', 'pathProperty', 'composeInvariant', 'liveness', 'effect', 'decision');
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
        const [action, body, params] = this.argsOf(c, 2, 3);
        return this.mk<A.Handler>(c.node, { kind: 'Handler', action: this.str(action), params: params ? this.arr(params).map((p) => this.str(p)) : null, body: this.arrow(body, (b) => this.stmts(b)) });
      }
      case 'guard': {
        const [cond, reason] = this.argsOf(c, 2, 2);
        return this.mk<A.Guard>(c.node, { kind: 'Guard', cond: this.arrow(cond, (b) => this.expr(b)), reason: this.str(reason) });
      }
      case 'liveness': return this.liveness(c);
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
    const c = this.call(node, 'provider', 'labels', 'timeout', 'band', 'ok', 'okWith', 'failed', 'exhausted');
    const mk = (fields: Record<string, unknown>) => ({ id: '', ...fields, span: this.span(c.node) }) as unknown as A.DecisionItem;
    if (c.name === 'provider') return mk({ kind: 'DecProvider', value: this.str(this.argsOf(c, 1, 1)[0]) });
    if (c.name === 'timeout') return mk({ kind: 'DecTimeout', value: this.str(this.argsOf(c, 1, 1)[0]) });
    if (c.name === 'band') { const [lo, hi] = this.argsOf(c, 2, 2); return mk({ kind: 'DecBand', lo: this.decimal(lo), hi: this.decimal(hi) }); }
    return this.effItem(node) as A.DecisionItem;
  }

  private effItem(node: ts.Expression): A.EffectItem {
    const c = this.call(node, 'kind', 'labels', 'cls', 'retry', 'ok', 'okWith', 'failed', 'exhausted');
    const mk = (fields: Record<string, unknown>) => ({ id: '', ...fields, span: this.span(c.node) }) as unknown as A.EffectItem;
    switch (c.name) {
      case 'kind': return mk({ kind: 'EffKind', value: this.str(this.argsOf(c, 1, 1)[0]) });
      case 'labels': return mk({ kind: 'EffLabels', labels: this.arr(this.argsOf(c, 1, 1)[0]).map((l) => this.str(l)) });
      case 'cls': return mk({ kind: 'EffClass', value: this.str(this.argsOf(c, 1, 1)[0]) });
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
