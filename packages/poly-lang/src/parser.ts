// The poly parser (PT2, PS12).
//
// Recursive descent for declarations and statements, precedence climbing for
// expressions. Keywords are contextual (PT2.1): a word is a keyword only in a
// position where the grammar expects one. Two rules need lookahead:
//   - after a field's initial expression, `derived` or `internal` followed by
//     `:` starts the next field; otherwise it is the field's modifier (PT2.1);
//   - in the condition of an `if` and the scrutinee of a `match`, an
//     identifier followed by `{` is never a constructor (PT2.4, S10).
// Errors are PL0001 SYNTAX. Constructs that parse but belong to a later
// milestone are kept in the AST; the checker refuses them (PL0901).
import type * as A from '@poly/core';
import { assignIds, diag, type Diagnostic } from '@poly/core';
import { lex, LexError, type Comment, type Token } from './lexer.js';

export interface Trivia {
  /** Comments before a node, by node id. */
  leading: Map<string, string[]>;
  /** A comment after a node on its last line, by node id. */
  trailing: Map<string, string>;
  /** Comments after the last node. */
  end: string[];
}

export interface ParseResult {
  module: A.Module | null;
  trivia: Trivia;
  diagnostics: Diagnostic[];
}

class ParseError extends Error {
  constructor(message: string, readonly tok: { line: number; col: number }) {
    super(message);
  }
}

type Span = A.Span;
type Mk<T> = Omit<T, 'id' | 'span'>;

const BINARY: Record<string, { prec: number; assoc: 'left' | 'right' | 'none' }> = {
  '*': { prec: 3, assoc: 'left' },
  '/': { prec: 3, assoc: 'left' },
  '%': { prec: 3, assoc: 'left' },
  '+': { prec: 4, assoc: 'left' },
  '-': { prec: 4, assoc: 'left' },
  '<': { prec: 5, assoc: 'none' },
  '<=': { prec: 5, assoc: 'none' },
  '>': { prec: 5, assoc: 'none' },
  '>=': { prec: 5, assoc: 'none' },
  in: { prec: 5, assoc: 'none' },
  // PT8.1: `effect.labels has "egress:external"`, a policy's set membership, written as a call `has(s, x)` in the AST.
  has: { prec: 5, assoc: 'none' },
  is: { prec: 5, assoc: 'none' },
  '==': { prec: 6, assoc: 'none' },
  '!=': { prec: 6, assoc: 'none' },
  '&&': { prec: 7, assoc: 'left' },
  '||': { prec: 8, assoc: 'left' },
  implies: { prec: 9, assoc: 'right' },
};

const STMT_KEYWORDS = new Set(['require', 'reject', 'let', 'if', 'match', 'emit', 'after', 'cancel', 'spawn', 'send', 'signal', 'for', 'decide', 'adjudicate']);
const LATER_TOP_LEVEL = new Set(['workflow', 'world']);

export function parse(src: string): ParseResult {
  const trivia: Trivia = { leading: new Map(), trailing: new Map(), end: [] };
  let tokens: Token[];
  let comments: Comment[];
  try {
    ({ tokens, comments } = lex(src));
  } catch (e) {
    const le = e as LexError;
    return { module: null, trivia, diagnostics: [diag('PL0001', { line: le.line, col: le.col }, le.message)] };
  }
  const p = new Parser(tokens);
  let module: A.Module;
  try {
    module = p.module();
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    return { module: null, trivia, diagnostics: [diag('PL0001', { line: e.tok.line, col: e.tok.col }, e.message)] };
  }
  assignIds(module as unknown as Record<string, unknown>);
  attachComments(module, p.attachable, comments, trivia);
  for (const d of p.laterDiagnostics) d.at.module = module.name;
  return { module, trivia, diagnostics: p.laterDiagnostics };
}

class Parser {
  private i = 0;
  /** Nodes comments may attach to, in document order. */
  readonly attachable: A.NodeBase[] = [];
  readonly laterDiagnostics: Diagnostic[] = [];

  constructor(private readonly t: Token[]) {}

  // ── token helpers ─────────────────────────────────────────────────────────
  private peek(k = 0): Token { return this.t[Math.min(this.i + k, this.t.length - 1)]; }
  private at(text: string, k = 0): boolean {
    const tok = this.peek(k);
    return (tok.kind === 'punct' || tok.kind === 'ident') && tok.text === text;
  }
  private atPunct(text: string, k = 0): boolean { const tok = this.peek(k); return tok.kind === 'punct' && tok.text === text; }
  private next(): Token { const tok = this.peek(); if (tok.kind !== 'eof') this.i++; return tok; }
  private fail(msg: string, tok: Token = this.peek()): never {
    throw new ParseError(`${msg}, found ${tok.kind === 'eof' ? 'end of file' : `'${tok.text}'`}`, tok);
  }
  private expect(text: string): Token {
    if (!this.at(text)) this.fail(`expected '${text}'`);
    return this.next();
  }
  private ident(what = 'a name'): string {
    const tok = this.peek();
    if (tok.kind !== 'ident') this.fail(`expected ${what}`);
    this.i++;
    return tok.text;
  }
  private str(what = 'a string'): string {
    const tok = this.peek();
    if (tok.kind !== 'string') this.fail(`expected ${what}`);
    this.i++;
    return tok.text;
  }
  private int(): number {
    let neg = false;
    if (this.atPunct('-')) { this.next(); neg = true; }
    const tok = this.peek();
    if (tok.kind !== 'int') this.fail('expected an integer');
    this.i++;
    return neg ? -(tok.value as number) : (tok.value as number);
  }
  private spanFrom(start: Token): Span {
    const last = this.t[Math.max(0, this.i - 1)];
    return { line: start.line, col: start.col, endLine: last.endLine, endCol: last.endCol };
  }
  private node<T extends A.NodeBase>(start: Token, fields: Mk<T>, attach = false): T {
    const n = { id: '', ...fields, span: this.spanFrom(start) } as unknown as T;
    if (attach) this.attachable.push(n);
    return n;
  }
  /** A name that may contain adjacent hyphens: `locked-when-empty` (property names). */
  private dashedName(): string {
    let name = this.ident('a property name');
    while (this.atPunct('-') && this.peek().start === this.t[this.i - 1].end && this.peek(1).start === this.peek().end && (this.peek(1).kind === 'ident' || this.peek(1).kind === 'int')) {
      this.next();
      name += '-' + this.next().text;
    }
    return name;
  }
  private skipBalanced(): void {
    // Used for top-level constructs of later milestones: skip to the matching brace.
    while (!this.atPunct('{')) { if (this.peek().kind === 'eof') this.fail("expected '{'"); this.next(); }
    let depth = 0;
    do {
      const tok = this.next();
      if (tok.kind === 'eof') this.fail("expected '}'");
      if (tok.kind === 'punct' && tok.text === '{') depth++;
      if (tok.kind === 'punct' && tok.text === '}') depth--;
    } while (depth > 0);
  }

