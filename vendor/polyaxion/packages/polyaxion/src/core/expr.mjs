// PX — the polyaxion constraint expression language.
//
// A small, total, deterministic expression language used by rules, machine
// guards, and invariants. Design rules (see spec/02-obligation-model.md):
//   - no side effects, no I/O, no clock, no randomness, no user-defined recursion;
//   - every evaluation terminates within a step budget; exceeding it is an
//     evaluation error, which the gate treats as a violation (fail closed);
//   - three-valued logic (Kleene): `null` means "unknown"; an obligation whose
//     requirement evaluates to unknown is NOT satisfied;
//   - compiled once into an AST (plain JSON) which is what gets journaled and
//     hashed — the source text is kept only for rendering.
//
// Grammar (precedence low → high):
//   ternary   cond ? a : b
//   coalesce  a ?? b
//   or        a || b
//   and       a && b
//   equality  == !=
//   compare   < <= > >= in
//   additive  + -
//   multiply  * / %
//   unary     ! -
//   postfix   a.b  a[i]  f(args)
//   primary   literal | path | ( expr ) | [list] | x => expr (only as a call arg)

const PUNCT = ['=>', '??', '||', '&&', '==', '!=', '<=', '>=', '<', '>', '+', '-', '*', '/', '%', '!', '?', ':', '(', ')', '[', ']', ',', '.'];

export class ExprError extends Error {
  constructor(message, pos) {
    super(pos === undefined ? message : `${message} (at ${pos})`);
    this.name = 'ExprError';
    this.pos = pos;
  }
}

// ---------------------------------------------------------------- tokenizer
export function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '"' || c === "'") {
      const q = c; let j = i + 1; let s = '';
      while (j < n && src[j] !== q) {
        if (src[j] === '\\' && j + 1 < n) {
          const e = src[j + 1];
          // known escapes are decoded; any other backslash sequence is kept
          // verbatim so regex classes like \s and \b survive inside strings
          s += e === 'n' ? '\n' : e === 't' ? '\t' : (e === '\\' || e === '"' || e === "'") ? e : '\\' + e;
          j += 2;
        } else { s += src[j]; j++; }
      }
      if (j >= n) throw new ExprError('unterminated string', i);
      toks.push({ t: 'str', v: s, pos: i });
      i = j + 1; continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = /^(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      toks.push({ t: 'num', v: Number(m[0]), pos: i });
      i += m[0].length; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i));
      const w = m[0];
      if (w === 'true' || w === 'false') toks.push({ t: 'bool', v: w === 'true', pos: i });
      else if (w === 'null') toks.push({ t: 'null', v: null, pos: i });
      else if (w === 'in') toks.push({ t: 'op', v: 'in', pos: i });
      else toks.push({ t: 'id', v: w, pos: i });
      i += w.length; continue;
    }
    const p = PUNCT.find((s) => src.startsWith(s, i));
    if (!p) throw new ExprError(`unexpected character '${c}'`, i);
    toks.push({ t: 'op', v: p, pos: i });
    i += p.length;
  }
  toks.push({ t: 'eof', pos: n });
  return toks;
}

// ------------------------------------------------------------------ parser
const BIN_PREC = {
  '??': 1, '||': 2, '&&': 3, '==': 4, '!=': 4,
  '<': 5, '<=': 5, '>': 5, '>=': 5, 'in': 5,
  '+': 6, '-': 6, '*': 7, '/': 7, '%': 7,
};
const MAX_DEPTH = 64;

