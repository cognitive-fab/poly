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
const LATER_TOP_LEVEL = new Set(['world']);

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
  for (const a of p.lineAnchors) a.node.id = `${a.owner.id}:${a.slot}`;
  attachComments(module, p.attachable, comments, trivia);
  for (const d of p.laterDiagnostics) d.at.module = module.name;
  return { module, trivia, diagnostics: p.laterDiagnostics };
}

class Parser {
  private i = 0;
  /** Nodes comments may attach to, in document order. */
  readonly attachable: A.NodeBase[] = [];
  readonly laterDiagnostics: Diagnostic[] = [];
  /** Review D-F6: obligation body lines with no expression (on unknown, states, initial, end), as comment anchors outside the AST. */
  readonly lineAnchors: { owner: A.NodeBase; slot: string; node: A.NodeBase }[] = [];

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
  /** An anchor for the line from `start` to the last token read; its id is set from its owner's after assignIds. */
  private lineAnchor(start: Token, slot: string, pending: { slot: string; node: A.NodeBase }[]): void {
    const node: A.NodeBase = { id: '', span: this.spanFrom(start) };
    this.attachable.push(node);
    pending.push({ slot, node });
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
    if (this.at('workflow') && this.peek(1).kind === 'ident') return this.workflow();
    if (this.at('channel') && this.peek(1).kind === 'ident' && this.atPunct(':', 2)) return this.channel();
    if (this.at('credential') && this.peek(1).kind === 'ident' && this.atPunct(':', 2)) return this.credential();
    if (this.at('audience') && this.atPunct('{', 1)) return this.audience();
    if (this.at('source') && this.peek(1).kind === 'ident' && this.atPunct(':', 2)) return this.source();
    if (this.at('route') && this.peek(1).kind === 'ident' && this.atPunct('{', 2)) return this.route();
    if (this.at('budget') && this.peek(1).kind === 'ident' && this.atPunct('{', 2)) return this.budget();
    if (this.at('use')) {
      this.next();
      return this.node<A.UseDecl>(start, { kind: 'Use', path: this.qualName() }, true);
    }
    if (start.kind === 'ident' && LATER_TOP_LEVEL.has(start.text)) {
      this.skipBalanced();
      this.laterDiagnostics.push(diag('PL0901', { line: start.line, col: start.col }, `'${start.text}' is not lowered in milestone M0`));
      return null;
    }
    this.fail('expected a declaration (type, enum, claims, machine, configuration, policy, workflow, channel, credential, audience, source, route, budget, use)');
  }

  /** `audience { a1 < a2 < … }` (PS1.4b, Q3): a total order of classes, the lowest first. */
  private audience(): A.AudienceDecl {
    const start = this.next();
    this.expect('{');
    const classes = [this.ident('an audience class')];
    while (this.atPunct('<')) { this.next(); classes.push(this.ident('an audience class')); }
    this.expect('}');
    return this.node<A.AudienceDecl>(start, { kind: 'Audience', classes }, true);
  }

