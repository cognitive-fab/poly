// plan-ex.md E2.0: a MIME reader for received mail (RFC 5322, RFC 2045 to RFC 2047, RFC 2231's parameter form). It
// turns a message's bytes into the text a decision reads: Gmail's `raw`, and after v1 an SES object in S3. Mail is
// untrusted input (IF3.3), so the reader never throws on what a sender writes: it bounds how deep and how many parts it
// reads, takes the inline text and lists attachments without reading them, and names each problem it met. No npm
// package enters poly (S182), so it is written here, against the RFCs only.

/** A name and an address; the address in lower case, since mail compares it so in practice (RFC 5321 section 2.4 aside). */
export interface MailAddress { name: string; address: string }

export interface MailAttachment { filename: string; type: string; size: number }

export interface Mail {
  /** Every header, unfolded and decoded, in order, with its name in lower case. */
  headers: [string, string][];
  from: MailAddress | null;
  to: MailAddress[];
  subject: string;
  /** The Date header in milliseconds, or null when absent or unreadable. */
  date: number | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  /** The inline text, LF line ends; from HTML when the message has no text/plain part. */
  text: string;
  fromHtml: boolean;
  attachments: MailAttachment[];
  /** What the reader met and could not take as written: `depth`, `parts`, `no-boundary`, `charset:<name>`, `encoding:<name>`. */
  problems: string[];
}

/** The deepest multipart nesting read, and the most parts read in all; a sender can write more, never make us read more. */
export const MIME_LIMITS = { depth: 8, parts: 200 } as const;

interface Part { headers: [string, string][]; body: string }

/** Bytes as a binary string, one char per byte, so boundaries and encodings are found before any charset applies. */
const binary = (raw: Uint8Array | string): string => Buffer.from(typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw).toString('latin1');
const bytesOf = (s: string): Buffer => Buffer.from(s, 'latin1');

function decodeCharset(bytes: Buffer, charset: string, problems: Set<string>): string {
  const label = charset.trim().toLowerCase() || 'us-ascii';
  try {
    return new TextDecoder(label === 'us-ascii' || label === 'ascii' ? 'utf-8' : label, { fatal: false }).decode(bytes);
  } catch {
    problems.add(`charset:${label}`);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

function splitHead(s: string): { head: string; body: string } {
  const m = /\r?\n\r?\n/.exec(s);
  if (!m) return { head: s, body: '' };
  return { head: s.slice(0, m.index), body: s.slice(m.index + m[0].length) };
}

/** RFC 5322 section 2.2.3: a line that begins with a space or a tab continues the header before it. */
function headersOf(head: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1][1] += line;
    else {
      const i = line.indexOf(':');
      if (i > 0 && /^[!-9;-~]+$/.test(line.slice(0, i))) out.push([line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()]);
    }
  }
  // Unfolding keeps the folding white space; a run of it reads as one space.
  return out.map(([n, v]): [string, string] => [n, v.replace(/[ \t]+/g, ' ').trim()]);
}

const header = (hs: [string, string][], name: string): string | null => hs.find(([n]) => n === name)?.[1] ?? null;

/** RFC 2047: encoded words, B or Q; whitespace between two adjacent encoded words is dropped (section 6.2). */
function decodeWords(v: string, problems: Set<string>): string {
  const word = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;
  const joined = v.replace(/(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)/g, '$1');
  const text = joined.replace(word, (_, cs: string, enc: string, data: string) => {
    const charset = cs.split('*')[0];
    const bytes = enc.toLowerCase() === 'b'
      ? Buffer.from(data, 'base64')
      : bytesOf(data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))));
    return decodeCharset(bytes, charset, problems);
  });
  // A header holds no raw 8-bit text by RFC 5322; one that does is read as UTF-8, as most senders mean it.
  return /[\x80-\xff]/.test(text) && !/=\?/.test(v) ? decodeCharset(bytesOf(text), 'utf-8', problems) : text;
}

/** A Content-Type or Content-Disposition value: its main token and its parameters, quoted or RFC 2231 encoded. */
function params(v: string | null): { value: string; p: Record<string, string> } {
  if (!v) return { value: '', p: {} };
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === '"' && v[i - 1] !== '\\') quoted = !quoted;
    if (c === ';' && !quoted) { parts.push(cur); cur = ''; } else cur += c;
  }
  parts.push(cur);
  const p: Record<string, string> = {};
  for (const x of parts.slice(1)) {
    const i = x.indexOf('=');
    if (i < 0) continue;
    const k = x.slice(0, i).trim().toLowerCase();
    let val = x.slice(i + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1).replace(/\\(.)/g, '$1');
    if (k.endsWith('*')) {
      const m = /^([^']*)'[^']*'(.*)$/.exec(val);
      const bytes = bytesOf((m ? m[2] : val).replace(/%([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))));
      p[k.slice(0, -1)] = decodeCharset(bytes, m?.[1] || 'utf-8', new Set());
    } else p[k] = val;
  }
  return { value: parts[0].trim().toLowerCase(), p };
}

function transferDecode(body: string, encoding: string, problems: Set<string>): Buffer {
  const e = encoding.trim().toLowerCase();
  if (e === 'base64') return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (e === 'quoted-printable') {
    // RFC 2045 section 6.7: `=` at a line's end is a soft break; `=XX` is one byte.
    return bytesOf(body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))));
  }
  if (e && !['7bit', '8bit', 'binary'].includes(e)) problems.add(`encoding:${e}`);
  return bytesOf(body);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** HTML to text, for a message with no text/plain part: no script or style, block ends as line ends, no tags. */