export function parse(src) {
  if (typeof src !== 'string') throw new ExprError('expression must be a string');
  if (src.length > 4000) throw new ExprError('expression too long (max 4000 chars)');
  const toks = tokenize(src);
  let k = 0;
  const peek = () => toks[k];
  const next = () => toks[k++];
  const isOp = (v) => peek().t === 'op' && peek().v === v;
  const expect = (v) => { if (!isOp(v)) throw new ExprError(`expected '${v}'`, peek().pos); return next(); };

  function ternary(depth) {
    if (depth > MAX_DEPTH) throw new ExprError('expression nesting too deep');
    const c = binary(1, depth + 1);
    if (isOp('?')) {
      next();
      const a = ternary(depth + 1);
      expect(':');
      const b = ternary(depth + 1);
      return ['if', c, a, b];
    }
    return c;
  }
  function binary(minPrec, depth) {
    if (depth > MAX_DEPTH) throw new ExprError('expression nesting too deep');
    let left = unary(depth + 1);
    for (;;) {
      const t = peek();
      if (t.t !== 'op' || !(t.v in BIN_PREC) || BIN_PREC[t.v] < minPrec) break;
      next();
      const prec = BIN_PREC[t.v];
      // ?? is right-assoc; everything else left-assoc
      const right = binary(t.v === '??' ? prec : prec + 1, depth + 1);
      left = [t.v, left, right];
    }
    return left;
  }
  function unary(depth) {
    if (isOp('!')) { next(); return ['!', unary(depth + 1)]; }
    if (isOp('-')) { next(); return ['neg', unary(depth + 1)]; }
    return postfix(depth + 1);
  }
  function postfix(depth) {
    let e = primary(depth + 1);
    for (;;) {
      if (isOp('.')) {
        next();
        const id = next();
        if (id.t !== 'id') throw new ExprError('expected property name', id.pos);
        e = ['get', e, id.v];
      } else if (isOp('[')) {
        next();
        const idx = ternary(depth + 1);
        expect(']');
        e = ['idx', e, idx];
      } else if (isOp('(')) {
        if (e[0] !== 'path') throw new ExprError('only named functions can be called', peek().pos);
        next();
        const args = [];
        while (!isOp(')')) {
          args.push(argument(depth + 1));
          if (isOp(',')) next(); else break;
        }
        expect(')');
        e = ['call', e[1], ...args];
      } else break;
    }
    return e;
  }
  function argument(depth) {
    // lambda: id => expr
    if (peek().t === 'id' && toks[k + 1] && toks[k + 1].t === 'op' && toks[k + 1].v === '=>') {
      const id = next().v; next();
      return ['fn', id, ternary(depth + 1)];
    }
    return ternary(depth + 1);
  }
  function primary(depth) {
    const t = next();
    if (t.t === 'num' || t.t === 'str' || t.t === 'bool' || t.t === 'null') return ['lit', t.v];
    if (t.t === 'id') return ['path', t.v];
    if (t.t === 'op' && t.v === '(') { const e = ternary(depth + 1); expect(')'); return e; }
    if (t.t === 'op' && t.v === '[') {
      const items = [];
      while (!isOp(']')) { items.push(ternary(depth + 1)); if (isOp(',')) next(); else break; }
      expect(']');
      return ['list', ...items];
    }
    throw new ExprError(`unexpected token '${t.v ?? t.t}'`, t.pos);
  }

  const ast = ternary(0);
  if (peek().t !== 'eof') throw new ExprError(`unexpected token '${peek().v}'`, peek().pos);
  validate(ast);
  return ast;
}

// -------------------------------------------------------- static validation
export const FUNCS = new Set([
  'has', 'len', 'lower', 'upper', 'trim', 'startsWith', 'endsWith', 'contains', 'matches', 'glob',
  'count', 'any', 'all', 'none', 'first', 'last', 'abs', 'min', 'max', 'str', 'num', 'keys', 'values',
  'basename', 'dirname', 'normpath', 'ext', 'split', 'join', 'coalesce', 'isNull', 'typeof', 'host', 'urlpath',
]);
const REGEX_MAX = 200;

/** Reject unknown functions and unsafe regex literals at compile time. */
function validate(ast) {
  walk(ast, (node) => {
    if (node[0] === 'call') {
      if (!FUNCS.has(node[1])) throw new ExprError(`unknown function '${node[1]}'`);
      if ((node[1] === 'matches' || node[1] === 'glob') && (!node[3] || node[3][0] !== 'lit' || typeof node[3][1] !== 'string')) {
        throw new ExprError(`${node[1]}() pattern must be a literal string`);
      }
      if (node[1] === 'matches') {
        if (node[4] && (node[4][0] !== 'lit' || typeof node[4][1] !== 'string' || !/^[ims]{0,3}$/.test(node[4][1]))) throw new ExprError("matches() flags must be a literal from 'i', 'm', 's'");
        safeRegex(node[3][1], node[4] ? node[4][1] : '');
      }
    }
  });
}
function walk(node, fn) {
  if (!Array.isArray(node)) return;
  fn(node);
  for (let i = 1; i < node.length; i++) if (Array.isArray(node[i])) walk(node[i], fn);
}