  /** `source s: k { adapter "a"  audience c [owned]  freshness d [stale escalate | stale deny]  [keys { k, … }]  [envelope k]  [credential c] }` (PS17.0, S451, S459, S460). */
  private source(): A.SourceDecl {
    const start = this.next();
    const name = this.ident('a source name');
    this.expect(':');
    const sourceKind = this.ident('a source kind');
    this.expect('{');
    let adapter: string | null = null;
    let audience: string | null = null;
    let owned = false;
    let freshness: string | null = null;
    let stale: A.SourceDecl['stale'] = 'escalate';
    let keys: string[] | null = null;
    let envelope: string | null = null;
    let credential: string | null = null;
    const seen = new Set<string>();
    while (!this.atPunct('}')) {
      const is = this.peek();
      const w = this.ident('adapter, audience, freshness, stale, keys, envelope or credential');
      // As for a channel's and a credential's clauses: each is written once.
      if (seen.has(w)) this.fail(`a source states its ${w} once`, is);
      seen.add(w);
      if (w === 'adapter') adapter = this.str('an adapter name');
      else if (w === 'audience') {
        audience = this.ident('an audience class');
        if (this.at('owned')) { this.next(); owned = true; }
      } else if (w === 'freshness') freshness = this.duration();
      else if (w === 'stale') {
        const s = this.ident('escalate or deny');
        if (s !== 'escalate' && s !== 'deny') this.fail('expected escalate or deny', is);
        stale = s;
      } else if (w === 'keys') {
        // PS17.0, S451: `keys { k1, …, kn }`, at least one identifier, each named once.
        this.expect('{');
        keys = [];
        do {
          const at = this.peek();
          const k = this.ident('a key name');
          if (keys.includes(k)) this.fail(`a source names its key ${k} once`, at);
          keys.push(k);
        } while (this.atPunct(',') && this.next());
        this.expect('}');
      } else if (w === 'envelope') {
        // PS17.0, S459: `envelope k`, the key by which the adapter gives a reply's envelope; the check holds k to keys.
        envelope = this.ident('a key name');
      } else if (w === 'credential') {
        // PS17.0, PT10j, S460: `credential c`, the credential whose grant the adapter reaches its provider under (S461: per owner when c has a holder).
        credential = this.ident('a credential name');
      } else this.fail('expected adapter, audience, freshness, stale, keys, envelope or credential', is);
    }
    if (audience === null) this.fail('a source names its audience (PS17.0)');
    this.next();
    return this.node<A.SourceDecl>(start, { kind: 'Source', name, sourceKind, adapter, audience, owned, freshness, stale, ...(keys ? { keys } : {}), ...(envelope !== null ? { envelope } : {}), ...(credential !== null ? { credential } : {}) }, true);
  }

  /**
   * `route r { tier t provider "p" prices "f" [calibration "f"] max tokens n …  escalate when e or …  [budget b] }`
   * (PT10r, PS18.1). Each tier is one line of clauses in that order; the escalation clause and the budget are written once.
   */
  private route(): A.Route {
    const start = this.next();
    const name = this.ident('a route name');
    this.expect('{');
    const tiers: A.RouteTier[] = [];
    let escalate: A.RouteTerm[] | null = null;
    let budget: string | null = null;
    let budgetSeen = false;
    while (!this.atPunct('}')) {
      const is = this.peek();
      const w = this.ident('tier, escalate or budget');
      if (w === 'tier') {
        const tier = this.ident('a tier name');
        this.word('provider');
        const provider = this.str('a provider name');
        this.word('prices');
        const prices = this.str('a price table');
        let calibration: string | null = null;
        if (this.at('calibration')) { this.next(); calibration = this.str('a calibration map'); }
        // S360: the input limit first, then the output limit.
        this.word('max');
        if (!this.at('input')) this.fail('a tier states its input token limit: max input tokens n max tokens n (S360)');
        this.next();
        this.word('tokens');
        const maxInputTokens = this.int();
        this.word('max');
        this.word('tokens');
        const maxTokens = this.int();
        tiers.push(this.node<A.RouteTier>(is, { kind: 'RouteTier', name: tier, provider, prices, calibration, maxInputTokens, maxTokens }));
      } else if (w === 'escalate') {
        // As for a credential's clauses: each is written once, since a second would silently replace the first.
        if (escalate !== null) this.fail('a route states its escalation once', is);
        this.word('when');
        escalate = [this.routeTerm()];
        while (this.at('or')) { this.next(); escalate.push(this.routeTerm()); }
      } else if (w === 'budget') {
        if (budgetSeen) this.fail('a route names its budget once', is);
        budgetSeen = true;
        budget = this.ident('a budget name');
      } else this.fail('expected tier, escalate or budget', is);
    }
    if (escalate === null) this.fail('a route states when it escalates: escalate when conf < c or margin < c or failed (PT10r)');
    this.next();
    return this.node<A.Route>(start, { kind: 'Route', name, tiers, escalate, budget }, true);
  }

