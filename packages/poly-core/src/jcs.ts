// RFC 8785 JSON Canonicalization Scheme (PT1.4).
//
// RFC 8785 defines number and string serialisation as ECMAScript's own
// (Number.prototype.toString and JSON.stringify of a string), and object keys
// sorted by UTF-16 code units, which is the default order of Array.sort on
// strings. So in JavaScript the scheme is a short recursion. What it must not
// do is accept a value JSON cannot carry: undefined, a function, a non-finite
// number. Those throw rather than serialise to something that digests.

export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`RFC 8785: non-finite number ${String(value)}`);
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
    }
    default:
      throw new TypeError(`RFC 8785: cannot serialise a ${typeof value}`);
  }
}