const regexCache = new Map();
export function safeRegex(pattern, flags = '') {
  if (typeof pattern !== 'string') throw new ExprError('regex pattern must be a string');
  const key = flags + '/' + pattern;
  if (pattern.length > REGEX_MAX) throw new ExprError(`regex longer than ${REGEX_MAX} chars`);
  // Reject nested quantifiers — the classic catastrophic-backtracking shape.
  if (/[)\]][*+]\s*[*+?{]|\([^)]*[*+][^)]*\)[*+{]/.test(pattern)) throw new ExprError('regex with nested quantifiers rejected');
  if (/\\[1-9]/.test(pattern)) throw new ExprError('regex backreferences rejected');
  let re = regexCache.get(key);
  if (!re) {
    try { re = new RegExp(pattern, 'u' + flags); } catch (e) { throw new ExprError(`invalid regex: ${e.message}`); }
    regexCache.set(key, re);
  }
  return re;
}

// --------------------------------------------------------------- evaluator
const DEFAULT_BUDGET = 200_000;

/**
 * Evaluate an AST against an environment of root bindings.
 * Returns the value (null = unknown). Throws ExprError on budget exhaustion or
 * a hard type error; callers treat a throw as a failed obligation.
 */
export function evaluate(ast, env, opts = {}) {
  const st = { steps: 0, budget: opts.budget ?? DEFAULT_BUDGET };
  return ev(ast, env, st);
}

function ev(node, env, st) {
  if (++st.steps > st.budget) throw new ExprError('evaluation budget exhausted');
  switch (node[0]) {
    case 'lit': return node[1];
    case 'list': { const out = []; for (let i = 1; i < node.length; i++) out.push(ev(node[i], env, st)); return out; }
    case 'path': {
      if (!(node[1] in env)) throw new ExprError(`unknown name '${node[1]}'`);
      const v = env[node[1]];
      return v === undefined ? null : v;
    }
    case 'get': return member(ev(node[1], env, st), node[2]);
    case 'idx': { const o = ev(node[1], env, st); return member(o, ev(node[2], env, st)); }
    case 'if': {
      const c = ev(node[1], env, st);
      return c === true ? ev(node[2], env, st) : c === false ? ev(node[3], env, st) : null;
    }
    case '??': { const a = ev(node[1], env, st); return a === null ? ev(node[2], env, st) : a; }
    case '&&': {
      const a = truth(ev(node[1], env, st));
      if (a === false) return false;
      const b = truth(ev(node[2], env, st));
      if (b === false) return false;
      return a === true && b === true ? true : null;
    }
    case '||': {
      const a = truth(ev(node[1], env, st));
      if (a === true) return true;
      const b = truth(ev(node[2], env, st));
      if (b === true) return true;
      return a === false && b === false ? false : null;
    }
    case '!': { const a = truth(ev(node[1], env, st)); return a === null ? null : !a; }
    case 'neg': { const a = ev(node[1], env, st); return typeof a === 'number' ? -a : null; }
    case '==': return eq(ev(node[1], env, st), ev(node[2], env, st));
    case '!=': { const r = eq(ev(node[1], env, st), ev(node[2], env, st)); return r === null ? null : !r; }
    case '<': case '<=': case '>': case '>=': return cmp(node[0], ev(node[1], env, st), ev(node[2], env, st));
    case 'in': {
      const a = ev(node[1], env, st); const b = ev(node[2], env, st);
      if (a === null || b === null) return null;
      if (Array.isArray(b)) return b.some((x) => eq(a, x) === true);
      if (typeof b === 'string') return typeof a === 'string' ? b.includes(a) : null;
      if (typeof b === 'object') return typeof a === 'string' ? Object.prototype.hasOwnProperty.call(b, a) : null;
      return null;
    }
    case '+': case '-': case '*': case '/': case '%': return arith(node[0], ev(node[1], env, st), ev(node[2], env, st));
    case 'call': return call(node, env, st);
    case 'fn': throw new ExprError('lambda outside a function argument');
    default: throw new ExprError(`bad node '${node[0]}'`);
  }
}

function member(o, k) {
  if (o === null || o === undefined) return null;
  if (typeof k === 'number' && Array.isArray(o)) {
    const i = k < 0 ? o.length + k : k;
    return i >= 0 && i < o.length ? nz(o[i]) : null;
  }
  if (typeof k !== 'string') return null;
  if (typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k)) return nz(o[k]);
  return null;
}
const nz = (v) => (v === undefined ? null : v);
export function truth(v) {
  if (v === true || v === false) return v;
  return null;
}
function eq(a, b) {
  if (a === null || b === null) return null;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}
