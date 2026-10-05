// Fixes (PT12.1, S69, S70): typed edits addressed to AST nodes, each with the digest of its target node as
// its precondition.
//
// The catalogue of S70: PL3102 (add-require before the handler's first write, widen-range to the escaped
// value), PL1202 (read the pre-state field), PL1504 (the binder becomes `_`), PL1005 (the qualified
// constructor), PL1501 (a `_ => reject "unmatched"` arm), PL2101 (the require moved before the first write).
// Three edit operations: replace-node, insert-before-first-write, move-before-first-write.
//
// A fix is applied to the source as it is now: the target is found by its id (a path, PT12.1), and the fix
// is refused with PL0201 STALE_FIX when the node is gone, its digest differs from `pre`, or the operation's
// own precondition fails. The file is reprinted by the canonical formatter with its comments: the nodes the
// edit keeps keep their ids, so their comments stay with them, and an unchanged subtree of a replacement is
// the old subtree itself (grafting). On the embedded surface the changed node alone is reprinted and spliced
// in at its span (M3-3), so both poly surfaces get the same fixes with the same preconditions.
import { canonicalize, digest, sha256Hex, type Diagnostic, type Fix, type Module } from '@poly/core';
import type * as A from '@poly/core';
import ts from 'typescript';
import { format, parse, parseFragment, printExpr, printPattern, printStmt, type FragmentKind } from '@poly/lang';
import { EMBED_MODULE, printNode, readEmbedded } from '@poly/embed';

type Obj = Record<string, unknown>;
interface Place { node: Obj; parent: Obj | null; key: string | null; index: number | null }

/** Every node of the module by id, with where it sits. */
function places(module: Module): Map<string, Place> {
  const out = new Map<string, Place>();
  const visit = (n: unknown, parent: Obj | null, key: string | null, index: number | null): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach((x, i) => visit(x, parent, key, i)); return; }
    const o = n as Obj;
    if (typeof o.id === 'string' && typeof o.kind === 'string') out.set(o.id, { node: o, parent, key, index });
    for (const [k, v] of Object.entries(o)) {
      if (k === 'span' || k === 'id') continue;
      if (Array.isArray(v)) v.forEach((x, i) => visit(x, o, k, i));
      else visit(v, o, k, null);
    }
  };
  visit(module, null, null, null);
  return out;
}

/** Whether a statement writes a field on some path (PT4.1): an assignment, or a block that holds one. */
function writes(s: A.Stmt): boolean {
  switch (s.kind) {
    case 'Assign': case 'MapUpdate': return true;
    case 'If': return s.then.some(writes) || (s.else ?? []).some(writes);
    case 'Match': return s.arms.some((a) => a.body.some(writes));
    case 'For': return s.body.some(writes);
    default: return false;
  }
}

/** The names an expression reads. */
function namesIn(e: unknown, out = new Set<string>()): Set<string> {
  if (!e || typeof e !== 'object') return out;
  if (Array.isArray(e)) { e.forEach((x) => namesIn(x, out)); return out; }
  const o = e as Obj;
  if (o.kind === 'Name' && typeof o.name === 'string') out.add(o.name);
  for (const [k, v] of Object.entries(o)) if (k !== 'span') namesIn(v, out);
  return out;
}

const firstWrite = (body: A.Stmt[]): number => body.findIndex(writes);

/**
 * Whether a write comes before this node on its path in its handler: an earlier statement of its own block, or of
 * any enclosing block. The arms of a match are alternatives, not a sequence, so an earlier arm does not count.
 */
function writesBefore(place: Place, at: Map<string, Place>): boolean {
  let cur: Place | undefined = place;
  while (cur && cur.parent && cur.key) {
    const list = cur.parent[cur.key];
    if (Array.isArray(list) && cur.index !== null && cur.parent.kind !== 'Match' && (list as A.Stmt[]).slice(0, cur.index).some(writes)) return true;
    if (cur.parent.kind === 'Handler') return false;
    cur = at.get(cur.parent.id as string);
  }
  return false;
}

/** A proposed fix before its id: a name, a target node and an edit. */
interface Proposal { name: string; target: Obj; edit: Obj }

