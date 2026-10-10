// plan-ex.md E2.0, S451, S452: the Gmail source. An account's mail is a source owned by its account's principal: the
// adapter syncs a mailbox through the Gmail API's history (users.history.list from the stored cursor, users.messages.get
// with format=raw), keeps each message's text in a mail store by reference, and answers a retrieval by owner, newest
// first, as the other sources do (K14). The adapter is built with the runtime's handle for the source's credential
// (rt.credentialHandle(c)), which sends through the vault (`withToken`, K13), so no token reaches this file. Under S460
// the credential has one grant and the source one account, whose sync goes through that handle. Under S461 each owner
// has a grant, and each account's sync goes through that owner's handle (rt.credentialHandle(c, owner)), which the host
// gives as the account's `request`. A source that names no credential takes each account's request from the host.
// The adapter only ever sends a GET under the Gmail API's base: it holds no code path that could send mail (S455).
//
// The read credential holds `gmail.readonly` alone, which every method used here accepts (PROVENANCE.md).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { HttpRequest, HttpResponse, HttpTransport, ItemRef, SourceAdapter, SourceQuery } from '@poly/runtime/adapters';
import { readMime } from './mime.js';
import { builtWith, made } from './util.js';

export const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
/** One page of a list or of the history, the API's default (at most 500). */
const PAGE = 100;
/** Pages of history read in one sync; a mailbox further behind is read on the next poll. */
const MAX_HISTORY_PAGES = 20;