function cmp(op, a, b) {
  if (a === null || b === null) return null;
  if (typeof a !== typeof b || (typeof a !== 'number' && typeof a !== 'string')) return null;
  switch (op) {
    case '<': return a < b; case '<=': return a <= b; case '>': return a > b; default: return a >= b;
  }
}
function arith(op, a, b) {
  if (a === null || b === null) return null;
  if (op === '+' && typeof a === 'string' && typeof b === 'string') return a + b;
  if (op === '+' && Array.isArray(a) && Array.isArray(b)) return a.concat(b);
  if (typeof a !== 'number' || typeof b !== 'number') return null;
  let r;
  switch (op) {
    case '+': r = a + b; break; case '-': r = a - b; break; case '*': r = a * b; break;
    case '/': r = b === 0 ? null : a / b; break; default: r = b === 0 ? null : a % b;
  }
  return r === null || !Number.isFinite(r) ? null : r;
}

const MAX_ITER = 10_000;
function call(node, env, st) {
  const name = node[1];
  const rawArgs = node.slice(2);
  const arg = (i) => (rawArgs[i] === undefined ? null : ev(rawArgs[i], env, st));
  const lam = (i) => {
    const f = rawArgs[i];
    if (!f || f[0] !== 'fn') throw new ExprError(`${name}() needs a lambda argument`);
    return (x) => ev(f[2], { ...env, [f[1]]: x }, st);
  };
  const s = (v) => (typeof v === 'string' ? v : null);
  switch (name) {
    case 'has': {
      // has(path) — true iff the path resolves to a non-null value; never unknown.
      const p = rawArgs[0];
      if (!p) return false;
      try { return ev(p, env, st) !== null; } catch (e) { if (/budget/.test(e.message)) throw e; return false; }
    }
    case 'isNull': return arg(0) === null;
    case 'coalesce': { for (let i = 0; i < rawArgs.length; i++) { const v = arg(i); if (v !== null) return v; } return null; }
    case 'typeof': { const v = arg(0); return v === null ? 'null' : Array.isArray(v) ? 'list' : typeof v; }
    case 'len': { const v = arg(0); return typeof v === 'string' || Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : null; }
    case 'lower': { const v = s(arg(0)); return v === null ? null : v.toLowerCase(); }
    case 'upper': { const v = s(arg(0)); return v === null ? null : v.toUpperCase(); }
    case 'trim': { const v = s(arg(0)); return v === null ? null : v.trim(); }
    case 'str': { const v = arg(0); return v === null ? null : typeof v === 'string' ? v : JSON.stringify(v); }
    case 'num': { const v = arg(0); if (typeof v === 'number') return v; if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v); return null; }
    case 'abs': { const v = arg(0); return typeof v === 'number' ? Math.abs(v) : null; }
    case 'min': case 'max': {
      const first = arg(0);
      const vs = rawArgs.length === 1 && Array.isArray(first) ? first : [first, ...rawArgs.slice(1).map((_, i) => arg(i + 1))];
      if (vs.some((v) => typeof v !== 'number')) return null;
      return vs.length ? Math[name](...vs) : null;
    }
    case 'startsWith': { const a = s(arg(0)); const b = s(arg(1)); return a === null || b === null ? null : a.startsWith(b); }
    case 'endsWith': { const a = s(arg(0)); const b = s(arg(1)); return a === null || b === null ? null : a.endsWith(b); }
    case 'contains': {
      const a = arg(0); const b = arg(1);
      if (a === null || b === null) return null;
      if (typeof a === 'string') return typeof b === 'string' ? a.includes(b) : null;
      if (Array.isArray(a)) return a.some((x) => eq(x, b) === true);
      return null;
    }
    case 'matches': { const a = s(arg(0)); if (a === null) return null; return safeRegex(node[3][1], node[4] ? node[4][1] : '').test(a); }
    case 'glob': { const a = s(arg(0)); if (a === null) return null; return globMatch(normPath(a), node[3][1]); }
    case 'split': { const a = s(arg(0)); const b = s(arg(1)); return a === null || b === null ? null : a.split(b); }
    case 'join': { const a = arg(0); const b = s(arg(1)) ?? ','; return Array.isArray(a) ? a.map((x) => (x === null ? '' : String(x))).join(b) : null; }
    case 'keys': { const v = arg(0); return v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort() : null; }
    case 'values': { const v = arg(0); return v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().map((k) => nz(v[k])) : null; }
    case 'basename': { const v = s(arg(0)); return v === null ? null : normPath(v).split('/').pop(); }
    case 'dirname': { const v = s(arg(0)); if (v === null) return null; const p = normPath(v).split('/'); p.pop(); return p.join('/') || '.'; }
    case 'ext': { const v = s(arg(0)); if (v === null) return null; const b = normPath(v).split('/').pop(); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; }
    case 'normpath': { const v = s(arg(0)); return v === null ? null : normPath(v); }
    case 'host': { const v = s(arg(0)); if (v === null) return null; try { return new URL(v).hostname.toLowerCase(); } catch { return null; } }
    case 'urlpath': { const v = s(arg(0)); if (v === null) return null; try { return new URL(v).pathname; } catch { return null; } }
    case 'count': case 'any': case 'all': case 'none': case 'first': case 'last': {
      const list = arg(0);
      if (!Array.isArray(list)) return null;
      if (list.length > MAX_ITER) throw new ExprError(`list longer than ${MAX_ITER}`);
      const f = rawArgs[1] ? lam(1) : (x) => x;
      if (name === 'first') { for (const x of list) if (truth(f(x)) === true) return x; return null; }
      if (name === 'last') { for (let i = list.length - 1; i >= 0; i--) if (truth(f(list[i])) === true) return list[i]; return null; }
      let unknown = 0; let n = 0;
      for (const x of list) { const r = truth(f(x)); if (r === true) n++; else if (r === null) unknown++; }
      if (name === 'count') return unknown ? null : n;
      if (name === 'any') return n > 0 ? true : unknown ? null : false;
      if (name === 'all') return n === list.length ? true : n + unknown === list.length ? null : false;
      /* none */ return n > 0 ? false : unknown ? null : true;
    }
    default: throw new ExprError(`unknown function '${name}'`);
  }
}