  /** A fragment for a typed edit (parseFragment): the whole input must be one node of the kind. */
  fragment(kind: 'expr' | 'type' | 'stmt' | 'pattern'): A.Expr | A.TypeExpr | A.Stmt | A.Pattern {
    const node = kind === 'expr' ? this.expr() : kind === 'type' ? this.type() : kind === 'stmt' ? this.stmt() : this.armPattern();
    if (this.peek().kind !== 'eof') this.fail('expected the end of the fragment');
    return node;
  }

  // ── module and declarations ─────────────────────────────────────────────
  module(): A.Module {
    const start = this.peek();
    this.expect('module');
    const name = this.qualName().join('.');
    const decls: A.Decl[] = [];
    while (this.peek().kind !== 'eof') {
      const d = this.decl();
      if (d) decls.push(d);
    }
    return this.node<A.Module>(start, { kind: 'Module', name, decls }, true);
  }

  private qualName(): string[] {
    const parts = [this.ident()];
    while (this.atPunct('.') && this.peek(1).kind === 'ident') { this.next(); parts.push(this.ident()); }
    return parts;
  }

  private decl(): A.Decl | null {
    const start = this.peek();
    if (this.at('type')) return this.typeDecl();
    if (this.at('enum')) return this.enumDecl();
    if (this.at('claims') && this.peek(1).kind === 'ident') return this.claimsDecl();
    if (this.at('machine')) return this.machine(false);
    if (this.at('service') && this.at('machine', 1)) { this.next(); return this.machine(true, start); }
    if (this.at('configuration') && this.peek(1).kind === 'ident') return this.configuration();
    if (this.at('policy') && this.peek(1).kind === 'ident') return this.policy();
    if (this.at('use')) {
      this.next();
      return this.node<A.UseDecl>(start, { kind: 'Use', path: this.qualName() }, true);
    }
    if (start.kind === 'ident' && LATER_TOP_LEVEL.has(start.text)) {
      this.skipBalanced();
      this.laterDiagnostics.push(diag('PL0901', { line: start.line, col: start.col }, `'${start.text}' is not lowered in milestone M0`));
      return null;
    }
    this.fail('expected a declaration (type, enum, claims, machine, configuration, policy, use)');
  }

  /** `policy p { scope "s" var … obligation … recalled … never … }` (PT8.1, S149). */
  private policy(): A.Policy {
    const start = this.next();
    const name = this.dashedName();
    this.expect('{');
    this.expect('scope');
    const scope = this.str('the policy\'s scope');
    // S156: `requires attribution`.
    let requiresAttribution = false;
    if (this.at('requires')) { this.next(); this.expect('attribution'); requiresAttribution = true; }
    const vars: A.PolicyVar[] = [];
    const items: A.PolicyItem[] = [];
    while (!this.atPunct('}')) {
      const s = this.peek();
      if (this.at('var')) {
        this.next();
        const v = this.ident('a variable');
        this.expect(':');
        const type = this.type();
        this.expect('=');
        vars.push(this.node<A.PolicyVar>(s, { kind: 'PolicyVar', name: v, type, init: this.expr() }, true));
      } else if (this.at('obligation')) {
        this.next();
        const oname = this.dashedName();
        const text = this.str('the obligation\'s text');
        if (this.at('rule')) {
          this.next();
          this.expect('{');
          let when: A.Expr | null = null;
          if (this.at('when')) { this.next(); when = this.expr(); }
          this.expect('require');
          const require = this.expr();
          this.expect('else');
          const sev = this.ident('deny, warn or escalate');
          if (sev !== 'deny' && sev !== 'warn' && sev !== 'escalate') this.fail('expected deny, warn or escalate', this.t[this.i - 1]);
          let onUnknown: A.RuleObligation['onUnknown'] = null;
          if (this.at('on')) {
            this.next();
            this.expect('unknown');
            const u = this.ident('escalate, deny or skip');
            if (u !== 'escalate' && u !== 'deny' && u !== 'skip') this.fail('expected escalate, deny or skip', this.t[this.i - 1]);
            onUnknown = u;
          }
          this.expect('}');
          items.push(this.node<A.RuleObligation>(s, { kind: 'RuleObligation', name: oname, text, when, require, severity: sev, onUnknown }, true));
        } else if (this.at('machine')) {
          this.next();
          this.expect('{');
          this.expect('states');
          const states = this.identList('a state');
          this.expect('initial');
          const initial = this.ident('the initial state');
          const transitions: A.MachineObligation['transitions'] = [];
          const guards: A.MachineObligation['guards'] = [];
          while (this.at('from') || this.at('deny')) {
            if (this.at('from')) {
              this.next();
              let from: string[] | '*';
              if (this.atPunct('*')) { this.next(); from = '*'; } else from = this.identList('a state');
              this.expect('when');
              const when = this.expr();
              this.expect('->');
              transitions.push({ from, when, to: this.ident('a state') });
            } else {
              this.next();
              this.expect('in');
              const inStates = this.identList('a state');
              this.expect('when');
              const when = this.expr();
              this.expect('reason');
              guards.push({ in: inStates, when, reason: this.str('a reason') });
            }
          }
          this.expect('end');
          const end = this.identList('a state');
          this.expect('}');
          items.push(this.node<A.MachineObligation>(s, { kind: 'MachineObligation', name: oname, text, states, initial, transitions, guards, end }, true));
        } else if (this.at('invariant')) {
          this.next();
          this.expect('{');
          const expr = this.expr();
          this.expect('}');
          items.push(this.node<A.InvariantObligation>(s, { kind: 'InvariantObligation', name: oname, text, expr }, true));
        } else this.fail('expected rule, machine or invariant');
      } else if (this.at('recalled')) {
        this.next();
        const rname = this.dashedName();
        items.push(this.node<A.Recalled>(s, { kind: 'Recalled', name: rname, text: this.str('the recalled text') }, true));
      } else if (this.at('never')) {
        this.next();
        const nname = this.dashedName();
        const text = this.str('the statement\'s text');
        this.expect(':');
        this.expect('allow');
        this.expect('when');
        items.push(this.node<A.Never>(s, { kind: 'Never', name: nname, text, when: this.expr() }, true));
      } else this.fail('expected var, obligation, recalled or never');
    }
    this.next();
    return this.node<A.Policy>(start, { kind: 'Policy', name, scope, ...(requiresAttribution ? { requiresAttribution: true as const } : {}), vars, items }, true);
  }

