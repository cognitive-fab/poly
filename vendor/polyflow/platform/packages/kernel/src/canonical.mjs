// Canonical JSON — the one encoding everything hashed or signed goes through.
//
// Two implementations (this one and the Python port) must produce the same
// bytes for the same value, or a ledger written by a Python worker cannot be
// verified by a TypeScript one. So the rules are few and strict, and anything
// that has no single obvious encoding is refused rather than guessed:
//
//   - object keys NFC-normalised, then sorted by UTF-16 code unit (JS default
//     sort; Python sorts by code point, which differs above U+FFFF — the port
//     sorts by UTF-16); two keys that normalise alike are refused
//   - no whitespace
//   - numbers: finite only; -0 becomes 0; printed as ECMAScript
//     Number::toString prints them, which is RFC 8785 (JCS) — 1e-7, 1e+21,
//     0.00001, 123456789012345680000. Python's repr differs; the port must
//     implement JCS number formatting, pinned by conformance/canonical.json
//   - `undefined` object fields are dropped; `undefined` in an array is refused
//   - strings NFC-normalised, escaped as JSON.stringify does (RFC 8785: only
//     the mandatory escapes; non-ASCII is emitted as UTF-8, not \u-escaped)
//   - no functions, symbols, bigints, Dates, Maps, class instances
//
// Pure: runs inside the Temporal workflow isolate, which has no Node built-ins.

export class CanonicalError extends Error {
  constructor(message, path) {
    super(`${message} at ${path || '$'}`);
    this.name = 'CanonicalError';
    this.path = path;
  }
}

const isPlainObject = (v) => {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

function encode(value, path) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalError(`non-finite number ${value}`, path);
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'string':
      return JSON.stringify(value.normalize('NFC'));
    case 'object': {
      if (Array.isArray(value)) {
        const parts = [];
        for (let i = 0; i < value.length; i++) {
          if (value[i] === undefined) throw new CanonicalError('undefined in array', `${path}[${i}]`);
          parts.push(encode(value[i], `${path}[${i}]`));
        }
        return `[${parts.join(',')}]`;
      }
      if (!isPlainObject(value)) {
        throw new CanonicalError(`not a plain object (${value?.constructor?.name ?? 'unknown'})`, path);
      }
      // Normalise FIRST, then refuse collisions, then sort what will be emitted:
      // sorting raw keys and emitting normalised ones produces unsorted text,
      // and two spellings of one key would emit a duplicate member name.
      const entries = new Map();
      for (const k of Object.keys(value)) {
        if (value[k] === undefined) continue;
        const nk = k.normalize('NFC');
        if (entries.has(nk)) throw new CanonicalError(`two keys normalise to ${JSON.stringify(nk)}`, path);
        entries.set(nk, k);
      }
      const parts = [...entries.keys()].sort().map((nk) => `${JSON.stringify(nk)}:${encode(value[entries.get(nk)], `${path}.${nk}`)}`);
      return `{${parts.join(',')}}`;
    }
    default:
      throw new CanonicalError(`unsupported type ${typeof value}`, path);
  }
}

/** The canonical JSON text of `value`. Throws CanonicalError on anything ambiguous. */
export function canonical(value) {
  return encode(value, '');
}

/** Parse and re-encode: a value survives a canonical round trip or it was never canonical. */
export function isCanonical(text) {
  try { return canonical(JSON.parse(text)) === text; } catch { return false; }
}
