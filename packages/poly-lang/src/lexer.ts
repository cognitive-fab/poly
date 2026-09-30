// The poly lexer (PT2).
//
// Keywords are contextual (PT2.1, S3): the lexer never classifies a word as a
// keyword. Every word is an `ident` token, and the parser decides by position.
// Comments are trivia (PT1.4a): they are returned beside the tokens with their
// positions, never inside the token stream, so they cannot reach the AST.

export type TokKind = 'ident' | 'int' | 'decimal' | 'string' | 'duration' | 'punct' | 'eof';

export interface Token {
  kind: TokKind;
  /** The source text, or the decoded value for strings. */
  text: string;
  /** Integer value, for `int`. */
  value?: number;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  /** Offsets, so the parser can tell adjacent tokens apart (`a-b` as one property name). */
  start: number;
  end: number;
}

export interface Comment {
  text: string;
  line: number;
  col: number;
  /** True when code precedes the comment on its line. */
  trailing: boolean;
}

export class LexError extends Error {
  constructor(message: string, readonly line: number, readonly col: number) {
    super(message);
  }
}

// Longest first: `..` before `.`, `<=` before `<`.
const PUNCT = ['=>', '->', '<-', '..', '==', '!=', '<=', '>=', '&&', '||', '{', '}', '(', ')', '[', ']', '<', '>', '=', "'", ',', ':', '.', '!', '-', '+', '*', '/', '%', '|'];

const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c);
const isIdentPart = (c: string) => /[A-Za-z0-9_$]/.test(c);

export function lex(src: string): { tokens: Token[]; comments: Comment[] } {
  const tokens: Token[] = [];
  const comments: Comment[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  let codeOnLine = false;

  const advance = (n: number) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === '\n') { line++; col = 1; codeOnLine = false; } else col++;
      i++;
    }
  };
  const push = (kind: TokKind, text: string, startLine: number, startCol: number, start: number, value?: number) => {
    tokens.push({ kind, text, value, line: startLine, col: startCol, endLine: line, endCol: col, start, end: i });
    codeOnLine = true;
  };

  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { advance(1); continue; }
    const sl = line, sc = col, s0 = i;
    if (c === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < src.length && src[j] !== '\n') j++;
      comments.push({ text: src.slice(i + 2, j).replace(/\s+$/, ''), line: sl, col: sc, trailing: codeOnLine });
      advance(j - i);
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2);
      if (j < 0) throw new LexError('unterminated block comment', sl, sc);
      // Block comments are kept line by line as line comments, so the printer has one comment form.
      const trailing = codeOnLine;
      for (const [k, part] of src.slice(i + 2, j).split('\n').entries()) {
        const t = part.replace(/^\s*\*?\s?/, '').replace(/\s+$/, '');
        if (t || k > 0) comments.push({ text: t ? ' ' + t : '', line: sl + k, col: k === 0 ? sc : 1, trailing: k === 0 && trailing });
      }
      advance(j + 2 - i);
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      if (j < src.length && /[a-z]/.test(src[j])) {
        let k = j;
        while (k < src.length && /[a-z]/.test(src[k])) k++;
        const unit = src.slice(j, k);
        if (!['ms', 's', 'm', 'h', 'd'].includes(unit)) throw new LexError(`bad duration unit '${unit}'`, sl, sc);
        const text = src.slice(i, k);
        advance(k - i);
        push('duration', text, sl, sc, s0);
        continue;
      }
      // S76: `0.8`, at most three digits after the point, in thousandths; `0..3` stays a range.
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        let k = j + 1;
        while (k < src.length && /[0-9]/.test(src[k])) k++;
        const frac = src.slice(j + 1, k);
        if (frac.length > 3) throw new LexError(`a decimal has at most three digits after the point: ${src.slice(i, k)}`, sl, sc);
        const text = src.slice(i, k);
        const thousandths = Number(src.slice(i, j)) * 1000 + Number(frac.padEnd(3, '0'));
        if (!Number.isSafeInteger(thousandths)) throw new LexError(`decimal ${text} is out of range`, sl, sc);
        advance(k - i);
        push('decimal', text, sl, sc, s0, thousandths);
        continue;
      }
      const text = src.slice(i, j);
      const value = Number(text);
      if (!Number.isSafeInteger(value)) throw new LexError(`integer ${text} is out of range`, sl, sc);
      advance(j - i);
      push('int', text, sl, sc, s0, value);
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < src.length && isIdentPart(src[j])) j++;
      const text = src.slice(i, j);
      advance(j - i);
      push('ident', text, sl, sc, s0);
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      for (;;) {
        if (j >= src.length || src[j] === '\n') throw new LexError('unterminated string', sl, sc);
        const ch = src[j];
        if (ch === '"') break;
        if (ch === '\\') {
          const e = src[j + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };
          if (!(e in map)) throw new LexError(`bad escape \\${e}`, line, col + (j - i));
          out += map[e];
          j += 2;
          continue;
        }
        out += ch;
        j++;
      }
      advance(j + 1 - i);
      push('string', out, sl, sc, s0);
      continue;
    }
    const p = PUNCT.find((q) => src.startsWith(q, i));
    if (!p) throw new LexError(`unexpected character '${c}'`, sl, sc);
    advance(p.length);
    push('punct', p, sl, sc, s0);
  }
  tokens.push({ kind: 'eof', text: '<end of file>', line, col, endLine: line, endCol: col, start: i, end: i });
  return { tokens, comments };
}
