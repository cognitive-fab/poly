// PT2, PT33.12 (ruled 2026-10-14): `retry { attempts 1 }` is a whole clause. A missing base is 500ms and a missing timeout is 30s
// (S137), written out by the parser, on the poly surface and on the embedded one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse, format } from '@poly/lang';
import { readEmbedded } from '@poly/embed';
import { checkFile } from '@poly/check';
import { ROOT, BUILD, build } from './helpers.mjs';

const OUT = join(BUILD, 's526-retry-short');
const BASE = readFileSync(join(ROOT, 'test', 'fixtures', 's526', 'rule', 'base.poly'), 'utf8');
/** The base program with `clause` as its only retry. */
const withRetry = (clause) => BASE.replace('    class irreversible\n', `    class irreversible\n    ${clause}\n`);
const retries = (module) => module.decls.flatMap((d) => d.items ?? []).flatMap((i) => (i.kind === 'EffectDecl' ? i.items : [])).filter((i) => i.kind === 'EffRetry');

test('CONTROL: the base program declares no retry, so withRetry adds the only one', () => {
  assert.equal(retries(parse(BASE).module).length, 0);
  assert.equal(retries(parse(withRetry('retry { attempts 1, base 500ms, timeout 30s }')).module).length, 1);
});

test('PT2: retry { attempts 1 } parses, with base 500ms and timeout 30s', () => {
  const r = parse(withRetry('retry { attempts 1 }'));
  assert.deepEqual(r.diagnostics, []);
  const [x] = retries(r.module);
  assert.deepEqual([x.attempts, x.base, x.timeout], [1, '500ms', '30s']);
});

test('PT2: retry { attempts 2, base 100ms } takes the default timeout; attempts and timeout alone take the default base', () => {
  const a = parse(withRetry('retry { attempts 2, base 100ms }'));
  assert.deepEqual(a.diagnostics, []);
  assert.deepEqual([retries(a.module)[0].base, retries(a.module)[0].timeout], ['100ms', '30s']);
  const b = parse(withRetry('retry { attempts 2, timeout 5s }'));
  assert.deepEqual(b.diagnostics, []);
  assert.deepEqual([retries(b.module)[0].base, retries(b.module)[0].timeout], ['500ms', '5s']);
});

test('PT2: the short and the full clause are one clause (same formatted text)', () => {
  const short = format(parse(withRetry('retry { attempts 1 }')).module);
  const full = format(parse(withRetry('retry { attempts 1, base 500ms, timeout 30s }')).module);
  assert.equal(short, full);
});

test('PT2: attempts still comes first, and base before timeout', () => {
  assert.notDeepEqual(parse(withRetry('retry { base 1s }')).diagnostics, []);
  assert.notDeepEqual(parse(withRetry('retry { attempts 2, timeout 5s, base 1s }')).diagnostics, []);
});

test('PT2, S137: a program with the short clause is CLEAN and its manifest has the written-out defaults', async () => {
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, 'short.poly');
  writeFileSync(file, withRetry('retry { attempts 1 }').replace('module s526base', 'module s526short'));
  const r = await checkFile(file, { root: OUT });
  assert.equal(r.verdict, 'CLEAN');
  const [b] = build(file, 's526-retry-short-build');
  const entry = JSON.parse(readFileSync(join(b.dir, 'effects.manifest.json'), 'utf8')).effects['s526.work'];
  assert.deepEqual(entry.retry, { maxAttempts: 1, baseMs: 500, timeoutMs: 30000 });
});

test('PT2.5: the embedded surface takes retry(n) and retry(n, base) with the same defaults', () => {
  const src = readFileSync(join(ROOT, 'conformance', 'm2', 'embed', 'orders.ts'), 'utf8');
  assert.ok(src.includes("retry(3, '200ms', '5s')"), 'sanity: the embedded orders declares that retry');
  const one = readEmbedded(src.replace("retry(3, '200ms', '5s')", 'retry(1)'), 'orders.ts');
  assert.ok(one.module, JSON.stringify(one.diagnostics ?? one.error));
  const [a] = retries(one.module);
  assert.deepEqual([a.attempts, a.base, a.timeout], [1, '500ms', '30s']);
  const two = readEmbedded(src.replace("retry(3, '200ms', '5s')", "retry(2, '100ms')"), 'orders.ts');
  const [b] = retries(two.module);
  assert.deepEqual([b.attempts, b.base, b.timeout], [2, '100ms', '30s']);
});