  /** `conf < c`, `margin < c` or `failed`, one term of a route's escalation (PS18.1). */
  private routeTerm(): A.RouteTerm {
    const is = this.peek();
    const w = this.ident('conf, margin or failed');
    if (w === 'failed') return { on: 'failed' };
    if (w !== 'conf' && w !== 'margin') this.fail('expected conf < c, margin < c or failed', is);
    this.expect('<');
    return { on: w, below: this.decimal() };
  }

  /** PS18.3: an amount such as 0.50 or 20 in micro-units, exactly: the lexer gives at most three places, so it is a whole number of them. */
  private microAmount(): number {
    const tok = this.peek();
    if (tok.kind !== 'int' && tok.kind !== 'decimal') this.fail('expected an amount such as 0.50');
    this.next();
    const [whole, frac = ''] = tok.text.split('.');
    const amount = Number(whole) * 1_000_000 + Number(frac.padEnd(6, '0'));
    if (!Number.isSafeInteger(amount)) this.fail(`the amount ${tok.text} is out of range`, tok);
    return amount;
  }

  /** `budget b { cap <currency> <amount> per run | per scope | per <period> [per scope] …  [on exhausted deny | escalate] }` (PT10r, PS18.4). */
  private budget(): A.Budget {
    const start = this.next();
    const name = this.ident('a budget name');
    this.expect('{');
    const caps: A.BudgetCap[] = [];
    let onExhausted: A.Budget['onExhausted'] | null = null;
    while (!this.atPunct('}')) {
      const is = this.peek();
      const w = this.ident('cap or on');
      if (w === 'cap') {
        const currency = this.ident('a currency');
        const tok = this.peek();
        if (tok.kind !== 'int' && tok.kind !== 'decimal') this.fail('expected an amount such as 0.50');
        this.next();
        // PS18.3: the amount in micro-units, exactly: the lexer gives at most three places, so it is a whole number of them.
        const [whole, frac = ''] = tok.text.split('.');
        const amount = Number(whole) * 1_000_000 + Number(frac.padEnd(6, '0'));
        if (!Number.isSafeInteger(amount)) this.fail(`the amount ${tok.text} is out of range`, tok);
        let run = false;
        let period: A.BudgetCap['period'] = null;
        let scope = false;
        this.word('per');
        const p = this.peek();
        const first = this.ident('run, scope, hour, day or month');
        if (first === 'run') run = true;
        else if (first === 'scope') scope = true;
        else if (first === 'hour' || first === 'day' || first === 'month') {
          period = first;
          if (this.at('per')) { this.next(); this.word('scope'); scope = true; }
        } else this.fail('expected per run, per scope, or per hour, day or month', p);
        caps.push(this.node<A.BudgetCap>(is, { kind: 'BudgetCap', currency, amount, run, period, scope }));
      } else if (w === 'on') {
        if (onExhausted !== null) this.fail('a budget states what it does when exhausted once', is);
        this.word('exhausted');
        const what = this.ident('deny or escalate');
        if (what !== 'deny' && what !== 'escalate') this.fail('expected deny or escalate', is);
        onExhausted = what;
      } else this.fail('expected cap or on exhausted', is);
    }
    this.next();
    return this.node<A.Budget>(start, { kind: 'Budget', name, caps, onExhausted: onExhausted ?? 'deny' }, true);
  }

  /** The keyword `w`, as an identifier the grammar fixes at this place. */
  private word(w: string): void {
    const tok = this.peek();
    if (tok.kind !== 'ident' || tok.text !== w) this.fail(`expected ${w}`, tok);
    this.next();
  }