  private identList(what: string): string[] {
    const out = [this.ident(what)];
    while (this.atPunct(',')) { this.next(); out.push(this.ident(what)); }
    return out;
  }

  /** `configuration c { instances, inputs, bounds, properties }` (PT2, PT7a, S31). */
  private configuration(): A.Configuration {
    const start = this.next();
    const name = this.dashedName();
    this.expect('{');
    const instances: A.ConfigInstance[] = [];
    const inputs: A.InputRef[] = [];
    let bounds: A.ConfigBounds | null = null;
    const properties: (A.Property | A.Liveness)[] = [];
    while (!this.atPunct('}')) {
      const is = this.peek();
      // Keywords are contextual (PT2.1): a word followed by `:` or `[` names an instance.
      const instance = is.kind === 'ident' && (this.atPunct(':', 1) || this.atPunct('[', 1));
      if (!instance && this.at('inputs')) {
        this.next();
        this.expect('{');
        while (!this.atPunct('}')) {
          const rs = this.peek();
          const inst = this.ident('an instance');
          let index: A.InputRef['index'] = null;
          if (this.atPunct('[')) {
            this.next();
            if (this.atPunct('*')) { this.next(); index = '*'; } else index = this.int();
            this.expect(']');
          }
          this.expect('.');
          const action = this.ident('an action');
          inputs.push(this.node<A.InputRef>(rs, { kind: 'InputRef', instance: inst, index, action }));
          if (!this.atPunct('}')) this.expect(',');
        }
        this.next();
      } else if (!instance && this.at('bounds')) {
        this.next();
        this.expect('{');
        this.expect('transit');
        const transit = this.int();
        let n: number | null = null;
        if (this.atPunct(',')) { this.next(); this.expect('instances'); n = this.int(); }
        this.expect('}');
        if (bounds) this.fail('a configuration states its bounds once', is);
        bounds = this.node<A.ConfigBounds>(is, { kind: 'ConfigBounds', transit, instances: n }, true);
      } else if (!instance && this.at('invariant')) {
        this.next();
        properties.push(this.property(is, 'invariant'));
      } else if (!instance && this.at('liveness')) {
        this.next();
        properties.push(this.liveness(is));
      } else {
        const iname = this.ident('an instance, inputs, bounds, invariant or liveness');
        let count: number | null = null;
        if (this.atPunct('[')) { this.next(); count = this.int(); this.expect(']'); }
        this.expect(':');
        const machine = this.qualName();
        const init: A.ConfigInstance['init'] = [];
        if (this.atPunct('{')) {
          this.next();
          while (!this.atPunct('}')) {
            const field = this.ident('a field');
            this.expect(':');
            init.push({ field, value: this.expr() });
            if (!this.atPunct('}')) this.expect(',');
          }
          this.next();
        }
        // PS8.7, S160: `scope "x"` assigns the instance a trust scope; absent, it is its machine's module.
        let scope: string | undefined;
        if (this.at('scope') && this.peek(1).kind === 'string') { this.next(); scope = this.str(); }
        instances.push(this.node<A.ConfigInstance>(is, { kind: 'ConfigInstance', name: iname, count, machine, init, ...(scope !== undefined ? { scope } : {}) }, true));
      }
    }
    this.next();
    return this.node<A.Configuration>(start, { kind: 'Configuration', name, instances, inputs, bounds, properties }, true);
  }

  /** `claims C { f: T … }` (PD5.1.2): fields one per line, or separated by commas. */
  private claimsDecl(): A.RecordDecl {
    const start = this.next();
    const name = this.ident('a claims type name');
    this.expect('{');
    const fields: A.PayloadField[] = [];
    while (!this.atPunct('}')) {
      const fs = this.peek();
      const fname = this.ident('a claims field');
      this.expect(':');
      const type = this.type();
      fields.push(this.node<A.PayloadField>(fs, { kind: 'PayloadField', name: fname, type }));
      if (this.atPunct(',')) this.next();
    }
    this.next();
    return this.node<A.RecordDecl>(start, { kind: 'RecordDecl', name, fields, claims: true }, true);
  }

  private typeDecl(): A.TypeDecl | A.RecordDecl {
    const start = this.next();
    const name = this.ident('a type name');
    this.expect('=');
    // S25: `type R = { f: T, … }` is a record: its fields and no constructor.
    if (this.atPunct('{')) {
      this.next();
      const fields: A.PayloadField[] = [];
      while (!this.atPunct('}')) {
        const fs = this.peek();
        const fname = this.ident('a record field');
        this.expect(':');
        const type = this.type();
        fields.push(this.node<A.PayloadField>(fs, { kind: 'PayloadField', name: fname, type }));
        if (!this.atPunct('}')) this.expect(',');
      }
      this.next();
      return this.node<A.RecordDecl>(start, { kind: 'RecordDecl', name, fields }, true);
    }
    if (this.atPunct('|')) this.next();
    const ctors = [this.ctor()];
    while (this.atPunct('|')) { this.next(); ctors.push(this.ctor()); }
    return this.node<A.TypeDecl>(start, { kind: 'TypeDecl', name, ctors }, true);
  }

  private ctor(): A.Ctor {
    const start = this.peek();
    const name = this.ident('a constructor name');
    const fields: A.PayloadField[] = [];
    if (this.atPunct('{')) {
      this.next();
      while (!this.atPunct('}')) {
        const fs = this.peek();
        const fname = this.ident('a payload field');
        this.expect(':');
        const type = this.type();
        fields.push(this.node<A.PayloadField>(fs, { kind: 'PayloadField', name: fname, type }));
        if (!this.atPunct('}')) this.expect(',');
      }
      this.next();
    }
    return this.node<A.Ctor>(start, { kind: 'Ctor', name, fields }, true);
  }

  private enumDecl(): A.EnumDecl {
    const start = this.next();
    const name = this.ident('an enum name');
    this.expect('{');
    const members = [this.ident('an enum member')];
    while (this.atPunct(',')) { this.next(); if (this.atPunct('}')) break; members.push(this.ident('an enum member')); }
    this.expect('}');
    return this.node<A.EnumDecl>(start, { kind: 'EnumDecl', name, members }, true);
  }