function propose(d: Diagnostic, module: Module, at: Map<string, Place>, machine: string | null): Proposal[] {
  const p = d.at.node ? at.get(d.at.node) : undefined;
  const node = p?.node as (A.NodeBase & Obj) | undefined;
  const replace = (name: string, target: Obj, fragment: FragmentKind, text: string): Proposal => ({ name, target, edit: { op: 'replace-node', node: target.id, fragment, with: text } });
  switch (d.code) {
    case 'PL1202':
      return node?.kind === 'Primed' ? [replace('read-pre-state', node, 'expr', node.name as string)] : [];
    case 'PL1504': {
      if (node?.kind !== 'PCtor' || !d.names?.length) return [];
      const pat = node as unknown as A.PCtor;
      const fixed: A.PCtor = { ...pat, fields: pat.fields.map((f) => (f.bind === d.names![0] ? { ...f, bind: '_' } : f)) };
      return [replace('ignore-binder', node, 'pattern', printPattern(fixed))];
    }
    case 'PL1005': {
      if (!node || !d.names?.length) return [];
      if (node.kind === 'Name') return d.names.map((o) => replace('qualify', node, 'expr', `${o}.${node.name as string}`));
      if (node.kind === 'CtorExpr') return d.names.map((o) => replace('qualify', node, 'expr', printExpr({ ...(node as unknown as A.CtorExpr), ctor: `${o}.${node.ctor as string}` })));
      return [];
    }
    case 'PL1501': {
      if (node?.kind !== 'Match') return [];
      const m = node as unknown as A.Match;
      if (m.arms.some((a) => a.pattern.kind === 'PWild')) return [];
      // A reject after a write is PL2101, so the arm is offered only where no write comes first (review D5).
      if (writesBefore(p!, at)) return [];
      const arm = { kind: 'Arm', pattern: { kind: 'PWild' }, body: [{ kind: 'Reject', reason: 'unmatched' }] } as unknown as A.Arm;
      return [replace('cover-rest', node, 'stmt', printStmt({ ...m, arms: [...m.arms, arm] }))];
    }
    case 'PL2101': {
      if (!node || !p?.parent || !p.key || p.index === null) return [];
      const list = p.parent[p.key] as A.Stmt[];
      const i = firstWrite(list);
      if (i < 0 || i >= p.index) return [];
      // Moving within the block cannot help when a write before the block also precedes it (review D6).
      if (p.parent.kind !== 'Handler' && writesBefore(at.get(p.parent.id as string)!, at)) return [];
      // The moved statement must not read a name bound between its new place and its old one.
      const bound = new Set(list.slice(i, p.index).filter((s): s is A.Let => s.kind === 'Let').map((s) => s.name));
      if ([...namesIn(node)].some((n) => bound.has(n))) return [];
      return [{ name: 'move-require', target: p.parent, edit: { op: 'move-before-first-write', block: p.parent.id, branch: p.key, node: node.id } }];
    }
    case 'PL3102':
      return domainFixes(d, module, machine);
    default:
      return [];
  }
}

/** PL3102: a require before the handler's first write, and a range wide enough for the escaped value. */
function domainFixes(d: Diagnostic, module: Module, machine: string | null): Proposal[] {
  const m = module.decls.find((x): x is A.Machine => x.kind === 'Machine' && x.name === machine);
  const field = m?.fields.find((f) => f.name === d.field);
  const last = d.witness?.trace[d.witness.trace.length - 1];
  const v = (last?.post as Obj | undefined)?.[d.field ?? ''];
  if (!m || !field || field.type.kind !== 'TRange' || typeof v !== 'number' || !last) return [];
  const { lo, hi } = field.type;
  if (v >= lo && v <= hi) return [];
  const out: Proposal[] = [{ name: 'widen-range', target: field.type as unknown as Obj, edit: { op: 'replace-node', node: field.type.id, fragment: 'type', with: `${Math.min(lo, v)}..${Math.max(hi, v)}` } }];
  const h = m.items.find((i): i is A.Handler => i.kind === 'Handler' && i.action === last.action);
  const w = h ? h.body.findIndex((s) => s.kind === 'Assign' && s.field === field.name) : -1;
  const first = h ? firstWrite(h.body) : -1;
  if (h && w >= 0 && first >= 0) {
    const e = (h.body[w] as A.Assign).expr;
    const bound = new Set(h.body.slice(first).filter((s): s is A.Let => s.kind === 'Let').map((s) => s.name));
    if (![...namesIn(e)].some((n) => bound.has(n))) {
      const cond = { kind: 'Binary', op: v > hi ? '<=' : '>=', left: e, right: { kind: 'Int', value: v > hi ? hi : lo } } as unknown as A.Expr;
      const stmt = printStmt({ kind: 'Require', cond, reason: `${field.name}-range` } as unknown as A.Stmt);
      out.unshift({ name: 'add-require', target: h as unknown as Obj, edit: { op: 'insert-before-first-write', handler: h.id, stmt } });
    }
  }
  return out;
}