export function normPath(p) {
  let s = String(p).replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(s)) s = s[0].toLowerCase() + s.slice(1);
  const abs = s.startsWith('/');
  const parts = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (parts.length && parts[parts.length - 1] !== '..') parts.pop(); else if (!abs) parts.push('..'); continue; }
    parts.push(seg);
  }
  return (abs ? '/' : '') + parts.join('/');
}

const globCache = new Map();
/** Minimal glob: `**` any depth, `*` within a segment, `?` one char. Matches whole string. */
export function globMatch(str, pattern) {
  let re = globCache.get(pattern);
  if (!re) {
    let out = '^';
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === '*') {
        if (pattern[i + 1] === '*') {
          i++;
          if (pattern[i + 1] === '/') { i++; out += '(?:.*/)?'; }
          else if (i === pattern.length - 1 && out.endsWith('/')) { out = out.slice(0, -1) + '(?:/.*)?'; } // `a/**` matches `a` too
          else out += '.*';
        } else out += '[^/]*';
      } else if (c === '?') out += '[^/]';
      else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    re = new RegExp(out + '$');
    globCache.set(pattern, re);
  }
  return re.test(str.replace(/\\/g, '/'));
}

/** Render a `get` chain back to dotted form for witnesses. */
export function renderPath(node) {
  if (node[0] === 'path') return node[1];
  if (node[0] === 'get') return `${renderPath(node[1])}.${node[2]}`;
  if (node[0] === 'idx') return `${renderPath(node[1])}[${node[2][0] === 'lit' ? JSON.stringify(node[2][1]) : '…'}]`;
  return '…';
}

/** Collect every root.path reference in an AST (for witness bindings). Lambda-bound names are excluded. */
export function references(ast) {
  const out = new Set();
  const bound = new Set();
  walk(ast, (n) => { if (n[0] === 'fn') bound.add(n[1]); });
  walk(ast, (n) => {
    if (n[0] === 'get' || n[0] === 'path') {
      const p = renderPath(n);
      if (!p.includes('…') && !bound.has(p.split('.')[0])) out.add(p);
    }
  });
  const arr = [...out];
  return arr.filter((p) => !arr.some((q) => q !== p && q.startsWith(p + '.'))).sort();
}

/** Resolve a dotted path against env; null when absent. */
export function resolvePath(env, dotted) {
  const parts = dotted.split('.');
  let cur = env[parts[0]];
  for (let i = 1; i < parts.length && cur !== null && cur !== undefined; i++) cur = member(cur, parts[i]);
  return cur === undefined ? null : cur;
}

/** Compile: parse + return {src, ast, refs}. */
export function compile(src) {
  const ast = parse(src);
  return { src, ast, refs: references(ast) };
}
