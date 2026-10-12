// plan-e3.md E3.3, HF2.4, HF3.3: the archive of large tool outputs, and the handle that stands for one in the context.
// An output over the threshold is archived and sent in full for two requests, then replaced by a handle, its size and a
// head-and-tail excerpt. The agent can fetch any exact range through the handle. The Archive machine of harness.poly
// proves that a handle is issued only after the archive holds the output and that it resolves while a reference
// counts; this file is the store behind it, kept in memory here and on disk in the host (E3.4).
import { createHash } from 'node:crypto';

export class ArchiveStore {
  #items = new Map();

  /** Archives bytes. The handle is the hash's first 16 hex digits; the same bytes are one item with one more reference. */
  put(bytes) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
    const id = createHash('sha256').update(buf).digest('hex').slice(0, 16);
    const have = this.#items.get(id);
    if (have) {
      have.refs += 1;
      return id;
    }
    this.#items.set(id, { buf: Buffer.from(buf), refs: 1 });
    return id;
  }

  /** The exact bytes of a range [start, end) of an item that has a reference, or an error: a handle always resolves. */
  get(id, start = 0, end = undefined) {
    const it = this.#items.get(id);
    if (!it || it.refs <= 0) throw Object.assign(new Error(`the handle ${id} resolves to nothing`), { permanent: true });
    const to = end === undefined ? it.buf.length : end;
    if (!Number.isInteger(start) || !Number.isInteger(to) || start < 0 || to < start || to > it.buf.length) throw Object.assign(new Error(`the range [${start}, ${to}) is outside the ${it.buf.length} archived bytes`), { permanent: true });
    return Buffer.from(it.buf.subarray(start, to));
  }

  size(id) {
    const it = this.#items.get(id);
    return it && it.refs > 0 ? it.buf.length : null;
  }

  refs(id) {
    return this.#items.get(id)?.refs ?? 0;
  }

  /** A context that refers to the handle holds one reference. */
  retain(id) {
    const it = this.#items.get(id);
    if (!it || it.refs <= 0) throw Object.assign(new Error(`the handle ${id} cannot be retained: it is gone`), { permanent: true });
    it.refs += 1;
  }

  /** A reference released. The item goes when the last one does, and not before. */
  release(id) {
    const it = this.#items.get(id);
    if (!it || it.refs <= 0) throw Object.assign(new Error(`the handle ${id} was released more often than it was held`), { permanent: true });
    it.refs -= 1;
    if (it.refs === 0) this.#items.delete(id);
  }
}

/**
 * The text that replaces a full output in the context: the handle, the original size and a head-and-tail excerpt of
 * complete lines (SoL-Pi: "a short excerpt of complete head and tail lines"), each side within `excerptBytes`. A single line
 * longer than the budget is cut at the budget, since there is no complete line to give.
 */
export function handleText(id, bytes, excerptBytes = 512) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
  const lines = buf.toString('utf8').split('\n');
  const size = (l) => Buffer.byteLength(l, 'utf8') + 1;
  let head = [];
  let used = 0;
  for (const l of lines) {
    if (used + size(l) > excerptBytes) break;
    head.push(l);
    used += size(l);
  }
  let tail = [];
  used = 0;
  for (let i = lines.length - 1; i >= head.length; i--) {
    if (used + size(lines[i]) > excerptBytes) break;
    tail.unshift(lines[i]);
    used += size(lines[i]);
  }
  const headText = head.length ? head.join('\n') : buf.subarray(0, excerptBytes).toString('utf8');
  const tailText = tail.length ? tail.join('\n') : (head.length < lines.length ? buf.subarray(Math.max(buf.length - excerptBytes, 0)).toString('utf8') : '');
  const omitted = buf.length - Buffer.byteLength(headText, 'utf8') - Buffer.byteLength(tailText, 'utf8');
  const gap = omitted > 0 && tailText ? `\n[... ${omitted} bytes omitted ...]\n` : omitted > 0 ? `\n[... ${omitted} bytes omitted ...]` : '\n';
  return `[output archived: handle=${id} size=${buf.length} bytes; fetch a range with the handle]\n${headText}${gap}${tailText}`;
}

/** The handles a text refers to. */
export const handlesIn = (text) => [...String(text).matchAll(/handle=([0-9a-f]{16})\b/g)].map((m) => m[1]);