/** S69: `<name>@<prefix>` of the digest of { moduleDigest, nodeId, edit }. */
export function fixId(name: string, moduleDigest: string, nodeId: string, edit: Obj): string {
  return `${name}@${sha256Hex(canonicalize({ moduleDigest, nodeId, edit })).slice(0, 12)}`;
}

/** The fixes of every diagnostic of a report (S70), computed on the module the report checked. */
export function attachFixes(diags: { d: Diagnostic; machine: string | null }[], module: Module, moduleDigest: string): void {
  const at = places(module);
  for (const { d, machine } of diags) {
    const fixes: Fix[] = propose(d, module, at, machine).map((p) => ({ id: fixId(p.name, moduleDigest, p.target.id as string, p.edit), pre: digest(p.target), edit: p.edit }));
    if (fixes.length) d.fixes = fixes;
    else delete d.fixes;
  }
}

export type FixOutcome = { status: 'applied'; text: string } | { status: 'refused'; code: 'PL0201' | 'PL0901'; message: string };

const stale = (message: string): FixOutcome => ({ status: 'refused', code: 'PL0201', message });

/** Keeps the old node wherever the replacement equals it, and the old id on every node it replaces in place. */
function graft(n: unknown, old: unknown): unknown {
  if (!n || !old || typeof n !== 'object' || typeof old !== 'object') return n;
  if (Array.isArray(n)) return Array.isArray(old) ? n.map((x, i) => graft(x, old[i])) : n;
  const o = n as Obj, p = old as Obj;
  if (o.kind !== p.kind) return n;
  if (digest(o) === digest(p)) return old;
  for (const k of Object.keys(o)) if (k !== 'id' && k !== 'span') o[k] = graft(o[k], p[k]);
  if (typeof p.id === 'string') o.id = p.id;
  return o;
}

/** Where an applied edit changed the source, in the terms an embedded splice needs (M3-3). */
type Change =
  | { op: 'replace'; span: A.Span; fragment: FragmentKind; fresh: Obj }
  | { op: 'insert'; spans: A.Span[]; i: number; stmt: A.Stmt }
  | { op: 'move'; spans: A.Span[]; i: number; j: number };

/** Applies the edit to the module in place: what changed, or a PL0201 refusal. */
function editModule(module: Module, fix: Fix): Change | FixOutcome {
  const at = places(module);
  const e = fix.edit as Obj;
  const targetId = (e.op === 'replace-node' ? e.node : e.op === 'insert-before-first-write' ? e.handler : e.block) as string;
  const t = at.get(targetId);
  if (!t) return stale(`${fix.id}: its node ${targetId} is no longer in the source`);
  if (digest(t.node) !== fix.pre) return stale(`${fix.id}: its node has changed since the fix was computed`);
  try {
    if (e.op === 'replace-node') {
      if (!t.parent || !t.key) return stale(`${fix.id}: the module itself cannot be replaced`);
      const fresh = graft(parseFragment(e.fragment as FragmentKind, e.with as string), t.node) as Obj;
      if (typeof t.node.id === 'string') fresh.id = t.node.id;
      if (t.index === null) t.parent[t.key] = fresh;
      else (t.parent[t.key] as unknown[])[t.index] = fresh;
      return { op: 'replace', span: t.node.span as A.Span, fragment: e.fragment as FragmentKind, fresh };
    }
    if (e.op === 'insert-before-first-write') {
      if (t.node.kind !== 'Handler') return stale(`${fix.id}: its node is not a handler`);
      const body = t.node.body as A.Stmt[];
      const i = firstWrite(body);
      if (i < 0) return stale(`${fix.id}: the handler no longer writes`);
      const spans = body.map((x) => x.span!);
      const stmt = parseFragment('stmt', e.stmt as string) as A.Stmt;
      body.splice(i, 0, stmt);
      return { op: 'insert', spans, i, stmt };
    }
    if (e.op === 'move-before-first-write') {
      const list = t.node[e.branch as string] as A.Stmt[] | null | undefined;
      const j = list ? list.findIndex((x) => x.id === e.node) : -1;
      const i = list ? firstWrite(list) : -1;
      if (!list || j < 0) return stale(`${fix.id}: the statement to move is no longer in its block`);
      if (i < 0 || i >= j) return stale(`${fix.id}: the statement no longer follows a write`);
      const spans = list.map((x) => x.span!);
      const [moved] = list.splice(j, 1);
      list.splice(i, 0, moved);
      return { op: 'move', spans, i, j };
    }
    return stale(`${fix.id}: unknown edit ${String(e.op)}`);
  } catch (err) {
    return stale(`${fix.id}: the edit does not parse (${(err as Error).message})`);
  }
}

