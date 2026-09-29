import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, type Module, type Expr, type Handler, type Machine, type Property } from '@poly/core';
import { parse, format } from '../src/index.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');

function polyFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...polyFiles(p));
    else if (p.endsWith('.poly')) out.push(p);
  }
  return out;
}

/** Every ```poly block of the docs that is a whole module (fragments and later-milestone forms excluded). */
function docModules(): { where: string; src: string }[] {
  const out: { where: string; src: string }[] = [];
  for (const f of ['README.md', 'docs/03-technical-spec.md']) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    let k = 0;
    for (const m of text.matchAll(/```poly\n([\s\S]*?)```/g)) {
      k++;
      let src = m[1].replace(/^ {2}/gm, (s) => (m[1].startsWith('  module') ? '' : s));
      if (src.includes('…')) continue;
      if (/^machine /.test(src)) src = 'module fragment\n\n' + src;
      if (!/^module /.test(src)) continue;
      out.push({ where: `${f} block ${k}`, src });
    }
  }
  return out;
}

function ok(src: string, where = 'source'): Module {
  const r = parse(src);
  const syntax = r.diagnostics.filter((d) => d.code === 'PL0001');
  assert.deepEqual(syntax, [], `${where}: ${syntax.map((d) => `${d.at.line}:${d.at.col} ${d.message}`).join('; ')}`);
  assert.ok(r.module, where);
  return r.module!;
}

const exprOf = (src: string): Expr => {
  const m = ok(`module t\nmachine M {\n  state { x : bool = false }\n  invariant p: ${src}\n}\n`);
  return ((m.decls[0] as Machine).items[0] as Property).expr;
};

/** Fully parenthesised rendering, to read the tree the parser built. */
function tree(e: Expr): string {
  switch (e.kind) {
    case 'Binary': return `(${tree(e.left)} ${e.op} ${tree(e.right)})`;
    case 'Unary': return `(${e.op}${tree(e.arg)})`;
    case 'Is': return `(${tree(e.expr)} is ${e.ctors.join('|')})`;
    case 'In': return `(${tree(e.expr)} in {${e.set.map(tree).join(',')}})`;
    case 'Name': return e.name;
    case 'Int': return String(e.value);
    case 'Member': return `${tree(e.object)}.${e.prop}`;
    case 'Index': return `${tree(e.object)}[${tree(e.index)}]`;
    default: return e.kind;
  }
}

test('every example and every whole module in the docs parses', () => {
  const files = polyFiles(join(ROOT, 'examples'));
  assert.ok(files.length >= 6);
  for (const f of files) ok(readFileSync(f, 'utf8'), f);
  const blocks = docModules();
  assert.ok(blocks.length >= 5, `found ${blocks.length} doc modules`);
  for (const b of blocks) ok(b.src, b.where);
});

test('PS12 precedence and associativity', () => {
  const cases: [string, string][] = [
    ['a || b && c', '(a || (b && c))'],
    ['a && b || c', '((a && b) || c)'],
    ['a implies b implies c', '(a implies (b implies c))'],
    ['a implies b || c', '(a implies (b || c))'],
    ['a == b && c != d', '((a == b) && (c != d))'],
    ['a + b * c - d', '((a + (b * c)) - d)'],
    ['a - b - c', '((a - b) - c)'],
    ['!a && b', '((!a) && b)'],
    ['-a * b', '((-a) * b)'],
    ['x is A | B && y', '((x is A|B) && y)'],
    ['x in { A, B } || y', '((x in {A,B}) || y)'],
    ['m[k] + 1 < 3', '((m[k] + 1) < 3)'],
    ['pre.x == post.x', '(pre.x == post.x)'],
    ['a < b == c', '((a < b) == c)'],
  ];
  for (const [src, want] of cases) assert.equal(tree(exprOf(src)), want, src);
});

test('levels 5 and 6 do not chain', () => {
  for (const src of ['a < b < c', 'a == b == c', 'a != b == c']) {
    const r = parse(`module t\nmachine M {\n  state { x : bool = false }\n  invariant p: ${src}\n}\n`);
    assert.equal(r.diagnostics[0]?.code, 'PL0001', src);
  }
});

test('the formatter parenthesises implies mixed with && or ||, and nothing else extra', () => {
  const p = (src: string) => {
    const m = ok(`module t\nmachine M {\n  state { x : bool = false }\n  invariant p: ${src}\n}\n`);
    return format(m).split('\n').find((l) => l.includes('invariant p:'))!.replace(/^\s*invariant p: /, '');
  };
  assert.equal(p('executed implies decisions <= 1 || approved'), 'executed implies (decisions <= 1 || approved)');
  assert.equal(p('a && b implies c'), '(a && b) implies c');
  assert.equal(p('a implies b implies c'), 'a implies b implies c');
  assert.equal(p('(a implies b) implies c'), '(a implies b) implies c');
  assert.equal(p('(a || b) && c'), '(a || b) && c');
  assert.equal(p('a || (b && c)'), 'a || b && c');
  assert.equal(p('a - (b - c)'), 'a - (b - c)');
  assert.equal(p('(a - b) - c'), 'a - b - c');
  assert.equal(p('!(x is A)'), '!(x is A)');
});

