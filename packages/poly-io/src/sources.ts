// PT20.2, PS17.2, S308: the source adapters. Each returns items by reference, with their owner and `asOf` (K14),
// resolves an item to its body only when a decision reads it, and forgets a subject's items. Neither builds a query from
// text: the owner and a key's value (S451) are typed parameters, and every name the adapter writes into a query is
// checked at construction.
//
//   postgres:   over the host's query function, parameterized SQL only, so no driver enters poly.
//   opensearch: the OpenSearch REST API (_search, _doc, _delete_by_query), as its documentation gives it, over an HTTP
//               transport the host or a test gives, so a test replays recorded traffic.
import type { EnvelopeAnswer, EnvelopeQuery, HttpTransport, ItemRef, PgQuery, SourceAdapter, SourceQuery } from '@poly/runtime/adapters';
import { made, oneLine } from './util.js';

/** A SQL identifier or an OpenSearch field name written into a query: letters, digits and underscores only. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const name = (adapter: string, what: string, v: string): string => {
  if (typeof v !== 'string' || !NAME.test(v)) throw new Error(`${adapter}: ${what} ${JSON.stringify(v)} is not a plain name (letters, digits, underscores)`);
  return v;
};

/**
 * S451, PT10j: a source's keys, each a declared key name and the column or field that holds it, both checked as plain
 * names at construction.
 */
const keysOf = (adapter: string, keys: Record<string, string> | undefined): [string, string][] => {
  if (keys === undefined) return [];
  if (keys === null || typeof keys !== 'object' || Array.isArray(keys)) throw new Error(`${adapter}: keys is an object of key names to columns or fields`);
  return Object.entries(keys).map(([k, v]) => [name(adapter, 'key', k), name(adapter, `${k} key column or field`, v)]);
};

/** The column or field of the key a query names; a key the adapter was not given is refused, never ignored. */
const keyField = (adapter: string, keys: [string, string][], q: SourceQuery): string | null => {
  if (q.key === undefined) return null;
  const f = keys.find(([k]) => k === q.key!.name)?.[1];
  if (f === undefined) throw new Error(`${adapter}: a retrieval by the key ${JSON.stringify(q.key.name)}, which the adapter was not given (S451)`);
  if (typeof q.key.value !== 'string' || q.key.value === '') throw new Error(`${adapter}: a key's value is a non-empty string (PS1.4c)`);
  return f;
};

/** An item's keys as the adapter read them: a key with no value is left out, so the runtime refuses the item (K14). */
const itemKeys = (keys: [string, string][], read: (i: number, field: string) => unknown): { keys?: Record<string, string> } => {
  if (!keys.length) return {};
  const out: Record<string, string> = {};
  keys.forEach(([k, f], i) => { const v = read(i, f); if (v !== undefined && v !== null) out[k] = String(v); });
  return { keys: out };
};

/** A limit as the runtime gives it: a positive integer, never above the declared one. */
const limitOf = (q: SourceQuery): number => {
  if (!Number.isInteger(q.limit) || q.limit < 1) throw new Error(`a retrieval's limit is a positive integer, not ${JSON.stringify(q.limit)}`);
  return q.limit;
};

/** An `asOf` in milliseconds from a number of ms or an ISO 8601 date; an item with none is refused (K14). */
const asOfMs = (adapter: string, v: unknown): number => {
  // A date and time with no zone is read as UTC, never in the runtime's own zone, so freshness does not move with it.
  const zoneless = (s: string) => /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const ms = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(zoneless(v)) : v instanceof Date ? v.getTime() : NaN;
  if (!Number.isFinite(ms)) throw new Error(`${adapter}: an item has no asOf (K14)`);
  return ms;
};

export interface PostgresSourceConfig {
  /** The host's query function: parameterized text and values (S308). */
  query: PgQuery;
  table: string;
  /** The columns of the item's id, owner (absent for a source that is not owned), asOf and body. */
  id: string;
  owner?: string;
  asOf: string;
  body: string;
  /** S451: the column of each key the source declares, by key name. */
  keys?: Record<string, string>;
  /**
   * PT10j (S459): for a source that declares `envelope k`, the columns of a row's sender, subject, message id and,
   * optionally, references. A references column is a `text[]` (which the driver gives as an array) or a text of message
   * ids separated by white space, as the References header writes them (RFC 5322 3.6.4); both are read.
   */
  envelope?: { from: string; subject: string; messageId: string; references?: string };
}

/** S459: a row's references, as an array column or as white-space separated text; none is an empty list. */
const referencesOf = (adapter: string, v: unknown): string[] => {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined).map((x) => String(x));
  if (typeof v === 'string') return v.split(/\s+/).filter((x) => x !== '');
  throw new Error(`${adapter}: a references column holds an array or a text, not ${typeof v}`);
};

/**
 * S459: a reply's subject: the row's, with `Re: ` before it unless it already starts with `re: ` in any case, since mail
 * clients write `RE: ` and `re: ` as well and a second prefix would grow the subject with each reply.
 */
const replySubject = (s: string): string => (/^re: /i.test(s) ? s : `Re: ${s}`);