/**
 * Applies one fix to a source (PT12.1): the new text, or a PL0201 refusal. The source is never half-edited.
 * A `.ts` file is an embedded module (M3-3): the edit is made on its AST as for a `.poly` file, and the
 * changed node alone is reprinted by the embedded printer and spliced in at its span, so the author's
 * formatting and comments elsewhere are kept. The result must read back as the edited AST, or the fix is refused.
 */
export function applyFix(src: string, fix: Fix, file = 'module.poly'): FixOutcome {
  const embedded = file.endsWith('.ts');
  const parsed = embedded ? readEmbedded(src, file) : parse(src);
  if (!parsed.module) return stale('the source does not parse, so no node can be found');
  const change = editModule(parsed.module, fix);
  if ('status' in change) return change;
  if (embedded) {
    let text: string;
    try {
      text = spliceEmbedded(src, file, change);
    } catch (err) {
      return stale(`${fix.id}: the edit cannot be spliced into the embedded module (${(err as Error).message})`);
    }
    const back = readEmbedded(text, file).module;
    if (!back || digest(back) !== digest(parsed.module)) return stale(`${fix.id}: the edited embedded module does not read back as the edited AST`);
    return { status: 'applied', text };
  }
  // Review C-F3: printing a module whose source holds text the parser skips (PL0901: a world, a migration) would
  // delete that text, so the fix is refused instead.
  if ((parsed as ReturnType<typeof parse>).diagnostics.some((d) => d.code === 'PL0901')) return { status: 'refused', code: 'PL0901', message: `${fix.id}: the module holds text the parser skips (PL0901), which the edited module would not print` };
  const text = format(parsed.module, (parsed as ReturnType<typeof parse>).trivia);
  if (!parse(text).module) return stale(`${fix.id}: the edited module does not print to a source that parses`);
  return { status: 'applied', text };
}

/** The offset just past whitespace and comments from `p`. */
function skipTrivia(text: string, p: number): number {
  for (;;) {
    while (p < text.length && /\s/.test(text[p])) p++;
    if (text.startsWith('//', p)) { const nl = text.indexOf('\n', p); p = nl < 0 ? text.length : nl; continue; }
    if (text.startsWith('/*', p)) { const c = text.indexOf('*/', p + 2); p = c < 0 ? text.length : c + 2; continue; }
    return p;
  }
}

/**
 * M3-3: the change spliced into the embedded text. A statement list is an array literal of calls, so a
 * statement is inserted or moved with its separating comma, and a line comment after an element stays with
 * that element. A combinator the new text calls and the file does not import is added to its import.
 */