  // ── types and domains ───────────────────────────────────────────────────
  private type(): A.TypeExpr {
    const start = this.peek();
    if (start.kind === 'int' || this.atPunct('-')) {
      const lo = this.int();
      this.expect('..');
      const hi = this.int();
      return this.node<A.TRange>(start, { kind: 'TRange', lo, hi });
    }
    const name = this.ident('a type');
    if (name === 'bool') return this.node<A.TBool>(start, { kind: 'TBool' });
    if (name === 'int') return this.node<A.TInt>(start, { kind: 'TInt' });
    if (name === 'string') return this.node<A.TString>(start, { kind: 'TString' });
    if (name === 'Conf') return this.node<A.TConf>(start, { kind: 'TConf' });
    if (name === 'map' && this.atPunct('<')) {
      this.next();
      const ks = this.peek();
      let key: A.TName | A.TRange;
      if (ks.kind === 'int' || this.atPunct('-')) {
        const lo = this.int();
        this.expect('..');
        const hi = this.int();
        key = this.node<A.TRange>(ks, { kind: 'TRange', lo, hi });
      } else {
        key = this.node<A.TName>(ks, { kind: 'TName', name: this.ident('a key type') });
      }
      this.expect(',');
      const value = this.type();
      this.closeAngle();
      return this.node<A.TMap>(start, { kind: 'TMap', key, value });
    }
    if (name === 'Ref' && this.atPunct('<')) {
      this.next();
      const machine = this.qualName();
      this.closeAngle();
      return this.node<A.TRef>(start, { kind: 'TRef', machine });
    }
    return this.node<A.TName>(start, { kind: 'TName', name });
  }

  /** `>` closing a type argument list; `>=` is split so `map<A, B>= x` still parses. */
  private closeAngle(): void {
    const tok = this.peek();
    if (tok.kind === 'punct' && tok.text === '>=') {
      this.t.splice(this.i, 1,
        { ...tok, text: '>', endCol: tok.col + 1, end: tok.start + 1 },
        { ...tok, text: '=', col: tok.col + 1, start: tok.start + 1 });
    }
    this.expect('>');
  }

  private checkClause(): A.CheckClause | null {
    if (!this.at('check')) return null;
    const start = this.next();
    let domain: A.Domain;
    const ds = this.peek();
    if (this.atPunct('{')) {
      this.next();
      const values: A.Literal[] = [];
      while (!this.atPunct('}')) {
        values.push(this.literal());
        if (!this.atPunct('}')) this.expect(',');
      }
      this.next();
      domain = this.node<A.DomainSet>(ds, { kind: 'DomainSet', values });
    } else {
      const lo = this.int();
      this.expect('..');
      const hi = this.int();
      domain = this.node<A.DomainRange>(ds, { kind: 'DomainRange', lo, hi });
    }
    let mode: A.CheckMode | null = null;
    if (this.at('strict') || this.at('disclosed')) mode = this.next().text as A.CheckMode;
    return this.node<A.CheckClause>(start, { kind: 'Check', domain, mode });
  }

  private literal(): A.Literal {
    const start = this.peek();
    if (start.kind === 'string') { this.next(); return this.node<A.StringLit>(start, { kind: 'String', value: start.text }); }
    if (start.kind === 'int' || this.atPunct('-')) return this.node<A.IntLit>(start, { kind: 'Int', value: this.int() });
    if (this.at('true') || this.at('false')) { this.next(); return this.node<A.BoolLit>(start, { kind: 'Bool', value: start.text === 'true' }); }
    return this.node<A.NameRef>(start, { kind: 'Name', name: this.ident('a literal') });
  }

  // ── machines ────────────────────────────────────────────────────────────
  private machine(service: boolean, start: Token = this.peek()): A.Machine {
    this.expect('machine');
    const name = this.ident('a machine name');
    this.expect('{');
    let version: number | null = null;
    if (this.at('version') && this.peek(1).kind === 'int') {
      this.next();
      version = this.int();
      if (this.at('from')) {
        // Migrations are PT11, after M0.
        const tok = this.peek();
        this.laterDiagnostics.push(diag('PL0901', { line: tok.line, col: tok.col }, 'migrations are not lowered in milestone M0'));
        this.next();
        this.int();
        this.skipBalanced();
      }
    }
    const fields: A.Field[] = [];
    if (this.at('state') && this.atPunct('{', 1)) {
      this.next();
      this.next();
      while (!this.atPunct('}')) fields.push(this.field());
      this.next();
    } else {
      this.fail("expected the 'state { … }' block");
    }
    const items: A.MachineItem[] = [];
    while (!this.atPunct('}')) items.push(this.item());
    this.next();
    return this.node<A.Machine>(start, { kind: 'Machine', name, service, version, fields, items }, true);
  }

  private field(): A.Field {
    const start = this.peek();
    const name = this.ident('a field name');
    this.expect(':');
    const type = this.type();
    const check = this.checkClause();
    this.expect('=');
    const init = this.expr();
    let flag: A.Field['flag'] = null;
    // PT2.1: `derived` or `internal` followed by `:` starts the next field.
    if ((this.at('derived') || this.at('internal')) && !this.atPunct(':', 1)) flag = this.next().text as A.Field['flag'];
    return this.node<A.Field>(start, { kind: 'Field', name, type, check, init, flag }, true);
  }

  private item(): A.MachineItem {
    const start = this.peek();
    const w = start.kind === 'ident' ? start.text : '';
    switch (w) {
      case 'terminal':
        this.next();
        return this.node<A.Terminal>(start, { kind: 'Terminal', expr: this.expr() }, true);
      case 'action': {
        this.next();
        const name = this.ident('an action name');
        this.expect('(');
        const params = this.params(')');
        return this.node<A.Action>(start, { kind: 'Action', name, params }, true);
      }
      case 'on': {
        this.next();
        const action = this.ident('an action name');
        let params: string[] | null = null;
        if (this.atPunct('(')) {
          this.next();
          params = [];
          while (!this.atPunct(')')) {
            params.push(this.ident('a parameter name'));
            if (!this.atPunct(')')) this.expect(',');
          }
          this.next();
        }
        // PD5.1.2: `by c: C`, the claims the action requires.
        let by: A.Handler['by'];
        if (this.at('by')) {
          this.next();
          const bname = this.ident('the name of the claims');
          this.expect(':');
          by = { name: bname, type: this.ident('a claims type') };
        }
        const body = this.block();
        return this.node<A.Handler>(start, { kind: 'Handler', action, params, ...(by ? { by } : {}), body }, true);
      }
      case 'guard': {
        this.next();
        this.expect('all');
        this.expect('when');
        const cond = this.expr();
        this.expect('reject');
        const reason = this.str('a rejection reason');
        return this.node<A.Guard>(start, { kind: 'Guard', cond, reason }, true);
      }
      case 'invariant':
        this.next();
        return this.property(start, 'invariant');
      case 'step':
      case 'reject':
      case 'path':
        if (this.at('property', 1)) {
          this.next();
          this.next();
          return this.property(start, w as A.PropertyForm);
        }
        break;
      case 'compose':
        if (this.at('invariant', 1)) {
          this.next();
          this.next();
          return this.property(start, 'compose');
        }
        break;
      case 'liveness':
        this.next();
        return this.liveness(start);
      case 'effect':
        this.next();
        return this.effect(start);
      case 'decision':
        if (this.peek(1).kind === 'ident') { this.next(); return this.decision(start); }
        break;
    }
    this.fail('expected a machine item (terminal, action, on, guard, a property, effect)');
  }