/** S308: a Postgres source over the host's query function. Every query is parameterized; only checked names are written. */
export function postgresSource(c: PostgresSourceConfig): SourceAdapter {
  const A = 'postgres source';
  const table = name(A, 'table', c.table);
  const id = name(A, 'id column', c.id);
  const owner = c.owner === undefined ? null : name(A, 'owner column', c.owner);
  const asOf = name(A, 'asOf column', c.asOf);
  const body = name(A, 'body column', c.body);
  const keys = keysOf(A, c.keys);
  if (typeof c.query !== 'function') throw new Error(`${A}: query is the host's function (text, params) (S308)`);
  if (c.envelope !== undefined && (c.envelope === null || typeof c.envelope !== 'object' || Array.isArray(c.envelope))) throw new Error(`${A}: envelope is an object of the from, subject, messageId and references columns (S459)`);
  const env = c.envelope === undefined ? null : {
    from: name(A, 'envelope from column', c.envelope.from),
    subject: name(A, 'envelope subject column', c.envelope.subject),
    messageId: name(A, 'envelope messageId column', c.envelope.messageId),
    references: c.envelope.references === undefined ? null : name(A, 'envelope references column', c.envelope.references),
  };
  const q = (s: string) => `"${s}"`;
  // PT10j (S459): only an adapter given the envelope columns gives envelopes; one without them has no envelope method,
  // which the runtime refuses.
  const envelope = env === null ? {} : {
    async envelope(query: EnvelopeQuery): Promise<EnvelopeAnswer | null> {
      if (query.owner !== undefined && !owner) throw new Error(`${A}: an envelope retrieval by owner from a table with no owner column (PL6835 at run time)`);
      // The key and the owner are each an equality with a parameter, never text, as a retrieval's are (S451).
      const key = keyField(A, keys, { key: query.key, limit: 1 })!;
      const params: unknown[] = [query.key.value];
      const eqs = [`${q(key)} = $1`];
      if (query.owner !== undefined) { params.push(query.owner); eqs.push(`${q(owner!)} = $${params.length}`); }
      const cols = `${q(id)} AS id, ${owner ? `${q(owner)} AS owner` : 'NULL AS owner'}, ${q(asOf)} AS as_of, ${q(env.from)} AS env_from, ${q(env.subject)} AS env_subject, ${q(env.messageId)} AS env_message_id${env.references ? `, ${q(env.references)} AS env_references` : ''}`;
      const r = await c.query(`SELECT ${cols} FROM ${q(table)} WHERE ${eqs.join(' AND ')} ORDER BY ${q(asOf)} DESC LIMIT 1`, params);
      const row = r.rows[0];
      if (!row) return null;
      const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
      const messageId = row.env_message_id === null || row.env_message_id === undefined ? null : String(row.env_message_id);
      // The reply's References are the row's with its own message id after them (RFC 5322 3.6.4).
      const references = [...(env.references ? referencesOf(A, row.env_references) : []), ...(messageId === null ? [] : [messageId])];
      return {
        id: String(row.id),
        owner: owner ? (row.owner === null || row.owner === undefined ? null : String(row.owner)) : null,
        asOf: asOfMs(A, row.as_of),
        envelope: { to: str(row.env_from), subject: replySubject(str(row.env_subject)), inReplyTo: messageId, references },
      };
    },
  };
  return made({
    kind: 'postgres' as const,
    ...envelope,
    async retrieve(query: SourceQuery): Promise<ItemRef[]> {
      const limit = limitOf(query);
      const cols = `${q(id)} AS id, ${owner ? `${q(owner)} AS owner` : 'NULL AS owner'}, ${q(asOf)} AS as_of${keys.map(([, f], i) => `, ${q(f)} AS key_${i}`).join('')}`;
      if (query.owner !== undefined && !owner) throw new Error(`${A}: a retrieval by owner from a table with no owner column (PL6835 at run time)`);
      // S451: the owner and the key are each an equality with a parameter, never text.
      const key = keyField(A, keys, query);
      const params: unknown[] = [];
      const eqs: string[] = [];
      if (query.owner !== undefined) { params.push(query.owner); eqs.push(`${q(owner!)} = $${params.length}`); }
      if (key !== null) { params.push(query.key!.value); eqs.push(`${q(key)} = $${params.length}`); }
      params.push(limit);
      const where = eqs.length ? `WHERE ${eqs.join(' AND ')} ` : '';
      const text = `SELECT ${cols} FROM ${q(table)} ${where}ORDER BY ${q(asOf)} DESC LIMIT $${params.length}`;
      const r = await c.query(text, params);
      return r.rows.map((row) => ({ id: String(row.id), owner: owner ? (row.owner === null || row.owner === undefined ? null : String(row.owner)) : null, asOf: asOfMs(A, row.as_of), ...itemKeys(keys, (i) => row[`key_${i}`]) }));
    },
    async resolve(item: string): Promise<string | null> {
      const r = await c.query(`SELECT ${q(body)} AS body FROM ${q(table)} WHERE ${q(id)} = $1`, [item]);
      const b = r.rows[0]?.body;
      return b === undefined || b === null ? null : String(b);
    },
    async forget(subject: string): Promise<{ removed: number }> {
      if (!owner) return { removed: 0 };
      const r = await c.query(`DELETE FROM ${q(table)} WHERE ${q(owner)} = $1 RETURNING ${q(id)} AS id`, [subject]);
      return { removed: r.rows.length };
    },
  });
}

