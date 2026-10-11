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

/** The text that replaces a full output in the context: the handle, the size and a head-and-tail excerpt of whole lines of bytes. */
export function handleText(id, bytes, excerptBytes = 512) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
  const head = buf.subarray(0, excerptBytes).toString('utf8');
  const tail = buf.length > 2 * excerptBytes ? buf.subarray(buf.length - excerptBytes).toString('utf8') : '';
  return `[output archived: handle=${id} size=${buf.length} bytes; fetch a range with the handle]\n${head}${tail ? `\n[... ${buf.length - 2 * excerptBytes} bytes omitted ...]\n${tail}` : ''}`;
}

/** The handles a text refers to. */
export const handlesIn = (text) => [...String(text).matchAll(/handle=([0-9a-f]{16})\b/g)].map((m) => m[1]);