  private params(close: string): A.Param[] {
    const params: A.Param[] = [];
    while (!this.atPunct(close)) {
      const ps = this.peek();
      const name = this.ident('a parameter name');
      this.expect(':');
      const type = this.type();
      const check = this.checkClause();
      params.push(this.node<A.Param>(ps, { kind: 'Param', name, type, check }));
      if (!this.atPunct(close)) this.expect(',');
    }
    this.next();
    return params;
  }

  private property(start: Token, form: A.PropertyForm): A.Property {
    const name = this.dashedName();
    this.expect(':');
    const expr = this.expr();
    return this.node<A.Property>(start, { kind: 'Property', form, name, expr }, true);
  }

  private liveness(start: Token): A.Liveness {
    const name = this.dashedName();
    this.expect(':');
    let from: A.Expr | null = null;
    let expr: A.Expr;
    // S56, PS13.6: `forall i in g:` before the property scopes over the whole `leads to`.
    let quant: A.Liveness['quant'] = null;
    if ((this.at('forall') || this.at('exists')) && this.peek(1).kind === 'ident' && this.at('in', 2) && this.peek(3).kind === 'ident' && this.atPunct(':', 4)) {
      const q = this.next().text as 'forall' | 'exists';
      const v = this.ident();
      this.next();
      const group = this.ident();
      this.next();
      quant = { q, var: v, group };
    }
    if (this.at('eventually')) {
      this.next();
      expr = this.expr();
    } else {
      from = this.expr();
      this.expect('leads');
      this.expect('to');
      expr = this.expr();
    }
    // S56: the clause may be left out; the checker requires it in a machine.
    if (!this.at('under')) return this.node<A.Liveness>(start, { kind: 'Liveness', name, from, expr, fair: null, quant }, true);
    this.expect('under');
    this.expect('fair');
    this.expect('{');
    const fair: A.FairGroup[] = [];
    while (!this.atPunct('}')) {
      const gs = this.peek();
      const members = [this.fairMember()];
      while (this.atPunct('|')) { this.next(); members.push(this.fairMember()); }
      fair.push(this.node<A.FairGroup>(gs, { kind: 'FairGroup', members }));
      if (!this.atPunct('}')) this.expect(',');
    }
    this.next();
    return this.node<A.Liveness>(start, { kind: 'Liveness', name, from, expr, fair, quant }, true);
  }

  private fairMember(): A.FairGroup['members'][number] {
    let action = this.ident('an action name');
    // S73: in a configuration, `g[*].A`, `g[1].A` or `x.A`, as an InputRef.
    let input: { instance: string; index: number | '*' | null } | undefined;
    if (this.atPunct('[') || this.atPunct('.')) {
      let index: number | '*' | null = null;
      if (this.atPunct('[')) {
        this.next();
        if (this.atPunct('*')) { this.next(); index = '*'; } else index = this.int();
        this.expect(']');
      }
      this.expect('.');
      input = { instance: action, index };
      action = this.ident('an action name');
    }
    const perValue = this.atPunct('(') && this.atPunct('*', 1) && this.atPunct(')', 2);
    if (perValue) { this.next(); this.next(); this.next(); }
    return input ? { action, perValue, input } : { action, perValue };
  }

  private effect(start: Token): A.EffectDecl {
    const name = this.ident('an effect name');
    this.expect('(');
    const params = this.params(')');
    this.expect('{');
    const items: A.EffectItem[] = [];
    while (!this.atPunct('}')) {
      const is = this.peek();
      const w = this.ident('an effect item');
      if (w === 'kind') items.push(this.effItem(is, { kind: 'EffKind', value: this.str() }));
      else if (w === 'class') items.push(this.effItem(is, { kind: 'EffClass', value: this.ident('an effect class') }));
      else if (w === 'labels') {
        this.expect('{');
        const labels: string[] = [];
        while (!this.atPunct('}')) {
          let l = this.ident('a label');
          if (this.atPunct(':')) { this.next(); l += ':' + this.ident('a label'); }
          labels.push(l);
          if (!this.atPunct('}')) this.expect(',');
        }
        this.next();
        items.push(this.effItem(is, { kind: 'EffLabels', labels }));
      } else if (w === 'retry') {
        this.expect('{');
        this.expect('attempts');
        const attempts = this.int();
        this.expect(',');
        this.expect('base');
        const base = this.duration();
        this.expect(',');
        this.expect('timeout');
        const timeout = this.duration();
        this.expect('}');
        items.push(this.effItem(is, { kind: 'EffRetry', attempts, base, timeout }));
      } else if (w === 'targets') {
        // PT6.5, S151: each key names a capability; its value is one string or a list of strings.
        this.expect('{');
        const targets: { key: string; values: string[] }[] = [];
        while (!this.atPunct('}')) {
          const key = this.ident('a target kind');
          this.expect(':');
          const values: string[] = [];
          if (this.atPunct('[')) {
            this.next();
            while (!this.atPunct(']')) { values.push(this.str('a target')); if (!this.atPunct(']')) this.expect(','); }
            this.next();
          } else values.push(this.str('a target'));
          targets.push({ key, values });
          if (!this.atPunct('}')) this.expect(',');
        }
        this.next();
        items.push(this.effItem(is, { kind: 'EffTargets', targets }));
      } else if (w === 'ok' || w === 'failed' || w === 'exhausted') {
        items.push(this.outcome(is, w));
      } else this.fail('expected kind, labels, targets, class, retry, ok, failed or exhausted', is);
    }
    this.next();
    return this.node<A.EffectDecl>(start, { kind: 'EffectDecl', name, params, items }, true);
  }

  /** `ok -> A(args)`, `ok(r) -> A(p: r.x)` (PD1.2g, S79), `failed -> …`, `exhausted -> …`. */
  private outcome(start: Token, w: 'ok' | 'failed' | 'exhausted'): A.EffOutcomeItem {
    let bind: string | undefined;
    if (w === 'ok' && this.atPunct('(')) { this.next(); bind = this.ident('the name of the result'); this.expect(')'); }
    this.expect('->');
    const action = this.ident('an action name');
    const args = this.args();
    return this.effItem(start, { kind: 'EffOutcome', outcome: w, action, args, ...(bind !== undefined ? { bind } : {}) }) as A.EffOutcomeItem;
  }