function htmlText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

const tidy = (s: string): string => s.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/** Splits a multipart body on its boundary (RFC 2046 section 5.1.1); the preamble and the epilogue are not parts. */
function splitParts(body: string, boundary: string): string[] {
  const lines = body.split(/\r?\n/);
  const parts: string[] = [];
  let cur: string[] | null = null;
  for (const line of lines) {
    const t = line.replace(/[ \t]+$/, '');
    if (t === `--${boundary}--`) { if (cur) parts.push(cur.join('\r\n')); cur = null; break; }
    if (t === `--${boundary}`) { if (cur) parts.push(cur.join('\r\n')); cur = []; continue; }
    if (cur) cur.push(line);
  }
  if (cur) parts.push(cur.join('\r\n'));
  return parts;
}

function addressList(v: string | null): MailAddress[] {
  if (!v) return [];
  const items: string[] = [];
  let cur = '';
  let quoted = false;
  let angle = 0;
  for (const c of v) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === '<') angle++;
    else if (!quoted && c === '>') angle = Math.max(0, angle - 1);
    if (c === ',' && !quoted && angle === 0) { items.push(cur); cur = ''; } else cur += c;
  }
  items.push(cur);
  const out: MailAddress[] = [];
  for (const it of items) {
    const s = it.trim();
    if (!s) continue;
    const m = /^(.*?)<([^<>]*)>\s*$/.exec(s);
    const address = (m ? m[2] : s).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) continue;
    const name = m ? m[1].trim().replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1') : '';
    out.push({ name, address });
  }
  return out;
}

/** Reads a received message. Never throws on its content. */
export function readMime(raw: Uint8Array | string): Mail {
  const problems = new Set<string>();
  const top = splitHead(binary(raw));
  const rawHeaders = headersOf(top.head);
  const headers: [string, string][] = rawHeaders.map(([n, v]) => [n, decodeWords(v, problems)]);
  const texts: string[] = [];
  const htmls: string[] = [];
  const attachments: MailAttachment[] = [];
  let parts = 0;

  const walk = (p: Part, depth: number): void => {
    if (++parts > MIME_LIMITS.parts) { problems.add('parts'); return; }
    const ct = params(header(p.headers, 'content-type'));
    const type = ct.value || 'text/plain';
    const disp = params(header(p.headers, 'content-disposition'));
    if (type.startsWith('multipart/')) {
      if (depth >= MIME_LIMITS.depth) { problems.add('depth'); return; }
      const boundary = ct.p.boundary;
      if (!boundary) { problems.add('no-boundary'); texts.push(decodeCharset(bytesOf(p.body), 'utf-8', problems)); return; }
      const children = splitParts(p.body, boundary).map((c) => { const s = splitHead(c); return { headers: headersOf(s.head), body: s.body }; });
      if (type === 'multipart/alternative') {
        // RFC 2046 section 5.1.4: the parts are versions of one content; the plain one is taken when there is one.
        const plain = children.find((c) => (params(header(c.headers, 'content-type')).value || 'text/plain') === 'text/plain');
        const pick = plain ?? children.find((c) => params(header(c.headers, 'content-type')).value.startsWith('multipart/')) ?? children.find((c) => params(header(c.headers, 'content-type')).value === 'text/html');
        if (pick) walk(pick, depth + 1);
        return;
      }
      for (const c of children) { walk(c, depth + 1); if (parts > MIME_LIMITS.parts) break; }
      return;
    }
    const bytes = transferDecode(p.body, header(p.headers, 'content-transfer-encoding') ?? '', problems);
    const filename = disp.p.filename ?? ct.p.name;
    const inline = disp.value !== 'attachment' && (type === 'text/plain' || type === 'text/html');
    if (!inline) { attachments.push({ filename: filename ? decodeWords(filename, problems) : '', type, size: bytes.length }); return; }
    const s = decodeCharset(bytes, ct.p.charset ?? 'us-ascii', problems);
    if (type === 'text/html') htmls.push(s); else texts.push(s);
  };

  if (headers.length) walk({ headers: rawHeaders, body: top.body }, 0);
  const fromHtml = texts.length === 0 && htmls.length > 0;
  const text = tidy(fromHtml ? htmls.map(htmlText).join('\n\n') : texts.join('\n\n'));
  const dateText = header(headers, 'date');
  const date = dateText === null ? null : Date.parse(dateText);
  const ids = (v: string | null) => (v ? v.match(/<[^<>\s]+>/g) ?? [] : []);
  return {
    headers,
    from: addressList(header(headers, 'from'))[0] ?? null,
    to: addressList(header(headers, 'to')),
    subject: header(headers, 'subject') ?? '',
    date: date === null || Number.isNaN(date) ? null : date,
    messageId: ids(header(headers, 'message-id'))[0] ?? null,
    inReplyTo: ids(header(headers, 'in-reply-to'))[0] ?? null,
    references: ids(header(headers, 'references')),
    text,
    fromHtml,
    attachments,
    problems: [...problems],
  };
}