  /** `credential c: oauth2 { provider "p"  grant authorization_code [pkce] | client_credentials  scopes { … }  holder T }` (PT10e). */
  private credential(): A.Credential {
    const start = this.next();
    const name = this.ident('a credential name');
    this.expect(':');
    const credKind = this.ident('a credential kind');
    this.expect('{');
    let provider: string | null = null;
    let grant: A.Credential['grant'] | null = null;
    let pkce = false;
    let scopes: string[] | null = null;
    let holder: string | null = null;
    const seen = new Set<string>();
    while (!this.atPunct('}')) {
      const is = this.peek();
      const w = this.ident('provider, grant, scopes or holder');
      // As for a channel's clauses: each is written once, since a second would silently replace the first.
      if (seen.has(w)) this.fail(`a credential states its ${w} once`, is);
      seen.add(w);
      if (w === 'provider') provider = this.str('a provider name');
      else if (w === 'grant') {
        const g = this.ident('authorization_code or client_credentials');
        if (g !== 'authorization_code' && g !== 'client_credentials') this.fail('expected authorization_code or client_credentials', is);
        grant = g;
        if (g === 'authorization_code' && this.at('pkce')) { this.next(); pkce = true; }
      } else if (w === 'scopes') scopes = this.scopeSet();
      else if (w === 'holder') holder = this.ident('the holder\'s type');
      else this.fail('expected provider, grant, scopes or holder', is);
    }
    if (provider === null || grant === null || scopes === null) this.fail('a credential names its provider, grant and scopes (PT10e)');
    this.next();
    return this.node<A.Credential>(start, { kind: 'Credential', name, credKind, provider, grant, pkce, scopes, holder }, true);
  }

  /** `{ s, … }`: provider scope names, each an identifier or a dotted one (PT10e). */
  private scopeSet(): string[] {
    this.expect('{');
    const out: string[] = [];
    while (!this.atPunct('}')) {
      out.push(this.qualName().join('.'));
      if (!this.atPunct('}')) this.expect(',');
    }
    this.next();
    return out;
  }

  /** `channel c: k { adapter "…"  thread "…"  starts A.S [on inbound]  P -> A.X … }` (PT21.1, PS15). */
  private channel(): A.Channel {
    const start = this.next();
    const name = this.ident('a channel name');
    this.expect(':');
    const channelKind = this.ident('a channel kind');
    this.expect('{');
    let adapter: string | null = null;
    let thread = '';
    let starts: A.Channel['starts'] = null;
    let audience: string | null = null;
    let principalFrom: string | null = null;
    const maps: A.ChannelMap[] = [];
    const seen = new Set<string>();
    while (!this.atPunct('}')) {
      // PS15, S305: the class of the channel's recipients.
      if (this.at('audience') && !this.atPunct('->', 1)) { if (seen.has('audience')) this.fail('a channel names its audience once'); seen.add('audience'); this.next(); audience = this.ident('an audience class'); continue; }
      // PS15.0a (S450): the claims field that gives the thread its principal.
      if (this.at('principal') && this.at('from', 1)) { if (seen.has('principal')) this.fail('a channel names the field of its principal once'); seen.add('principal'); this.next(); this.next(); principalFrom = this.ident('a field of the Sender claims'); continue; }
      // Review A-F6 (M8b): each clause is written once; a second would silently replace the first.
      if (this.at('adapter')) { if (seen.has('adapter')) this.fail('a channel names its adapter once'); seen.add('adapter'); this.next(); adapter = this.str('an adapter name'); continue; }
      if (this.at('thread')) { if (seen.has('thread')) this.fail('a channel names its thread key once'); seen.add('thread'); this.next(); thread = this.str('a thread template'); continue; }
      if (this.at('starts')) {
        if (seen.has('starts')) this.fail('a channel names the action that starts a thread once');
        seen.add('starts');
        this.next();
        const machine = this.ident('the application machine');
        this.expect('.');
        const action = this.ident('the starting action');
        let onInbound = false;
        if (this.at('on') && this.at('inbound', 1)) { this.next(); this.next(); onInbound = true; }
        starts = { machine, action, onInbound };
        continue;
      }
      const ms = this.peek();
      const peer = this.ident('a Peer action, adapter, thread or starts');
      this.expect('->');
      const machine = this.ident('the application machine');
      this.expect('.');
      const action = this.ident('an action of the application');
      maps.push(this.node<A.ChannelMap>(ms, { kind: 'ChannelMap', peer, machine, action }, true));
    }
    this.next();
    return this.node<A.Channel>(start, { kind: 'Channel', name, channelKind, adapter, thread, starts, maps, ...(audience !== null ? { audience } : {}), ...(principalFrom ? { principalFrom } : {}) }, true);
  }

