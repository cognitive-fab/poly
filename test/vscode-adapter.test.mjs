// Test the VS Code adapter (PT14): highlighting configuration for .poly files.
// PT14 specifies (a) package.json and language-configuration.json structure,
// (b) keyword sets in the grammar, (c) token rules, and (d) README and version.
// The adapter does not exist yet; tests fail at assertion time, not file load.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const ADAPTER_DIR = join(ROOT, 'adapters', 'vscode');

// Extract K exactly as PT14(b) defines it: EBNF lower-case terminals UNION parser.ts words.
function extractK() {
  const spec = readFileSync(join(ROOT, 'docs', '03-technical-spec.md'), 'utf8');
  const K = new Set();

  // EBNF blocks: lower-case quoted terminals with comments (* *) removed (non-greedy).
  const blocks = spec.match(/```ebnf\r?\n([\s\S]*?)```/g) || [];
  for (const block of blocks) {
    const content = block.replace(/```ebnf\r?\n/, '').replace(/```$/, '');
    const cleaned = content.replace(/\(\*[\s\S]*?\*\)/g, '');
    const matches = cleaned.match(/"([a-z][a-z_]*)"/g) || [];
    for (const m of matches) {
      K.add(m.slice(1, -1));
    }
  }

  // Parser.ts: at('w'), expect('w'), word('w').
  const parser = readFileSync(join(ROOT, 'packages', 'poly-lang', 'src', 'parser.ts'), 'utf8');
  const patterns = parser.match(/\b(?:at|expect|word)\(['"]([a-z][a-z_]*)['"][),]/g) || [];
  for (const p of patterns) {
    const match = /\(['"]([a-z][a-z_]*)['"]/.exec(p);
    if (match) K.add(match[1]);
  }

  // case 'w': labels.
  const caseLabels = parser.match(/\bcase\s+'([a-z][a-z_]*)':/g) || [];
  for (const c of caseLabels) {
    const match = /case\s+'([a-z][a-z_]*)'/.exec(c);
    if (match) K.add(match[1]);
  }

  // STMT_KEYWORDS from new Set([...]) literal.
  const stmtMatch = parser.match(/const STMT_KEYWORDS = new Set\(\[((?:[^[\]]*|\[[^\]]*\])*)\]\)/);
  if (stmtMatch) {
    const content = stmtMatch[1];
    const words = content.match(/'([a-z][a-z_]*)'/g) || [];
    for (const w of words) {
      K.add(w.slice(1, -1));
    }
  }

  return K;
}

// Extract E: words compared with === 'w' in parser.ts (allowed but not required).
function extractE() {
  const parser = readFileSync(join(ROOT, 'packages', 'poly-lang', 'src', 'parser.ts'), 'utf8');
  const E = new Set();
  const comparisons = parser.match(/\.text\s*===\s*'([a-z][a-z_]*)'/g) || [];
  for (const c of comparisons) {
    const match = /===\s*'([a-z][a-z_]*)'/.exec(c);
    if (match) E.add(match[1]);
  }
  return E;
}

// Walk grammar recursively to find all rules and captures.
function walkGrammar(obj, found = new Map()) {
  if (!obj || typeof obj !== 'object') return found;
  if (Array.isArray(obj)) {
    for (const item of obj) walkGrammar(item, found);
  } else {
    if (obj.name && typeof obj.name === 'string') {
      if (!found.has(obj.name)) found.set(obj.name, []);
      found.get(obj.name).push(obj);
    }
    for (const key of Object.keys(obj)) {
      if (key !== 'name') walkGrammar(obj[key], found);
    }
  }
  return found;
}

// Test that K is non-trivial.
test('PT14(b): K (keyword set) is non-trivial and includes core words', () => {
  const K = extractK();
  assert.ok(K.size > 50, `K has ${K.size} words; expected more than 50`);
  for (const word of ['module', 'machine', 'require', 'where', 'order', 'action']) {
    assert.ok(K.has(word), `K must contain '${word}'`);
  }
});

// Test (a): package.json structure and required files.
test('PT14(a): adapters/vscode/package.json structure', () => {
  const pkgPath = join(ADAPTER_DIR, 'package.json');
  assert.ok(existsSync(pkgPath), 'adapters/vscode/package.json is missing');

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  assert.ok(pkg.contributes, 'package.json must have contributes');
  assert.ok(Array.isArray(pkg.contributes.languages), 'contributes.languages must be an array');
  assert.ok(pkg.contributes.languages.length > 0, 'contributes.languages must have at least one entry');

  const lang = pkg.contributes.languages.find((l) => l.id === 'poly');
  assert.ok(lang, 'contributes.languages must have an entry with id "poly"');
  assert.ok(Array.isArray(lang.extensions) && lang.extensions.includes('.poly'), 'language must have .poly extension');
  assert.equal(lang.configuration, './language-configuration.json', 'language configuration must be ./language-configuration.json');

  assert.ok(Array.isArray(pkg.contributes.grammars), 'contributes.grammars must be an array');
  const grammar = pkg.contributes.grammars.find((g) => g.language === 'poly');
  assert.ok(grammar, 'contributes.grammars must have an entry for language "poly"');
  assert.equal(grammar.scopeName, 'source.poly', 'grammar scopeName must be source.poly');
  assert.equal(grammar.path, './syntaxes/poly.tmLanguage.json', 'grammar path must be ./syntaxes/poly.tmLanguage.json');

  // No server declarations.
  assert.ok(!pkg.main, 'package.json must not declare main');
  assert.ok(!pkg.browser, 'package.json must not declare browser');
  assert.ok(!pkg.activationEvents, 'package.json must not declare activationEvents');
  assert.ok(!pkg.mcpServers, 'package.json must not declare mcpServers');
  assert.ok(!pkg.lspServers, 'package.json must not declare lspServers');

  // Version must be 1.4.0.
  assert.equal(pkg.version, '1.4.0', 'package.json version must be 1.4.0');
});

test('PT14(a): adapters/vscode/language-configuration.json structure', () => {
  const langConfigPath = join(ADAPTER_DIR, 'language-configuration.json');
  assert.ok(existsSync(langConfigPath), 'adapters/vscode/language-configuration.json is missing');

  const config = JSON.parse(readFileSync(langConfigPath, 'utf8'));

  // Comments configuration.
  assert.ok(config.comments, 'language-configuration.json must have comments');
  assert.equal(config.comments.lineComment, '//', 'comments.lineComment must be "//"');
  assert.ok(Array.isArray(config.comments.blockComment) && config.comments.blockComment.length === 2, 'comments.blockComment must be a 2-element array');
  assert.deepEqual(config.comments.blockComment, ['/*', '*/'], 'comments.blockComment must be ["/*", "*/"]');

  // Brackets configuration: all three required.
  assert.ok(Array.isArray(config.brackets), 'language-configuration.json must have brackets');
  const bracketSet = new Set();
  for (const b of config.brackets) {
    const [open, close] = Array.isArray(b) ? b : [b.open || b[0], b.close || b[1]];
    bracketSet.add(JSON.stringify([open, close]));
  }
  assert.ok(bracketSet.has(JSON.stringify(['{', '}'])), 'brackets must include {}');
  assert.ok(bracketSet.has(JSON.stringify(['[', ']'])), 'brackets must include []');
  assert.ok(bracketSet.has(JSON.stringify(['(', ')'])), 'brackets must include ()');

  // AutoClosingPairs configuration.
  assert.ok(Array.isArray(config.autoClosingPairs), 'language-configuration.json must have autoClosingPairs');
  const pairNormalized = config.autoClosingPairs.map((p) => {
    if (Array.isArray(p)) return { open: p[0], close: p[1] };
    return p;
  });
  const opens = pairNormalized.map((p) => p.open);
  assert.ok(opens.includes('{') && opens.includes('[') && opens.includes('(') && opens.includes('"'), 'autoClosingPairs must include the four brackets and quote');
});

test('PT14(a): all files under adapters/vscode are .json or .md', () => {
  assert.ok(existsSync(ADAPTER_DIR), 'adapters/vscode directory is missing');

  const walk = (dir) => {
    const entries = readdirSync(dir);
    const files = [];
    for (const e of entries) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) {
        files.push(...walk(p));
      } else {
        files.push(p);
      }
    }
    return files;
  };

  for (const file of walk(ADAPTER_DIR)) {
    const match = /\.(json|md)$/.test(file);
    assert.ok(match, `${file} must be .json or .md`);
  }
});

test('PT14(a): scripts/check-boundaries.mjs reports no violations under adapters/vscode', () => {
  const script = join(ROOT, 'scripts', 'check-boundaries.mjs');
  assert.ok(existsSync(script), 'scripts/check-boundaries.mjs is missing');

  try {
    execFileSync(process.execPath, [script], { cwd: ROOT, encoding: 'utf8' });
  } catch (e) {
    // Exit code 1 means violations found. Check the output.
    if (e.status === 1) {
      assert.fail(`Boundary check failed: ${e.stdout || e.message}`);
    }
    throw e;
  }
});

// Test (b): grammar keywords match K and are in exactly one set.
test('PT14(b): every word of K is in exactly one of the four keyword sets', () => {
  const grammarPath = join(ADAPTER_DIR, 'syntaxes', 'poly.tmLanguage.json');
  assert.ok(existsSync(grammarPath), 'adapters/vscode/syntaxes/poly.tmLanguage.json is missing');

  const K = extractK();
  const grammar = JSON.parse(readFileSync(grammarPath, 'utf8'));
  assert.ok(grammar.repository, 'grammar must have repository');

  const leadingRule = grammar.repository['keywords-leading'];
  assert.ok(leadingRule && leadingRule.name === 'keyword.control.poly', 'repository must have keywords-leading with scope keyword.control.poly');

  const anywhereRule = grammar.repository['keywords-anywhere'];
  assert.ok(anywhereRule && anywhereRule.name === 'keyword.other.poly', 'repository must have keywords-anywhere with scope keyword.other.poly');

  const typesRule = grammar.repository.types;
  assert.ok(typesRule && typesRule.name === 'support.type.poly', 'repository must have types with scope support.type.poly');

  const constantsRule = grammar.repository.constants;
  assert.ok(constantsRule && constantsRule.name === 'constant.language.poly', 'repository must have constants with scope constant.language.poly');

  // Extract words from each set.
  const extractWords = (rule, scope) => {
    const match = rule.match;
    if (!match) return new Set();
    const group = match.match(/\(\?:([^)]+)\)/);
    if (!group) throw new Error(`${scope} match must have an alternation group`);
    return new Set(group[1].split('|').map((w) => w.trim()));
  };

  const leadingWords = extractWords(leadingRule, 'keywords-leading');
  const anywhereWords = extractWords(anywhereRule, 'keywords-anywhere');
  const typesWords = extractWords(typesRule, 'types');
  const constantsWords = extractWords(constantsRule, 'constants');

  // Check every word of K is in exactly one set.
  const missing = [];
  const duplicated = [];
  for (const word of K) {
    const counts = [leadingWords.has(word), anywhereWords.has(word), typesWords.has(word), constantsWords.has(word)].filter(Boolean).length;
    if (counts === 0) missing.push(word);
    if (counts > 1) duplicated.push(word);
  }

  assert.equal(missing.length, 0, `words missing from all four sets: ${missing.join(', ')}`);
  assert.equal(duplicated.length, 0, `words in more than one set: ${duplicated.join(', ')}`);
});

test('PT14(b): every word in the four keyword sets is in K or E', () => {
  const grammarPath = join(ADAPTER_DIR, 'syntaxes', 'poly.tmLanguage.json');
  assert.ok(existsSync(grammarPath), 'adapters/vscode/syntaxes/poly.tmLanguage.json is missing');

  const K = extractK();
  const E = extractE();
  const KE = new Set([...K, ...E]);
  const grammar = JSON.parse(readFileSync(grammarPath, 'utf8'));

  const extractWords = (rule) => {
    const match = rule.match;
    if (!match) return new Set();
    const group = match.match(/\(\?:([^)]+)\)/);
    if (!group) return new Set();
    return new Set(group[1].split('|').map((w) => w.trim()));
  };

  const leadingWords = extractWords(grammar.repository['keywords-leading']);
  const anywhereWords = extractWords(grammar.repository['keywords-anywhere']);
  const typesWords = extractWords(grammar.repository.types);
  const constantsWords = extractWords(grammar.repository.constants);

  const invented = [];
  for (const word of [...leadingWords, ...anywhereWords, ...typesWords, ...constantsWords]) {
    if (!KE.has(word)) invented.push(word);
  }

  assert.equal(invented.length, 0, `words in grammar not in K or E: ${invented.join(', ')}`);
});