export interface OpenSearchSourceConfig {
  /** The cluster's base URL, https, with no path beyond the root. */
  base: string;
  index: string;
  transport: HttpTransport;
  /** The fields of the owner (absent when not owned), the asOf and the body; the id is the document's _id. */
  owner?: string;
  asOf: string;
  body: string;
  /** S451: the field of each key the source declares, by key name. */
  keys?: Record<string, string>;
  /** An Authorization header value the host gives, from its vault or environment at run time (PL6825); never written to a file. */
  authorization?: string;
}

/** S308: an OpenSearch index as a source, through the REST API: _search to retrieve, _doc to resolve, _delete_by_query to forget. */
export function openSearchSource(c: OpenSearchSourceConfig): SourceAdapter {
  const A = 'opensearch source';
  let base: URL;
  try { base = new URL(c.base); } catch { throw new Error(`${A}: base is a URL`); }
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash || base.username) throw new Error(`${A}: base is an https origin with no path, query or user`);
  const index = c.index;
  if (typeof index !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(index)) throw new Error(`${A}: index ${JSON.stringify(index)} is not an index name`);
  const owner = c.owner === undefined ? null : name(A, 'owner field', c.owner);
  const asOf = name(A, 'asOf field', c.asOf);
  const body = name(A, 'body field', c.body);
  const keys = keysOf(A, c.keys);
  // Review D4: a header value is one line, as the channel adapters require (review C-F1, M8b).
  if (c.authorization !== undefined) oneLine(A, { authorization: c.authorization });
  const headers = { 'content-type': 'application/json', accept: 'application/json', ...(c.authorization ? { authorization: c.authorization } : {}) };
  const url = (path: string) => `${base.origin}/${index}/${path}`;
  const call = async (method: string, path: string, payload?: unknown) => {
    const r = await c.transport.request({ method, url: url(path), headers, body: payload === undefined ? '' : JSON.stringify(payload) });
    let json: unknown = null;
    try { json = r.body ? JSON.parse(r.body) : null; } catch { json = null; }
    return { status: r.status, json: json as Record<string, any> | null };
  };
  return made({
    kind: 'opensearch' as const,
    async retrieve(query: SourceQuery): Promise<ItemRef[]> {
      const limit = limitOf(query);
      if (query.owner !== undefined && !owner) throw new Error(`${A}: a retrieval by owner from an index with no owner field (PL6835 at run time)`);
      // A term query on the owner field, and one on the key's field (S451): each value is in the request's JSON, never
      // query text.
      const key = keyField(A, keys, query);
      const filter = [...(query.owner !== undefined ? [{ term: { [owner!]: query.owner } }] : []), ...(key !== null ? [{ term: { [key]: query.key!.value } }] : [])];
      const search = { size: limit, query: filter.length ? { bool: { filter } } : { match_all: {} }, sort: [{ [asOf]: { order: 'desc' } }], _source: [...(owner ? [owner] : []), asOf, ...keys.map(([, f]) => f).filter((f) => f !== owner && f !== asOf)] };
      const r = await call('POST', '_search', search);
      if (r.status !== 200 || !Array.isArray(r.json?.hits?.hits)) throw new Error(`${A}: _search answered ${r.status}`);
      return r.json!.hits.hits.map((h: any) => ({ id: String(h._id), owner: owner ? (h._source?.[owner] === undefined || h._source?.[owner] === null ? null : String(h._source[owner])) : null, asOf: asOfMs(A, h._source?.[asOf]), ...itemKeys(keys, (_, f) => h._source?.[f]) }));
    },
    async resolve(item: string): Promise<string | null> {
      // Review D5: `.` and `..` would leave the _doc API once the URL is normalised.
      if (item === '.' || item === '..' || !item) throw new Error(`${A}: ${JSON.stringify(item)} is no document id`);
      const r = await call('GET', `_doc/${encodeURIComponent(item)}`);
      if (r.status === 404 || r.json?.found === false) return null;
      if (r.status !== 200) throw new Error(`${A}: _doc answered ${r.status}`);
      const b = r.json?._source?.[body];
      return b === undefined || b === null ? null : String(b);
    },
    async forget(subject: string): Promise<{ removed: number }> {
      if (!owner) return { removed: 0 };
      const r = await call('POST', '_delete_by_query?refresh=true', { query: { term: { [owner]: subject } } });
      if (r.status !== 200) throw new Error(`${A}: _delete_by_query answered ${r.status}`);
      // A forget that deleted only part of the subject's documents is not done (PS17.7).
      if (Array.isArray(r.json?.failures) && r.json!.failures.length) throw new Error(`${A}: _delete_by_query reported ${r.json!.failures.length} failures`);
      return { removed: Number(r.json?.deleted ?? 0) };
    },
  });
}