  /** `workflow w runs M { input A  key "…" where f matches "…", …  tool "kind" -> t target "…" why "…" … }` (PT10, S166). */
  private workflow(): A.Workflow {
    const start = this.next();
    const name = this.dashedName();
    this.expect('runs');
    const machine = this.ident('a machine');
    this.expect('{');
    this.expect('input');
    const input = this.ident('the input action');
    let key: A.Workflow['key'] = null;
    if (this.at('key')) {
      const ks = this.next();
      const template = this.str('the key template');
      const fields: A.WorkflowKeyField[] = [];
      if (this.at('where')) {
        this.next();
        do {
          const fs = this.peek();
          const fname = this.ident('a key field');
          this.expect('matches');
          fields.push(this.node<A.WorkflowKeyField>(fs, { kind: 'WorkflowKeyField', name: fname, pattern: this.str('a pattern') }, true));
        } while (this.atPunct(',') && this.next());
      }
      key = this.node<A.WorkflowKey>(ks, { kind: 'WorkflowKey', template, fields }, true);
    }
    const tools: A.WorkflowTool[] = [];
    while (this.at('tool')) {
      const ts = this.next();
      const effect = this.str('an effect kind');
      this.expect('->');
      const tool = this.peek().kind === 'string' ? this.str() : this.ident('a tool');
      let target: string | null = null;
      if (this.at('target')) { this.next(); target = this.str('a target'); }
      this.expect('why');
      tools.push(this.node<A.WorkflowTool>(ts, { kind: 'WorkflowTool', effect, tool, target, why: this.str('why the step exists') }, true));
    }
    // PS18.7 (M7.5): the budget of the workflow's orders, written once, after the tools.
    let budget: A.WorkflowBudget | null = null;
    if (this.at('budget')) {
      const bs = this.next();
      const bname = this.ident('a budget name');
      this.expect('prices');
      const prices = this.str('a price table');
      this.word('order');
      this.word('cap');
      const currency = this.ident('a currency');
      budget = this.node<A.WorkflowBudget>(bs, { kind: 'WorkflowBudget', name: bname, prices, orderCap: { currency, amount: this.microAmount() } }, true);
    }
    this.expect('}');
    return this.node<A.Workflow>(start, { kind: 'Workflow', name, machine, input, key, tools, budget }, true);
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
          if (this.at('when')) { this.next(); when = this.expr(); this.attachable.push(when); }
          this.expect('require');
          const require = this.expr();
          this.attachable.push(require);
          this.expect('else');
          const sev = this.ident('deny, warn or escalate');
          if (sev !== 'deny' && sev !== 'warn' && sev !== 'escalate') this.fail('expected deny, warn or escalate', this.t[this.i - 1]);
          let onUnknown: A.RuleObligation['onUnknown'] = null;
          const anchors: { slot: string; node: A.NodeBase }[] = [];
          if (this.at('on')) {
            const at = this.peek();
            this.next();
            this.expect('unknown');
            const u = this.ident('escalate, deny or skip');
            if (u !== 'escalate' && u !== 'deny' && u !== 'skip') this.fail('expected escalate, deny or skip', this.t[this.i - 1]);
            onUnknown = u;
            this.lineAnchor(at, 'onUnknown', anchors);
          }
          this.expect('}');
          const rule = this.node<A.RuleObligation>(s, { kind: 'RuleObligation', name: oname, text, when, require, severity: sev, onUnknown }, true);
          for (const a of anchors) this.lineAnchors.push({ owner: rule, ...a });
          items.push(rule);
        } else if (this.at('machine')) {
          this.next();
          this.expect('{');
          const anchors: { slot: string; node: A.NodeBase }[] = [];
          const atStates = this.peek();
          this.expect('states');
          const states = this.identList('a state');
          this.lineAnchor(atStates, 'states', anchors);
          const atInitial = this.peek();
          this.expect('initial');
          const initial = this.ident('the initial state');
          this.lineAnchor(atInitial, 'initial', anchors);
          const transitions: A.MachineObligation['transitions'] = [];
          const guards: A.MachineObligation['guards'] = [];
          while (this.at('from') || this.at('deny')) {
            if (this.at('from')) {
              this.next();
              let from: string[] | '*';
              if (this.atPunct('*')) { this.next(); from = '*'; } else from = this.identList('a state');
              this.expect('when');
              const when = this.expr();
              this.attachable.push(when);
              this.expect('->');
              transitions.push({ from, when, to: this.ident('a state') });
            } else {
              this.next();
              this.expect('in');
              const inStates = this.identList('a state');
              this.expect('when');
              const when = this.expr();
              this.attachable.push(when);
              this.expect('reason');
              guards.push({ in: inStates, when, reason: this.str('a reason') });
            }
          }
          const atEnd = this.peek();
          this.expect('end');
          const end = this.identList('a state');
          this.lineAnchor(atEnd, 'end', anchors);
          this.expect('}');
          const machine = this.node<A.MachineObligation>(s, { kind: 'MachineObligation', name: oname, text, states, initial, transitions, guards, end }, true);
          for (const a of anchors) this.lineAnchors.push({ owner: machine, ...a });
          items.push(machine);
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
      // Polywatch: each field is a comment anchor, as a machine's fields are.
      fields.push(this.node<A.PayloadField>(fs, { kind: 'PayloadField', name: fname, type }, true));
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
        key = this.node<A.TName>(ks, { kind: 'TName', name: this.dottedType(this.ident('a key type')) });
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
    return this.node<A.TName>(start, { kind: 'TName', name: this.dottedType(name) });
  }