function spliceEmbedded(src: string, file: string, change: Change): string {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const startOf = (sp: A.Span) => sf.getPositionOfLineAndCharacter(sp.line - 1, sp.col - 1);
  const endOf = (sp: A.Span) => sf.getPositionOfLineAndCharacter(sp.endLine - 1, sp.endCol - 1);
  const indentAt = (p: number) => /^[ \t]*/.exec(src.slice(src.lastIndexOf('\n', p - 1) + 1))![0];
  // The combinators the file imports, by their own name, under the name it uses.
  let named: ts.NamedImports | null = null;
  const names = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || (st.moduleSpecifier as ts.StringLiteral).text !== EMBED_MODULE) continue;
    const b = st.importClause?.namedBindings;
    if (b && ts.isNamedImports(b)) { named = b; for (const el of b.elements) names.set((el.propertyName ?? el.name).text, el.name.text); }
  }
  // The parameter of the innermost arrow around a position: the name a field is read through there (PT2.5).
  const paramAt = (p: number): string => {
    let best = '$';
    const visit = (n: ts.Node): void => {
      if (p < n.getStart(sf) || p >= n.getEnd()) return;
      if (ts.isArrowFunction(n) && n.parameters.length && ts.isIdentifier(n.parameters[0].name)) best = n.parameters[0].name.text;
      n.forEachChild(visit);
    };
    visit(sf);
    return best;
  };
  const need = new Set<string>();
  const print = (kind: FragmentKind, node: unknown, p: number, indent: string): string => {
    const r = printNode(kind, node, { indent, param: paramAt(p), names });
    for (const u of r.used) if (!names.has(u)) need.add(u);
    return r.text;
  };
  // The array literal a statement list is, from its first element.
  const arrayOf = (sp: A.Span): ts.ArrayLiteralExpression => {
    const a = startOf(sp), b = endOf(sp);
    let hit: ts.ArrayLiteralExpression | null = null;
    const visit = (n: ts.Node): void => {
      if (hit || a < n.getFullStart() || b > n.getEnd()) return;
      if (ts.isArrayLiteralExpression(n) && n.elements.some((x) => x.getStart(sf) === a && x.getEnd() === b)) { hit = n; return; }
      n.forEachChild(visit);
    };
    visit(sf);
    if (!hit) throw new Error('the statement list is not an array literal');
    return hit;
  };
  // Just past the comma after an element; where the next element's own lines begin, after a line comment.
  const afterComma = (sp: A.Span): number => { const k = skipTrivia(src, endOf(sp)); return src[k] === ',' ? k + 1 : endOf(sp); };
  const lineStart = (from: number, before: number): number => { const nl = src.indexOf('\n', from); return nl >= 0 && nl < before ? nl : from; };
  const slot = (spans: A.Span[], i: number): number => lineStart(i > 0 ? afterComma(spans[i - 1]) : arrayOf(spans[0]).elements.pos, startOf(spans[i]));
  const edits: { at: number; del: number; text: string }[] = [];
  if (change.op === 'replace') {
    const a = startOf(change.span);
    edits.push({ at: a, del: endOf(change.span) - a, text: print(change.fragment, change.fresh, a, indentAt(a)) });
  } else if (change.op === 'insert') {
    const a = startOf(change.spans[change.i]);
    const q = slot(change.spans, change.i);
    const indent = indentAt(a);
    edits.push({ at: q, del: 0, text: `${src[q] === '\n' ? '\n' + indent : ' '}${print('stmt', change.stmt, a, indent)},` });
  } else {
    const { spans, i, j } = change;
    const c = afterComma(spans[j - 1]);
    const from = lineStart(c, startOf(spans[j]));
    const end = endOf(spans[j]);
    const k = skipTrivia(src, end);
    const trailing = src[k] === ',';
    edits.push({ at: from, del: (trailing ? k + 1 : end) - from, text: '' });
    // The last element without a trailing comma leaves the comma before it behind.
    if (!trailing && src[c - 1] === ',') edits.push({ at: c - 1, del: 1, text: '' });
    edits.push({ at: slot(spans, i), del: 0, text: src.slice(from, end) + ',' });
  }
  if (need.size) {
    if (!named) throw new Error(`the file does not import ${EMBED_MODULE} by name`);
    const list = (named as ts.NamedImports).elements;
    edits.push({ at: list.length ? list[list.length - 1].getEnd() : (named as ts.NamedImports).getStart(sf) + 1, del: 0, text: `${list.length ? ', ' : ' '}${[...need].sort().join(', ')}` });
  }
  let out = src;
  for (const x of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, x.at) + x.text + out.slice(x.at + x.del);
  return out;
}