test('PT14(b): contextual words are in the correct sets', () => {
  const grammarPath = join(ADAPTER_DIR, 'syntaxes', 'poly.tmLanguage.json');
  assert.ok(existsSync(grammarPath), 'adapters/vscode/syntaxes/poly.tmLanguage.json is missing');

  const K = extractK();
  const grammar = JSON.parse(readFileSync(grammarPath, 'utf8'));

  const extractWords = (rule) => {
    const match = rule.match;
    if (!match) return new Set();
    const group = match.match(/\(\?:([^)]+)\)/);
    if (!group) return new Set();
    return new Set(group[1].split('|').map((w) => w.trim()));
  };

  const leadingWords = extractWords(grammar.repository['keywords-leading']);
  const anywhereWords = extractWords(grammar.repository['keywords-anywhere']);

  // else, as, in, with, to, where, by must be in keywords-anywhere.
  for (const word of ['else', 'as', 'in', 'with', 'to', 'where', 'by']) {
    assert.ok(anywhereWords.has(word), `'${word}' must be in keywords-anywhere`);
  }

  // order, key, owner, kind, state must be in keywords-leading if in K.
  for (const word of ['order', 'key', 'owner', 'kind', 'state']) {
    if (K.has(word)) {
      assert.ok(leadingWords.has(word), `'${word}' (in K) must be in keywords-leading`);
    }
  }
});