  /** S190: a type of another module, `m.E` (the module may be dotted); the name is kept whole. */
  private dottedType(first: string): string {
    let name = first;
    while (this.atPunct('.') && this.peek(1).kind === 'ident') { this.next(); name += '.' + this.next().text; }
    return name;
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
      case 'never': {
        // PS5.2a, S178: `never n: emit k(f: v, …) while P`; without `while`, P is true.
        this.next();
        const name = this.dashedName();
        this.expect(':');
        this.expect('emit');
        let effect = this.ident('an effect name');
        if (this.atPunct('.') && this.peek(1).kind === 'ident') { this.next(); effect += '.' + this.next().text; }
        const fields = this.atPunct('(') ? this.emitsFields() : [];
        let cond: A.Expr | null = null;
        if (this.at('while')) { this.next(); cond = this.expr(); }
        return this.node<A.NeverEmit>(start, { kind: 'NeverEmit', name, effect, fields, cond }, true);
      }
      case 'effect':
        this.next();
        return this.effect(start);
      case 'decision':
        if (this.peek(1).kind === 'ident') { this.next(); return this.decision(start); }
        break;
    }
    this.fail('expected a machine item (terminal, action, on, guard, a property, never, effect)');
  }

  /** `(f: v, …)` after an effect's name in `never … emit k(…)`, the `(` not yet taken (PS5.2a). */
  private emitsFields(): A.EmitsField[] {
    this.expect('(');
    const out: A.EmitsField[] = [];
    while (!this.atPunct(')')) {
      const fs = this.peek();
      const name = this.ident('a payload field');
      this.expect(':');
      out.push(this.node<A.EmitsField>(fs, { kind: 'EmitsField', name, value: this.expr() }));
      if (!this.atPunct(')')) this.expect(',');
    }
    this.next();
    return out;
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
      } else if (w === 'idempotent') {
        // PT33.1: `idempotent header "<Name>" window <duration>` (keyed, G2) or `idempotent by nature "<reason>"` (G4).
        const at = this.peek();
        const form = this.ident('header or by');
        if (form === 'header') {
          const header = this.str('a header name');
          this.expect('window');
          const window = this.duration();
          items.push(this.effItem(is, { kind: 'EffIdempotent', form: 'header', header, window }));
        } else if (form === 'by') {
          this.expect('nature');
          items.push(this.effItem(is, { kind: 'EffIdempotent', form: 'nature', reason: this.str('the reason') }));
        } else this.fail('expected header or by nature after idempotent', at);
      } else if (w === 'targets') {
        // PT6.5, S151: each key names a capability; its value is one target or a list of them. S455: a target is a
        // string or `exact "<url>"`; the check allows exact on egress only (PL1201), so it is read here on any kind.
        this.expect('{');
        const targets: { key: string; values: A.TargetValue[] }[] = [];
        const target = (): A.TargetValue => {
          if (this.peek().kind === 'ident' && this.peek().text === 'exact' && this.peek(1).kind === 'string') { this.next(); return { exact: this.str('a target') }; }
          return this.str('a target');
        };
        while (!this.atPunct('}')) {
          const key = this.ident('a target kind');
          this.expect(':');
          const values: A.TargetValue[] = [];
          if (this.atPunct('[')) {
            this.next();
            while (!this.atPunct(']')) { values.push(target()); if (!this.atPunct(']')) this.expect(','); }
            this.next();
          } else values.push(target());
          targets.push({ key, values });
          if (!this.atPunct('}')) this.expect(',');
        }
        this.next();
        items.push(this.effItem(is, { kind: 'EffTargets', targets }));
      } else if (w === 'uses') {
        // PT10e: `uses c { s, … } for p`, the holder optional here and required by the check for a person's grant.
        const credential = this.ident('a credential');
        const scopes = this.scopeSet();
        let holder: string | null = null;
        if (this.at('for')) { this.next(); holder = this.ident('the holder parameter'); }
        items.push(this.effItem(is, { kind: 'EffUses', credential, scopes, holder }));
      } else if (w === 'retrieve') {
        // PS17.2, S451: `retrieve s [where Pred [and Pred]] limit n`, Pred `owner == p` or `k == x`, at most one of each.
        // S459: `retrieve s envelope where Pred [and Pred]`, an envelope retrieval, which names no limit.
        const source = this.ident('a source');
        let owner: string | null = null;
        let key: { name: string; param: string } | null = null;
        const envelope = this.at('envelope');
        if (envelope) { this.next(); if (!this.at('where')) this.fail("expected 'where': an envelope retrieval names its key (PS17.2)"); }
        if (this.at('where')) {
          this.next();
          do {
            const at = this.peek();
            const name = this.ident('owner or a key');
            this.expect('==');
            const param = this.ident(name === 'owner' ? 'a Principal parameter' : 'a Key parameter');
            if (name === 'owner') { if (owner !== null) this.fail('a retrieval names its owner once', at); owner = param; }
            else { if (key !== null) this.fail('a retrieval names at most one key', at); key = { name, param }; }
          } while (this.at('and') && this.next());
        }
        if (envelope) {
          if (this.at('limit')) this.fail('an envelope retrieval names no limit: it gives one envelope (PS17.2, PT10j)');
          items.push(this.effItem(is, { kind: 'EffRetrieve', source, owner, limit: 0, ...(key ? { key } : {}), envelope: true }));
        } else {
          this.expect('limit');
          const limit = this.int();
          items.push(this.effItem(is, { kind: 'EffRetrieve', source, owner, limit, ...(key ? { key } : {}) }));
        }
      } else if (w === 'remember') {
        // PS17.5: `remember s as k about p`.
        const source = this.ident('a memory source');
        this.expect('as');
        const at = this.peek();
        const provenance = this.ident('observed, derived or verified');
        if (provenance !== 'observed' && provenance !== 'derived' && provenance !== 'verified') this.fail('expected observed, derived or verified', at);
        this.expect('about');
        const about = this.ident('the subject parameter');
        items.push(this.effItem(is, { kind: 'EffRemember', source, provenance, about }));
      } else if (w === 'to') {
        // PS17.3: the payload field that names the recipient.
        items.push(this.effItem(is, { kind: 'EffTo', param: this.ident('the recipient parameter') }));
      } else if (w === 'audience') {
        items.push(this.effItem(is, { kind: 'EffAudience', cls: this.ident('an audience class') }));
      } else if (w === 'envelope') {
        // PS17.3a, S459: the Content parameter whose envelope gives the recipient and the threading headers.
        items.push(this.effItem(is, { kind: 'EffEnvelope', param: this.ident('a Content parameter') }));
      } else if (w === 'one') {
        // PS17.4b, S462: the Items parameter that holds exactly one item.
        items.push(this.effItem(is, { kind: 'EffOne', param: this.ident('an Items parameter') }));
      } else if (w === 'ok' || w === 'failed' || w === 'exhausted') {
        items.push(this.outcome(is, w));
      } else this.fail('expected kind, labels, targets, uses, retrieve, remember, to, audience, envelope, one, class, retry, idempotent, ok, failed or exhausted', is);
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
      } else if (w === 'cites') items.push(this.effItem(is, { kind: 'DecCites', param: this.ident('an Items parameter') }) as unknown as A.DecisionItem);
      else if (w === 'route') items.push(this.effItem(is, { kind: 'DecRoute', route: this.ident('a route name') }) as unknown as A.DecisionItem);
      else if (w === 'prices' || w === 'budget') {
        // PS18.4a, S454: `prices "f" max input tokens I max tokens N budget b`, one clause. A part left out is parsed as
        // null, so `budget b` alone or a clause with no budget is the checker's PL1201, not a syntax error.
        let prices: string | null = null, maxInputTokens: number | null = null, maxTokens: number | null = null, budget: string | null = null;
        if (w === 'prices') {
          prices = this.str('a price table');
          if (this.at('max')) {
            this.next();
            if (!this.at('input')) this.fail('a decision states its input token limit: max input tokens n max tokens n (S360)');
            this.next();
            this.word('tokens');
            maxInputTokens = this.int();
            this.word('max');
            this.word('tokens');
            maxTokens = this.int();
          }
          if (this.at('budget')) { this.next(); budget = this.ident('a budget name'); }
        } else budget = this.ident('a budget name');
        items.push(this.effItem(is, { kind: 'DecBudget', budget, prices, maxInputTokens, maxTokens }) as unknown as A.DecisionItem);
      } else if (w === 'ok' || w === 'failed' || w === 'exhausted') items.push(this.outcome(is, w));
      else this.fail('expected provider, route, prices, labels, timeout, band, cites, ok or failed', is);
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
        // PS15.3: `emit c.reply(…)` names a channel's message, which the expansion makes a send.
        if (this.atPunct('.') && this.peek(1).kind === 'ident') { this.next(); base.target += '.' + this.next().text; }
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
      // PS5.2, S178: `emits(k, f: v, …)`, an effect's name and its field filter.
      if (start.text === 'emits' && this.atPunct('(')) {
        this.next();
        let effect = this.ident('an effect name');
        if (this.atPunct('.') && this.peek(1).kind === 'ident') { this.next(); effect += '.' + this.next().text; }
        const fields: A.EmitsField[] = [];
        while (this.atPunct(',')) {
          this.next();
          const fs = this.peek();
          const name = this.ident('a payload field');
          this.expect(':');
          fields.push(this.node<A.EmitsField>(fs, { kind: 'EmitsField', name, value: this.expr() }));
        }
        this.expect(')');
        return this.node<A.Emits>(start, { kind: 'Emits', effect, fields });
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