/** A store of the adapter's own records: the mailbox's items and cursor. A host gives one; the file store is below. */
export interface MailStore {
  get(key: string): Promise<Record<string, unknown> | null>;
  put(key: string, value: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
}

export interface GmailAccount {
  /** The account's principal, as the program names it: every item of the account is owned by it (S451). */
  owner: string;
  /** An opaque label the owner gives the account, used in item ids in place of its address (S191, plan-ex 4.5). */
  label: string;
  /**
   * The request function this account's sync sends through: under S461 the runtime's handle for this owner
   * (rt.credentialHandle(c, owner)), which sends under this owner's grant only; for a source that names no credential, the
   * host's. Absent under S460, where the account's sync goes through `transport`.
   */
  request?(r: HttpRequest): Promise<HttpResponse>;
}

export interface GmailSourceConfig {
  accounts: GmailAccount[];
  /**
   * S460, S461: the runtime's handle for the credential the source names (rt.credentialHandle(c)); the adapter records
   * it, so rt.connectSource can ask. Under S460 it sends under the credential's one grant, which reaches one mailbox, so
   * the source has one account, which gives no request. Under S461 it is the routing handle, and every account gives its
   * owner's handle as its request.
   */
  transport?: HttpTransport;
  store: MailStore;
  /** The most characters of a message's text kept; longer text is cut and marked. */
  maxBody?: number;
  /**
   * S451: the value of an item's `correspondent` key, from its sender's address, by a function the host gives (a keyed
   * digest under a key it keeps), so no address becomes a key and enters the journal (S191). Without it the adapter
   * gives no correspondent key, and a retrieval by correspondent is refused.
   */
  correspondentKey?: (address: string) => string;
}

/** What a sync found: the items not yet announced to the host, and whether the cursor had expired. */
export interface SyncReport {
  owner: string;
  first: boolean;
  fallback: boolean;
  fresh: { id: string; thread: string; asOf: number }[];
}

export interface GmailSource extends SourceAdapter {
  readonly kind: 'gmail';
  /** Reads what is new in one account's mailbox since its cursor, and keeps it. */
  sync(owner: string): Promise<SyncReport>;
  /** The host has created the instances for these items; a later sync does not report them again. */
  announce(ids: string[]): Promise<void>;
  cursorOf(owner: string): string | null;
}

const LABEL = /^[a-z][a-z0-9-]{0,31}$/;
const GMAIL_ID = /^[0-9a-zA-Z_-]{1,64}$/;

interface ItemRecord { id: string; owner: string; thread: string; correspondent: string; asOf: number; body: string; announced: boolean }

/** S452: the Gmail source over the host's accounts. */
export function gmailSource(c: GmailSourceConfig): GmailSource {
  const A = 'gmail source';
  if (!Array.isArray(c.accounts) || c.accounts.length === 0) throw new Error(`${A}: at least one account`);
  if (c.transport !== undefined && typeof c.transport?.request !== 'function') throw new Error(`${A}: a transport is the runtime's handle for the source's credential`);
  // S460: one grant reaches one mailbox, so with no account's own request there is one account; S461: every account gives
  // its owner's handle, or none does.
  const own = c.accounts.filter((a) => a?.request !== undefined).length;
  if (c.transport !== undefined && own === 0 && c.accounts.length !== 1) throw new Error(`${A}: a transport with one grant reaches one account (S460); for more, each account gives its owner's handle (S461)`);
  if (c.transport !== undefined && own !== 0 && own !== c.accounts.length) throw new Error(`${A}: every account gives its owner's handle as its request, or none does (S461)`);
  const byOwner = new Map<string, GmailAccount>();
  const labels = new Set<string>();
  for (const a of c.accounts) {
    if (typeof a.owner !== 'string' || a.owner === '') throw new Error(`${A}: an account's owner is its principal, not empty`);
    if (typeof a.label !== 'string' || !LABEL.test(a.label)) throw new Error(`${A}: label ${JSON.stringify(a.label)} is lower-case letters, digits and hyphens, from a letter`);
    if (a.request !== undefined ? typeof a.request !== 'function' : c.transport === undefined) throw new Error(`${A}: an account's request is a function: its owner's handle, or the host's for a source that names no credential`);
    if (byOwner.has(a.owner) || labels.has(a.label)) throw new Error(`${A}: an owner or a label named twice`);
    byOwner.set(a.owner, a);
    labels.add(a.label);
  }
  const store = c.store;
  const maxBody = c.maxBody ?? 32_768;
  const cursors = new Map<string, string | null>();

  const account = (owner: string): GmailAccount => {
    const a = byOwner.get(owner);
    if (!a) throw new Error(`${A}: no account is owned by ${JSON.stringify(owner)}`);
    return a;
  };

  /** The one way out: a GET under the API's base, with no header that could carry a credential of its own. */
  const getJson = async (a: GmailAccount, path: string): Promise<{ status: number; json: Record<string, any> | null }> => {
    const r = await (a.request ? a : c.transport!).request!({ method: 'GET', url: `${GMAIL_BASE}${path}`, headers: { accept: 'application/json' }, body: '' });
    let json: Record<string, any> | null = null;
    try { json = r.body ? JSON.parse(r.body) : null; } catch { json = null; }
    return { status: r.status, json };
  };
  const must = (what: string, r: { status: number; json: Record<string, any> | null }): Record<string, any> => {
    if (r.status !== 200 || !r.json) throw new Error(`${A}: ${what} answered ${r.status}`);
    return r.json;
  };

  const itemKey = (id: string) => `item:${id}`;
  /** S451: an item's keys. The message key is the item's id, the thread key `<label>/<thread id>`. */
  const keysOf = (i: ItemRecord): Record<string, string> => ({ message: i.id, thread: i.thread, ...(c.correspondentKey && i.correspondent ? { correspondent: c.correspondentKey(i.correspondent) } : {}) });
  const cursorKey = (label: string) => `cursor:${label}`;

  /** The text a decision reads: the headers a person reads, then the message's text, bounded. */
  const render = (raw: Buffer): { body: string; correspondent: string } => {
    const m = readMime(raw);
    const who = (x: { name: string; address: string } | null) => (x ? (x.name ? `${x.name} <${x.address}>` : x.address) : '');
    const lines = [`From: ${who(m.from)}`, `To: ${m.to.map(who).join(', ')}`, `Subject: ${m.subject}`, `Date: ${m.date === null ? '' : new Date(m.date).toISOString()}`, ''];
    let text = m.text;
    for (const f of m.attachments) text += `\n[attachment: ${f.filename || 'unnamed'}, ${f.type}, ${f.size} bytes]`;
    let body = `${lines.join('\n')}\n${text}`;
    if (body.length > maxBody) body = `${body.slice(0, maxBody)}\n[truncated]`;
    return { body, correspondent: m.from?.address ?? '' };
  };

  /** Fetches and keeps one message unless it is kept already; a message deleted meanwhile (404) is skipped. */
  const keep = async (a: GmailAccount, gmailId: string): Promise<void> => {
    if (!GMAIL_ID.test(gmailId)) throw new Error(`${A}: ${JSON.stringify(gmailId)} is no message id`);
    const id = `${a.label}/${gmailId}`;
    if (await store.get(itemKey(id))) return;
    const r = await getJson(a, `/messages/${gmailId}?format=raw`);
    if (r.status === 404) return;
    const m = must('users.messages.get', r);
    if (typeof m.raw !== 'string' || typeof m.threadId !== 'string' || !GMAIL_ID.test(m.threadId)) throw new Error(`${A}: users.messages.get answered no raw message`);
    const asOf = Number(m.internalDate);
    if (!Number.isFinite(asOf)) throw new Error(`${A}: a message has no internalDate (K14)`);
    const { body, correspondent } = render(Buffer.from(m.raw, 'base64url'));
    const rec: ItemRecord = { id, owner: a.owner, thread: `${a.label}/${m.threadId}`, correspondent, asOf, body, announced: false };
    await store.put(itemKey(id), rec as unknown as Record<string, unknown>);
  };

  const itemsOf = async (owner?: string): Promise<ItemRecord[]> => {
    const prefixes = owner === undefined ? [...byOwner.values()].map((a) => `item:${a.label}/`) : byOwner.has(owner) ? [`item:${byOwner.get(owner)!.label}/`] : [];
    const out: ItemRecord[] = [];
    for (const p of prefixes) for (const k of await store.keys(p)) { const r = await store.get(k); if (r) out.push(r as unknown as ItemRecord); }
    return out.sort((x, y) => y.asOf - x.asOf || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  };

  /** A first sync, or the fallback of an expired cursor: the profile's historyId first, so nothing between is lost. */
  const listAll = async (a: GmailAccount, afterMs: number | null): Promise<string> => {
    const profile = must('users.getProfile', await getJson(a, '/profile'));
    if (typeof profile.historyId !== 'string') throw new Error(`${A}: users.getProfile answered no historyId`);
    const q = afterMs === null ? '' : `&q=${encodeURIComponent(`after:${Math.floor(afterMs / 1000)}`)}`;
    const list = must('users.messages.list', await getJson(a, `/messages?labelIds=INBOX&maxResults=${PAGE}${q}`));
    // One page only: a first sync is bounded (IT2.1); older mail is not the assistant's.
    for (const m of (Array.isArray(list.messages) ? list.messages : [])) await keep(a, String(m.id));
    return profile.historyId;
  };

  const adapter = {
    kind: 'gmail' as const,

    async sync(owner: string): Promise<SyncReport> {
      const a = account(owner);
      const saved = await store.get(cursorKey(a.label));
      let first = false;
      let fallback = false;
      let historyId: string;
      if (!saved) { first = true; historyId = await listAll(a, null); }
      else {
        const start = String(saved.historyId);
        const added: string[] = [];
        let token: string | undefined;
        let latest = start;
        let expired = false;
        for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
          const r = await getJson(a, `/history?startHistoryId=${encodeURIComponent(start)}&historyTypes=messageAdded&labelId=INBOX&maxResults=${PAGE}${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`);
          if (r.status === 404) { expired = true; break; }
          const h = must('users.history.list', r);
          for (const rec of (Array.isArray(h.history) ? h.history : [])) for (const ma of (Array.isArray(rec.messagesAdded) ? rec.messagesAdded : [])) {
            const id = String(ma?.message?.id ?? '');
            if (id && !added.includes(id)) added.push(id);
          }
          if (typeof h.historyId === 'string') latest = h.historyId;
          token = typeof h.nextPageToken === 'string' ? h.nextPageToken : undefined;
          if (!token) break;
        }
        if (expired) {
          // IT2.1: a bounded list since the newest message kept, and the cursor taken again from the profile.
          fallback = true;
          const newest = (await itemsOf(owner))[0]?.asOf ?? null;
          historyId = await listAll(a, newest);
        } else {
          for (const id of added) await keep(a, id);
          // A history read only in part keeps its start, so the next poll reads the rest (MAX_HISTORY_PAGES).
          historyId = token ? start : latest;
        }
      }
      // The cursor moves only after every item it covers is kept: a crash before this line reads them again (IT2.3).
      await store.put(cursorKey(a.label), { historyId });
      cursors.set(owner, historyId);
      const fresh = (await itemsOf(owner)).filter((i) => !i.announced).reverse().map((i) => ({ id: i.id, thread: i.thread, asOf: i.asOf }));
      return { owner, first, fallback, fresh };
    },

    async announce(ids: string[]): Promise<void> {
      for (const id of ids) {
        const r = await store.get(itemKey(id));
        if (r && !r.announced) await store.put(itemKey(id), { ...r, announced: true });
      }
    },

    cursorOf(owner: string): string | null {
      account(owner);
      return cursors.get(owner) ?? null;
    },

    async retrieve(q: SourceQuery): Promise<ItemRef[]> {
      if (!Number.isInteger(q.limit) || q.limit < 1) throw new Error(`a retrieval's limit is a positive integer, not ${JSON.stringify(q.limit)}`);
      // S451: one equality on a key the source declares; a key the adapter cannot give is refused, never ignored.
      if (q.key !== undefined) {
        if (!['message', 'thread', 'correspondent'].includes(q.key.name)) throw new Error(`${A}: a retrieval by the key ${JSON.stringify(q.key.name)}, which the source does not give (S451)`);
        if (q.key.name === 'correspondent' && !c.correspondentKey) throw new Error(`${A}: a retrieval by correspondent, and the host gave no correspondentKey (S451)`);
        if (typeof q.key.value !== 'string' || q.key.value === '') throw new Error(`${A}: a key's value is a non-empty string (PS1.4c)`);
      }
      const items = (await itemsOf(q.owner)).filter((i) => q.key === undefined || keysOf(i)[q.key.name] === q.key.value);
      return items.slice(0, q.limit).map((i) => ({ id: i.id, owner: i.owner, asOf: i.asOf, keys: keysOf(i) }));
    },

    async resolve(id: string): Promise<string | null> {
      const r = await store.get(itemKey(id));
      return r ? String(r.body) : null;
    },

    async forget(subject: string): Promise<{ removed: number }> {
      const a = byOwner.get(subject);
      if (!a) return { removed: 0 };
      const keys = await store.keys(`item:${a.label}/`);
      for (const k of keys) await store.remove(k);
      await store.remove(cursorKey(a.label));
      cursors.set(subject, null);
      return { removed: keys.length };
    },
  };
  // S460: the adapter records the handle it is built with, so the runtime's connectSource can ask.
  return made(builtWith(adapter, c.transport));
}

/** A mail store in memory, for tests and for a host that keeps nothing across restarts. */
export function memoryMailStore(): MailStore {
  const m = new Map<string, Record<string, unknown>>();
  return {
    async get(k) { const v = m.get(k); return v ? structuredClone(v) : null; },
    async put(k, v) { m.set(k, structuredClone(v)); },
    async remove(k) { m.delete(k); },
    async keys(p) { return [...m.keys()].filter((k) => k.startsWith(p)).sort(); },
  };
}

/**
 * A mail store in a directory named by an absolute `file:` path, outside the project, as the vault's stores are. Each
 * record is a file named by the SHA-256 of its key, so no file name holds an id or an address; it is written whole
 * through a file renamed into place.
 */
export function fileMailStore(location: string): MailStore {
  if (typeof location !== 'string' || !location.startsWith('file:')) throw new Error('fileMailStore: the location is a file: path');
  const dir = location.slice('file:'.length);
  if (!isAbsolute(dir)) throw new Error('fileMailStore: the location is an absolute file: path');
  mkdirSync(dir, { recursive: true });
  const file = (k: string) => join(dir, `${createHash('sha256').update(k, 'utf8').digest('hex')}.json`);
  const read = (f: string): { key: string; value: Record<string, unknown> } | null => {
    try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
  };
  return {
    async get(k) { return read(file(k))?.value ?? null; },
    async put(k, v) { const f = file(k); writeFileSync(`${f}.tmp`, JSON.stringify({ key: k, value: v })); renameSync(`${f}.tmp`, f); },
    async remove(k) { rmSync(file(k), { force: true }); },
    async keys(p) { return readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => read(join(dir, n))?.key).filter((k): k is string => typeof k === 'string' && k.startsWith(p)).sort(); },
  };
}