test('PT14(b): keywords-anywhere words match in context', () => {
  const grammarPath = join(ADAPTER_DIR, 'syntaxes', 'poly.tmLanguage.json');
  assert.ok(existsSync(grammarPath), 'adapters/vscode/syntaxes/poly.tmLanguage.json is missing');

  const grammar = JSON.parse(readFileSync(grammarPath, 'utf8'));
  const match = grammar.repository['keywords-anywhere'].match;
  const re = new RegExp(match);

  // Test that else is matched in context.
  assert.ok(re.test('require x else reject "r"'), 'keywords-anywhere must match else in context');
});

test('PT14(b): keywords-leading words are coloured only at line start', () => {
  const grammarPath = join(ADAPTER_DIR, 'syntaxes', 'poly.tmLanguage.json');
  assert.ok(existsSync(grammarPath), 'adapters/vscode/syntaxes/poly.tmLanguage.json is missing');

  const grammar = JSON.parse(readFileSync(grammarPath, 'utf8'));
  const leadingRule = grammar.repository['keywords-leading'];
  assert.ok(leadingRule, 'must find keywords-leading');
  const match = leadingRule.match;
  const re = new RegExp(match);

  const extractWords = (rule) => {
    const m = rule.match;
    if (!m) return new Set();
    const group = m.match(/\(\?:([^)]+)\)/);
    if (!group) return new Set();
    return new Set(group[1].split('|').map((w) => w.trim()));
  };

  const leadingWords = extractWords(leadingRule);
  for (const word of leadingWords) {
    assert.ok(re.test(`  ${word} x`), `'${word}' must match at line start: "  ${word} x"`);
    assert.ok(!re.test(`x == ${word}`), `'${word}' must not match in middle: "x == ${word}"`);
  }
});