test('format is idempotent, and parse(format(x)) has the digest of x', () => {
  const sources = [...polyFiles(join(ROOT, 'examples')).map((f) => readFileSync(f, 'utf8')), ...docModules().map((b) => b.src)];
  for (const src of sources) {
    const r = parse(src);
    const once = format(r.module!, r.trivia);
    const r2 = parse(once);
    assert.equal(r2.diagnostics.filter((d) => d.code === 'PL0001').length, 0, once);
    const twice = format(r2.module!, r2.trivia);
    assert.equal(twice, once);
    assert.equal(digest(r2.module), digest(r.module));
  }
});

test('the formatter keeps every comment', () => {
  for (const f of polyFiles(join(ROOT, 'examples'))) {
    const src = readFileSync(f, 'utf8');
    const r = parse(src);
    const out = format(r.module!, r.trivia);
    const count = (s: string) => (s.match(/\/\//g) ?? []).length;
    assert.equal(count(out), count(src), f);
  }
});

test('comments and layout do not change the digest or the node ids (PT1.4a, PT12.1)', () => {
  const a = `module m\nmachine M {\n  state { x : 0..3 = 0 }\n  action Inc()\n  on Inc { require x < 3 else reject "full"  x' = x + 1 }\n}\n`;
  const b = `// a comment\nmodule m\n\nmachine M {\n  state {\n    x : 0..3 = 0   // the counter\n  }\n\n  action Inc()\n\n  on Inc {\n    // guard first\n    require x < 3 else reject "full"\n    x' = x + 1\n  }\n}\n`;
  const ma = ok(a), mb = ok(b);
  assert.equal(digest(ma), digest(mb));
  const ha = (ma.decls[0] as Machine).items[1] as Handler;
  const hb = (mb.decls[0] as Machine).items[1] as Handler;
  assert.equal(ha.id, hb.id);
  assert.equal(ha.body[1].id, hb.body[1].id);
  assert.notEqual(digest(ma), digest(ok(a.replace('x + 1', 'x + 2'))));
});

test('keywords are contextual: corpus fields named state and derived (PT2.1, S3)', () => {
  const m = ok(`module t\nmachine T {\n  state {\n    state   : Mode = LOCKED\n    derived : bool = false\n    internal : bool = true internal\n    terminal : bool = false\n  }\n  action PUSH()\n  on PUSH {\n    require state == UNLOCKED else reject "push-while-locked-is-noop"\n    state' = LOCKED\n    derived' = !derived\n  }\n}\n`);
  const fields = (m.decls[0] as Machine).fields;
  assert.deepEqual(fields.map((f) => [f.name, f.flag]), [['state', null], ['derived', null], ['internal', 'internal'], ['terminal', null]]);
  const again = ok(format(m));
  assert.equal(digest(again), digest(m));
});

test('an identifier then { opens the block in if and match (S10)', () => {
  const m = ok(`module t\nmachine M {\n  state { s : S = A }\n  action Go()\n  on Go {\n    if s == A { s' = B } else { s' = C { n: 1 } }\n    match s { A => reject "a"  _ => s' = A }\n  }\n}\n`);
  const h = (m.decls[0] as Machine).items[1] as Handler;
  assert.equal(h.body[0].kind, 'If');
  const out = format(m);
  assert.ok(out.includes("s' = C { n: 1 }"), out);
  // A constructor in a condition is printed in parentheses, and reparses the same.
  const m2 = ok(`module t\nmachine M {\n  state { s : S = A }\n  action Go()\n  on Go {\n    if s == (C { n: 1 }) { s' = A }\n  }\n}\n`);
  const out2 = format(m2);
  assert.ok(out2.includes('if s == (C { n: 1 }) {'), out2);
  assert.equal(digest(ok(out2)), digest(m2));
});

test('map literals, array literals and the reject statement parse (S4, S11)', () => {
  const m = ok(`module t\ntype Msg = M1 | M2\nmachine M {\n  state {\n    status : map<Msg, bool> = { M1: false, M2: true }\n    slots  : map<0..2, bool> = [false, false, true]\n  }\n  action Go(m: Msg)\n  on Go(m) {\n    match status[m] { _ => reject "no" }\n  }\n}\n`);
  const f = (m.decls[1] as Machine).fields;
  assert.equal(f[0].init.kind, 'MapLit');
  assert.equal(f[1].init.kind, 'ArrayLit');
});

test('syntax errors are PL0001 with a position', () => {
  for (const src of ['module', 'module m\nmachine M {', 'module m\nmachine M { state { x : = 1 } }', 'module m\nmachine M {\n  state { x : bool = "open }\n}']) {
    const r = parse(src);
    assert.equal(r.module, null);
    assert.equal(r.diagnostics[0].code, 'PL0001', src);
    assert.ok(typeof r.diagnostics[0].at.line === 'number');
  }
});

test('later-milestone top-level forms are refused with PL0901, not a syntax error', () => {
  const r = parse('module m\nconfiguration c {\n  inv : Inventory\n  bounds { transit 4 }\n}\n');
  assert.ok(r.module);
  assert.deepEqual(r.diagnostics.map((d) => d.code), ['PL0901']);
});

test('an empty then-block with an else keeps its condition', () => {
  const m = ok(`module t\nmachine M {\n  state { x : bool = false }\n  action A()\n  on A {\n    if x { } else { x' = true }\n  }\n}\n`);
  const out = format(m);
  assert.ok(out.includes('    if x {\n    } else {'), out);
  assert.equal(digest(ok(out)), digest(m));
});