  /** `decision d(params) -> R { provider, labels, timeout, band, ok(r) -> …, failed -> … }` (PD1.2, S76). */
  private decision(start: Token): A.Decision {
    const name = this.ident('a decision name');
    this.expect('(');
    const params = this.params(')');
    this.expect('->');
    const result = this.type();
    this.expect('{');
    const items: A.DecisionItem[] = [];
    while (!this.atPunct('}')) {
      const is = this.peek();
      const w = this.ident('a decision item');
      if (w === 'provider') items.push(this.effItem(is, { kind: 'DecProvider', value: this.str() }) as unknown as A.DecisionItem);
      else if (w === 'timeout') items.push(this.effItem(is, { kind: 'DecTimeout', value: this.duration() }) as unknown as A.DecisionItem);
      else if (w === 'labels') {
        this.expect('{');
        const labels: string[] = [];
        while (!this.atPunct('}')) {
          let l = this.ident('a label');
          if (this.atPunct(':')) { this.next(); l += ':' + this.ident('a label'); }
          labels.push(l);
          if (!this.atPunct('}')) this.expect(',');
        }
        this.next();
        items.push(this.effItem(is, { kind: 'EffLabels', labels }) as unknown as A.DecisionItem);
      } else if (w === 'band') {
        const lo = this.decimal();
        this.expect('..');
        const hi = this.decimal();
        items.push(this.effItem(is, { kind: 'DecBand', lo, hi }) as unknown as A.DecisionItem);
      } else if (w === 'ok' || w === 'failed' || w === 'exhausted') items.push(this.outcome(is, w));
      else this.fail('expected provider, labels, timeout, band, ok or failed', is);
    }
    this.next();
    return this.node<A.Decision>(start, { kind: 'Decision', name, params, result, items }, true);
  }

  private decimal(): number {
    const tok = this.peek();
    if (tok.kind !== 'decimal') this.fail('expected a decimal such as 0.3');
    this.next();
    return tok.value as number;
  }

  private effItem(start: Token, fields: Record<string, unknown>): A.EffectItem {
    return { id: '', ...fields, span: this.spanFrom(start) } as unknown as A.EffectItem;
  }

  private duration(): string {
    const tok = this.peek();
    if (tok.kind !== 'duration') this.fail('expected a duration such as 200ms');
    this.next();
    return tok.text;
  }

  // ── statements ──────────────────────────────────────────────────────────
  private block(): A.Stmt[] {
    this.expect('{');
    const body: A.Stmt[] = [];
    while (!this.atPunct('}')) body.push(this.stmt());
    this.next();
    return body;
  }

  private stmt(): A.Stmt {
    const start = this.peek();
    if (start.kind !== 'ident') this.fail('expected a statement');
    // `f' = …` is an assignment even when f is spelled like a keyword (PT2.1).
    if (this.atPunct("'", 1)) {
      const field = this.next().text;
      this.next();
      this.expect('=');
      // `f' = m with [k] = v`
      if (this.peek().kind === 'ident' && this.at('with', 1) && this.atPunct('[', 2)) {
        const base = this.next().text;
        this.next();
        this.next();
        const key = this.expr();
        this.expect(']');
        this.expect('=');
        const value = this.expr();
        return this.node<A.MapUpdate>(start, { kind: 'MapUpdate', field, base, key, value }, true);
      }
      return this.node<A.Assign>(start, { kind: 'Assign', field, expr: this.expr() }, true);
    }
    if (!STMT_KEYWORDS.has(start.text)) this.fail("expected a statement (require, reject, let, if, match, an assignment f' = …)");
    this.next();
    switch (start.text) {
      case 'require': {
        const cond = this.expr();
        this.expect('else');
        this.expect('reject');
        const reason = this.str('a rejection reason');
        return this.node<A.Require>(start, { kind: 'Require', cond, reason }, true);
      }
      case 'reject':
        return this.node<A.Reject>(start, { kind: 'Reject', reason: this.str('a rejection reason') }, true);
      case 'let': {
        const name = this.ident();
        this.expect('=');
        return this.node<A.Let>(start, { kind: 'Let', name, expr: this.expr() }, true);
      }
      case 'for': {
        // S49: `for i in lo..n { … }`.
        const v = this.ident('a loop variable');
        this.expect('in');
        const lo = this.int();
        this.expect('..');
        const hi = this.expr(true);
        const body = this.block();
        return this.node<A.For>(start, { kind: 'For', var: v, lo, hi, body }, true);
      }
      case 'if': {
        const cond = this.expr(true);
        const then = this.block();
        let els: A.Stmt[] | null = null;
        if (this.at('else')) { this.next(); els = this.block(); }
        return this.node<A.If>(start, { kind: 'If', cond, then, else: els }, true);
      }
      case 'match': {
        const scrutinee = this.expr(true);
        this.expect('{');
        const arms: A.Arm[] = [];
        while (!this.atPunct('}')) arms.push(this.arm());
        this.next();
        return this.node<A.Match>(start, { kind: 'Match', scrutinee, arms }, true);
      }
      default:
        return this.intent(start);
    }
  }

  private arm(): A.Arm {
    const start = this.peek();
    const pattern = this.armPattern();
    this.expect('=>');
    const body = this.atPunct('{') ? this.block() : [this.stmt()];
    return this.node<A.Arm>(start, { kind: 'Arm', pattern, body }, true);
  }

  private armPattern(): A.Pattern {
    const start = this.peek();
    let pattern: A.Pattern;
    if (this.at('_')) {
      this.next();
      pattern = this.node<A.PWild>(start, { kind: 'PWild' });
    } else {
      let ctor = this.ident('a constructor pattern');
      // S22: the qualified form Type.C is always legal.
      if (this.atPunct('.') && this.peek(1).kind === 'ident') { this.next(); ctor += '.' + this.ident('a constructor'); }
      const fields: A.PCtor['fields'] = [];
      if (this.atPunct('{')) {
        this.next();
        while (!this.atPunct('}')) {
          const name = this.ident('a payload field');
          this.expect(':');
          const tok = this.peek();
          if (tok.kind === 'ident' && tok.text !== 'true' && tok.text !== 'false') {
            this.next();
            fields.push({ name, bind: tok.text, literal: null });
          } else {
            fields.push({ name, bind: null, literal: this.literal() });
          }
          if (!this.atPunct('}')) this.expect(',');
        }
        this.next();
      }
      pattern = this.node<A.PCtor>(start, { kind: 'PCtor', ctor, fields });
    }
    return pattern;
  }