test('PT14(c): reference ID rule is reachable from inside line comment', () => {
  const grammarPath = join(ADAPTER_DIR, 'syntaxes', 'poly.tmLanguage.json');
  assert.ok(existsSync(grammarPath), 'adapters/vscode/syntaxes/poly.tmLanguage.json is missing');

  const grammar = JSON.parse(readFileSync(grammarPath, 'utf8'));

  // Check that constant.other.reference.poly is reachable from comment.line.double-slash.poly.
  // Build a set of keys reachable from the line comment rule via includes.
  const reachable = (ruleName, visited = new Set()) => {
    if (visited.has(ruleName)) return new Set();
    visited.add(ruleName);
    const result = new Set([ruleName]);

    const rule = grammar.repository[ruleName];
    if (!rule) return result;

    const walkPatterns = (patterns) => {
      if (!Array.isArray(patterns)) return;
      for (const p of patterns) {
        if (p.include) {
          const includeName = p.include.replace(/^#/, '');
          for (const r of reachable(includeName, visited)) {
            result.add(r);
          }
        }
      }
    };

    walkPatterns(rule.patterns);
    if (rule.captures) {
      for (const cap of Object.values(rule.captures)) {
        walkPatterns(cap.patterns);
      }
    }

    return result;
  };

  const fromLineComment = reachable('comment.line.double-slash.poly');
  assert.ok(fromLineComment.has('constant.other.reference.poly'), 'constant.other.reference.poly must be reachable from inside comment.line.double-slash.poly via includes or patterns');
});

// Test (c): token rules compile and work correctly.
test('PT14(c): every match, begin and end in the grammar compiles as JS RegExp', () => {
  const grammarPath = join(ADAPTER_DIR, 'syntaxes', 'poly.tmLanguage.json');
  assert.ok(existsSync(grammarPath), 'adapters/vscode/syntaxes/poly.tmLanguage.json is missing');

  const grammar = JSON.parse(readFileSync(grammarPath, 'utf8'));
  const rules = walkGrammar(grammar);

  let count = 0;
  for (const [name, ruleList] of rules) {
    for (const rule of ruleList) {
      if (rule.match) {
        count++;
        try {
          new RegExp(rule.match);
        } catch (e) {
          assert.fail(`Rule ${name} match does not compile as JS RegExp: ${rule.match} - ${e.message}`);
        }
      }
      if (rule.begin) {
        count++;
        try {
          new RegExp(rule.begin);
        } catch (e) {
          assert.fail(`Rule ${name} begin does not compile as JS RegExp: ${rule.begin} - ${e.message}`);
        }
      }
      if (rule.end) {
        count++;
        try {
          new RegExp(rule.end);
        } catch (e) {
          assert.fail(`Rule ${name} end does not compile as JS RegExp: ${rule.end} - ${e.message}`);
        }
      }
    }
  }

  assert.ok(count > 0, 'found and compiled at least one regex in the grammar');
});

test('PT14(c): duration rule matches whole tokens correctly', () => {
  const grammarPath = join(ADAPTER_DIR, 'syntaxes', 'poly.tmLanguage.json');
  assert.ok(existsSync(grammarPath), 'adapters/vscode/syntaxes/poly.tmLanguage.json is missing');

  const grammar = JSON.parse(readFileSync(grammarPath, 'utf8'));
  const rules = walkGrammar(grammar);

  const durationRules = Array.from(rules.get('constant.numeric.duration.poly') || []);
  assert.ok(durationRules.length > 0, 'must find a rule with name constant.numeric.duration.poly');

  let found = false;
  for (const rule of durationRules) {
    if (!rule.match) continue;
    const re = new RegExp(`^(?:${rule.match})$`);
    if (re.test('200ms') && re.test('10s') && re.test('5m') && re.test('168h') && re.test('2d')) {
      assert.ok(!re.test('5y'), '5y must not match');
      assert.ok(!re.test('10sec'), '10sec must not match');
      found = true;
    }
  }

  assert.ok(found, 'duration rule must match 200ms, 10s, 5m, 168h, 2d but not 5y or 10sec');
});

test('PT14(c): escape sequence rule matches whole tokens correctly', () => {
  const grammarPath = join(ADAPTER_DIR, 'syntaxes', 'poly.tmLanguage.json');
  assert.ok(existsSync(grammarPath), 'adapters/vscode/syntaxes/poly.tmLanguage.json is missing');

  const grammar = JSON.parse(readFileSync(grammarPath, 'utf8'));
  const rules = walkGrammar(grammar);

  const escapeRules = Array.from(rules.get('constant.character.escape.poly') || []);
  assert.ok(escapeRules.length > 0, 'must find a rule with name constant.character.escape.poly');

  let found = false;
  for (const rule of escapeRules) {
    if (!rule.match) continue;
    const re = new RegExp(`^(?:${rule.match})$`);
    if (re.test('\\n') && re.test('\\t') && re.test('\\r') && re.test('\\"') && re.test('\\\\')) {
      assert.ok(!re.test('\\x'), '\\x must not match');
      assert.ok(!re.test('\\u'), '\\u must not match');
      found = true;
    }
  }

  assert.ok(found, 'escape rule must match \\n, \\t, \\r, \\", \\\\ but not \\x or \\u');
});

test('PT14(c): string rule begins and ends with double quote', () => {
  const grammarPath = join(ADAPTER_DIR, 'syntaxes', 'poly.tmLanguage.json');
  assert.ok(existsSync(grammarPath), 'adapters/vscode/syntaxes/poly.tmLanguage.json is missing');

  const grammar = JSON.parse(readFileSync(grammarPath, 'utf8'));
  const rules = walkGrammar(grammar);

  const stringRules = Array.from(rules.get('string.quoted.double.poly') || []);
  assert.ok(stringRules.length > 0, 'must find a rule with name string.quoted.double.poly');

  let found = false;
  for (const rule of stringRules) {
    if (rule.begin === '"' && rule.end === '"') {
      found = true;
      break;
    }
  }

  assert.ok(found, 'string rule must begin and end with "');
});

test('PT14(c): comment rules exist with reference ID support', () => {
  const grammarPath = join(ADAPTER_DIR, 'syntaxes', 'poly.tmLanguage.json');
  assert.ok(existsSync(grammarPath), 'adapters/vscode/syntaxes/poly.tmLanguage.json is missing');

  const grammar = JSON.parse(readFileSync(grammarPath, 'utf8'));
  const rules = walkGrammar(grammar);

  // Line comment rule.
  const lineCommentRules = Array.from(rules.get('comment.line.double-slash.poly') || []);
  assert.ok(lineCommentRules.length > 0, 'must find comment.line.double-slash.poly');
  const lineComment = lineCommentRules[0];
  const lineBegin = lineComment.begin || lineComment.match;
  assert.ok(lineBegin && lineBegin.includes('/'), 'line comment must include /');

  // Block comment rule.
  const blockCommentRules = Array.from(rules.get('comment.block.poly') || []);
  assert.ok(blockCommentRules.length > 0, 'must find comment.block.poly');
  const blockComment = blockCommentRules[0];
  assert.ok(blockComment.begin && blockComment.begin.includes('\\*'), 'block comment must begin with /\\*');
  assert.ok(blockComment.end && blockComment.end.includes('\\*'), 'block comment must end with \\*/');

  // Reference ID rule must exist and match.
  const refRules = Array.from(rules.get('constant.other.reference.poly') || []);
  assert.ok(refRules.length > 0, 'must find constant.other.reference.poly');
  const refRule = refRules[0];
  const refMatch = refRule.match;
  const refRe = new RegExp(`^(?:${refMatch})$`);
  assert.ok(refRe.test('PS23.4'), 'reference rule must match PS23.4');
  assert.ok(refRe.test('PL4003'), 'reference rule must match PL4003');
  assert.ok(refRe.test('S119'), 'reference rule must match S119');
  assert.ok(refRe.test('AC10'), 'reference rule must match AC10');
});

test('PT14(c): rules for type names and primed fields', () => {
  const grammarPath = join(ADAPTER_DIR, 'syntaxes', 'poly.tmLanguage.json');
  assert.ok(existsSync(grammarPath), 'adapters/vscode/syntaxes/poly.tmLanguage.json is missing');

  const grammar = JSON.parse(readFileSync(grammarPath, 'utf8'));
  const rules = walkGrammar(grammar);

  const typeRules = Array.from(rules.get('entity.name.type.poly') || []);
  assert.ok(typeRules.length > 0, 'must find entity.name.type.poly');
  const typeRe = new RegExp(typeRules[0].match);
  assert.ok(typeRe.test('Status'), 'type rule must match capitalized words');

  const primedRules = Array.from(rules.get('variable.other.primed.poly') || []);
  assert.ok(primedRules.length > 0, 'must find variable.other.primed.poly');
  const primedRe = new RegExp(primedRules[0].match);
  assert.ok(primedRe.test('phase\''), 'primed rule must match phase\'');
});

test('PT14(c): numeric rules for decimals and integers', () => {
  const grammarPath = join(ADAPTER_DIR, 'syntaxes', 'poly.tmLanguage.json');
  assert.ok(existsSync(grammarPath), 'adapters/vscode/syntaxes/poly.tmLanguage.json is missing');

  const grammar = JSON.parse(readFileSync(grammarPath, 'utf8'));
  const rules = walkGrammar(grammar);

  const numRules = Array.from(rules.get('constant.numeric.poly') || []);
  assert.ok(numRules.length > 0, 'must find constant.numeric.poly');
  const numRe = new RegExp(numRules[0].match);
  assert.ok(numRe.test('0.8'), 'numeric rule must match 0.8');
  assert.ok(numRe.test('42'), 'numeric rule must match 42');
});

// Test (d): README and version.
test('PT14(d): adapters/vscode/README.md exists and describes installation', () => {
  const readmePath = join(ADAPTER_DIR, 'README.md');
  assert.ok(existsSync(readmePath), 'adapters/vscode/README.md is missing');

  const readme = readFileSync(readmePath, 'utf8');
  const hasExtensionsPath = readme.includes('.vscode/extensions') || readme.includes('.vscode\\extensions');
  assert.ok(hasExtensionsPath, 'README must mention .vscode/extensions or .vscode\\extensions');
});

test('PT14(d): adapters/vscode/README.md ends with Glossary heading', () => {
  const readmePath = join(ADAPTER_DIR, 'README.md');
  assert.ok(existsSync(readmePath), 'adapters/vscode/README.md is missing');

  const readme = readFileSync(readmePath, 'utf8');
  const headings = readme.match(/^##\s+(.+?)$/gm) || [];
  const lastHeading = headings[headings.length - 1];
  assert.ok(lastHeading, 'README must have at least one ## heading');
  const lastHeadingText = lastHeading.replace(/^##\s+/, '').trim();
  assert.equal(lastHeadingText, 'Glossary', 'Last ## heading must be Glossary');
});