  private intent(start: Token): A.IntentStmt {
    const op = start.text as A.IntentStmt['op'];
    const base: Mk<A.IntentStmt> = { kind: 'Intent', op, target: '', args: [], to: null, modifier: null, as: null, index: null, extra: [] };
    // S49: a key may be indexed, `k[i]`.
    const index = (): A.Expr | null => {
      if (!this.atPunct('[')) return null;
      this.next();
      const e = this.expr();
      this.expect(']');
      return e;
    };
    switch (op) {
      case 'emit':
        base.target = this.ident('an effect name');
        base.args = this.args();
        break;
      case 'after':
        base.modifier = this.duration();
        this.expect('->');
        base.target = this.ident('an action name');
        base.args = this.args();
        this.expect('as');
        base.as = this.ident('a timer key');
        base.index = index();
        break;
      case 'cancel':
        base.target = this.ident('a timer key');
        base.index = index();
        break;
      case 'spawn':
        if (this.at('detached')) { this.next(); base.modifier = 'detached'; }
        base.target = this.qualName().join('.');
        this.expect('as');
        base.as = this.ident('a child key');
        base.index = index();
        // S43: an optional creation action, the child's first step.
        if (this.atPunct('->')) {
          this.next();
          base.extra.push('create', this.ident('an action name'));
          base.args = this.args();
        }
        if (this.at('on') && this.at('complete', 1)) {
          this.next(); this.next(); this.expect('->');
          base.extra.push('complete', this.ident());
          if (this.at('on') && this.at('parent', 1)) {
            this.next(); this.next(); this.expect('terminal'); this.expect('->');
            base.extra.push('parent-terminal', this.ident());
          }
        }
        break;
      case 'send':
        base.to = this.expr(false, true);
        this.expect('<-');
        base.target = this.ident('an action name');
        base.args = this.args();
        if (this.at('as')) { this.next(); base.as = this.ident(); }
        break;
      case 'decide':
        base.target = this.ident('a decision name');
        base.args = this.args();
        break;
      case 'adjudicate':
        // PD2.4, S129: `adjudicate d as Correct | Wrong`.
        base.target = this.ident('a decision name');
        this.expect('as');
        if (!this.at('Correct') && !this.at('Wrong')) this.fail('expected Correct or Wrong');
        base.modifier = this.ident();
        break;
      case 'signal':
        base.extra.push(this.ident('a child key'));
        base.index = index();
        this.expect('->');
        base.target = this.ident('an action name');
        base.args = this.args();
        break;
    }
    return this.node<A.IntentStmt>(start, base, true);
  }

  private args(): A.NamedArg[] {
    this.expect('(');
    const args: A.NamedArg[] = [];
    while (!this.atPunct(')')) {
      if (this.peek().kind === 'ident' && this.atPunct(':', 1)) {
        const name = this.next().text;
        this.next();
        args.push({ name, value: this.expr() });
      } else args.push({ name: null, value: this.expr() });
      if (!this.atPunct(')')) this.expect(',');
    }
    this.next();
    return args;
  }

  // ── expressions (PS12) ──────────────────────────────────────────────────
  /** noStruct: `Ident {` is not a constructor here (S10). arrow: stop at `<-` (send). */
  expr(noStruct = false, arrow = false): A.Expr {
    return this.binary(9, noStruct, arrow);
  }

  private opAt(arrow: boolean): string | null {
    const tok = this.peek();
    if (tok.kind === 'punct') {
      if (tok.text === '<-' && !arrow) {
        // `a <-1` is `a < -1`, outside a send.
        this.t.splice(this.i, 1,
          { ...tok, text: '<', endCol: tok.col + 1, end: tok.start + 1 },
          { ...tok, text: '-', col: tok.col + 1, start: tok.start + 1 });
        return '<';
      }
      return tok.text in BINARY ? tok.text : null;
    }
    if (tok.kind === 'ident' && (tok.text === 'implies' || tok.text === 'in' || tok.text === 'is' || tok.text === 'has')) return tok.text;
    return null;
  }

  private binary(maxPrec: number, noStruct: boolean, arrow: boolean): A.Expr {
    const start = this.peek();
    let left = this.unary(noStruct, arrow);
    let lastNonAssoc: number | null = null;
    for (;;) {
      const op = this.opAt(arrow);
      if (!op) return left;
      const info = BINARY[op];
      if (info.prec > maxPrec) return left;
      if (info.assoc === 'none' && lastNonAssoc === info.prec) this.fail(`'${op}' does not chain; add parentheses`);
      this.next();
      if (op === 'is') {
        const ctors = [this.ident('a constructor')];
        while (this.atPunct('|')) { this.next(); ctors.push(this.ident('a constructor')); }
        left = this.node<A.Is>(start, { kind: 'Is', expr: left, ctors });
      } else if (op === 'has') {
        const right = this.binary(info.prec - 1, noStruct, arrow);
        left = this.node<A.Call>(start, { kind: 'Call', callee: 'has', args: [left, right] });
      } else if (op === 'in') {
        this.expect('{');
        const set: A.Expr[] = [];
        while (!this.atPunct('}')) {
          set.push(this.expr());
          if (!this.atPunct('}')) this.expect(',');
        }
        this.next();
        left = this.node<A.In>(start, { kind: 'In', expr: left, set });
      } else {
        const rightMax = info.assoc === 'right' ? info.prec : info.prec - 1;
        const right = this.binary(rightMax, noStruct, arrow);
        left = this.node<A.Binary>(start, { kind: 'Binary', op: op as A.BinaryOp, left, right });
      }
      lastNonAssoc = info.assoc === 'none' ? info.prec : null;
    }
  }

  private unary(noStruct: boolean, arrow: boolean): A.Expr {
    const start = this.peek();
    if (this.atPunct('!') || this.atPunct('-')) {
      const op = this.next().text as A.UnaryOp;
      const arg = this.unary(noStruct, arrow);
      return this.node<A.Unary>(start, { kind: 'Unary', op, arg });
    }
    return this.postfix(noStruct);
  }

  private postfix(noStruct: boolean): A.Expr {
    const start = this.peek();
    let e = this.primary(noStruct);
    for (;;) {
      // S48: `k spawned`, in a compose invariant, says the child k exists.
      if ((e.kind === 'Name' || (e.kind === 'Index' && e.object.kind === 'Name')) && this.at('spawned') && this.peek().line === this.t[this.i - 1].endLine) {
        this.next();
        // S49: `f[i] spawned` names a member of the family f.
        e = e.kind === 'Name'
          ? this.node<A.Spawned>(start, { kind: 'Spawned', key: e.name, index: null })
          : this.node<A.Spawned>(start, { kind: 'Spawned', key: (e.object as A.NameRef).name, index: e.index });
        continue;
      }
      if (this.atPunct('.') && this.peek(1).kind === 'ident') {
        this.next();
        e = this.node<A.Member>(start, { kind: 'Member', object: e, prop: this.ident() });
      } else if (this.atPunct('[')) {
        this.next();
        // S49: `g[*]`, every member of a family, inside an aggregate.
        let index: A.Expr;
        if (this.atPunct('*') && this.atPunct(']', 1)) { const st = this.next(); index = this.node<A.Star>(st, { kind: 'Star' }); }
        else index = this.expr();
        this.expect(']');
        e = this.node<A.Index>(start, { kind: 'Index', object: e, index });
      } else return e;
    }
  }

  private primary(noStruct: boolean): A.Expr {
    const start = this.peek();
    if (start.kind === 'int') { this.next(); return this.node<A.IntLit>(start, { kind: 'Int', value: start.value as number }); }
    if (start.kind === 'decimal') { this.next(); return this.node<A.DecimalLit>(start, { kind: 'Decimal', value: start.value as number }); }
    if (start.kind === 'string') { this.next(); return this.node<A.StringLit>(start, { kind: 'String', value: start.text }); }
    if (this.atPunct('(')) {
      this.next();
      const e = this.expr();
      this.expect(')');
      return e;
    }
    if (this.atPunct('[')) {
      this.next();
      const items: A.Expr[] = [];
      while (!this.atPunct(']')) {
        items.push(this.expr());
        if (!this.atPunct(']')) this.expect(',');
      }
      this.next();
      return this.node<A.ArrayLit>(start, { kind: 'ArrayLit', items });
    }
    if (this.atPunct('{')) {
      if (noStruct) this.fail('a map literal here needs parentheses');
      this.next();
      const entries: A.MapLit['entries'] = [];
      while (!this.atPunct('}')) {
        const key = this.expr();
        this.expect(':');
        entries.push({ key, value: this.expr() });
        if (!this.atPunct('}')) this.expect(',');
      }
      this.next();
      return this.node<A.MapLit>(start, { kind: 'MapLit', entries });
    }
    // S49, PS13.6: `forall i in g: e` and `exists i in g: e`.
    if (start.kind === 'ident' && (start.text === 'forall' || start.text === 'exists') && this.peek(1).kind === 'ident' && this.at('in', 2)) {
      this.next();
      const v = this.ident('a bound name');
      this.expect('in');
      const group = this.ident('a family or group');
      this.expect(':');
      const body = this.expr();
      return this.node<A.Quant>(start, { kind: 'Quant', q: start.text as 'forall' | 'exists', var: v, group, body });
    }
    if (start.kind === 'ident') {
      this.next();
      if (start.text === 'true' || start.text === 'false') return this.node<A.BoolLit>(start, { kind: 'Bool', value: start.text === 'true' });
      if (this.atPunct("'")) {
        this.next();
        return this.node<A.PrimedRef>(start, { kind: 'Primed', name: start.text });
      }
      if (this.atPunct('(')) {
        this.next();
        const args: A.Expr[] = [];
        while (!this.atPunct(')')) {
          args.push(this.expr());
          if (!this.atPunct(')')) this.expect(',');
        }
        this.next();
        return this.node<A.Call>(start, { kind: 'Call', callee: start.text, args });
      }
      // S22: `Type.C { … }`, a qualified constructor with a payload. `Type.C` alone is a member access, resolved by the checker.
      if (!noStruct && this.atPunct('.') && this.peek(1).kind === 'ident' && this.atPunct('{', 2)) {
        this.next();
        const ctor = start.text + '.' + this.next().text;
        this.next();
        const fields: A.CtorExpr['fields'] = [];
        while (!this.atPunct('}')) {
          const name = this.ident('a payload field');
          this.expect(':');
          fields.push({ name, value: this.expr() });
          if (!this.atPunct('}')) this.expect(',');
        }
        this.next();
        return this.node<A.CtorExpr>(start, { kind: 'CtorExpr', ctor, fields });
      }
      if (this.atPunct('{') && !noStruct) {
        this.next();
        const fields: A.CtorExpr['fields'] = [];
        while (!this.atPunct('}')) {
          const name = this.ident('a payload field');
          this.expect(':');
          fields.push({ name, value: this.expr() });
          if (!this.atPunct('}')) this.expect(',');
        }
        this.next();
        return this.node<A.CtorExpr>(start, { kind: 'CtorExpr', ctor: start.text, fields });
      }
      return this.node<A.NameRef>(start, { kind: 'Name', name: start.text });
    }
    this.fail('expected an expression');
  }
}

// ── comments to nodes (PT1.4a) ────────────────────────────────────────────
function attachComments(module: A.Module, nodes: A.NodeBase[], comments: Comment[], trivia: Trivia): void {
  const ordered = nodes.filter((n) => n.span).sort((a, b) => a.span!.line - b.span!.line || a.span!.col - b.span!.col);
  for (const c of comments) {
    if (c.trailing) {
      // The node that ends last on this line, before the comment; innermost on a tie.
      let best: A.NodeBase | null = null;
      for (const n of ordered) {
        const s = n.span!;
        if (s.endLine === c.line && s.endCol <= c.col && (!best || s.endCol > best.span!.endCol || (s.endCol === best.span!.endCol && (s.line > best.span!.line || (s.line === best.span!.line && s.col > best.span!.col))))) best = n;
      }
      if (best && !trivia.trailing.has(best.id)) { trivia.trailing.set(best.id, c.text); continue; }
      // No node ends before it on its line (a comment after an opening brace): lead the next node.
    }
    const next = ordered.find((n) => n.span!.line > c.line || (n.span!.line === c.line && n.span!.col > c.col));
    if (next) trivia.leading.set(next.id, [...(trivia.leading.get(next.id) ?? []), c.text]);
    else trivia.end.push(c.text);
  }
  void module;
}

export type FragmentKind = 'expr' | 'type' | 'stmt' | 'pattern';

/**
 * One expression, type, statement or match-arm pattern, for typed edits (PT12.1, S70): a fix carries its
 * replacement as text, parsed here in the grammar position of the node it replaces. Throws on a syntax error.
 */
export function parseFragment(kind: FragmentKind, text: string): A.Expr | A.TypeExpr | A.Stmt | A.Pattern {
  const { tokens } = lex(text);
  const p = new Parser(tokens) as unknown as { fragment(k: FragmentKind): A.Expr | A.TypeExpr | A.Stmt | A.Pattern };
  return p.fragment(kind);
}
