#!/usr/bin/env node
// plan-ex.md E2.0: builds the recorded Gmail traffic of the inbox assistant from its synthetic corpus
// (test/fixtures/inbox). Each tape is a list of exchanges in the shapes the Gmail API reference documents
// (test/fixtures/traffic/gmail/PROVENANCE.md). `--write` writes the tapes; without it the script prints whether the
// files on disk are the ones it builds. test/ex-gmail-traffic.test.mjs runs `build` and compares.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNotExperimentTree } from './tree-guard.mjs';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const CORPUS = join(ROOT, 'test', 'fixtures', 'inbox');
const OUT = join(ROOT, 'test', 'fixtures', 'traffic', 'gmail');
export const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const PAGE = 100;

const ok = (body) => ({ status: 200, body });
const get = (path) => ({ method: 'GET', url: `${BASE}${path}` });
// The error body Google's APIs return for an expired or unknown startHistoryId (users.history.list: "A historyId is
// typically valid for at least a week ... you receive an HTTP 404 error response").
const NOT_FOUND = { status: 404, body: { error: { code: 404, message: 'Requested entity was not found.', errors: [{ message: 'Requested entity was not found.', domain: 'global', reason: 'notFound' }], status: 'NOT_FOUND' } } };

/** RFC 5322 needs CRLF; the corpus files are kept with LF, as the repository keeps every text file. */
const rawOf = (file) => Buffer.from(readFileSync(join(CORPUS, 'corpus', file), 'utf8').replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64url');

const historyPath = (start, token) => `/history?startHistoryId=${start}&historyTypes=messageAdded&labelId=INBOX&maxResults=${PAGE}${token ? `&pageToken=${token}` : ''}`;
const listPath = (afterSeconds) => `/messages?labelIds=INBOX&maxResults=${PAGE}${afterSeconds === undefined ? '' : `&q=${encodeURIComponent(`after:${afterSeconds}`)}`}`;

export function build() {
  const corpus = JSON.parse(readFileSync(join(CORPUS, 'corpus.json'), 'utf8'));
  const tapes = {};
  for (const a of corpus.accounts) {
    const mine = corpus.messages.filter((m) => m.account === a.label);
    const newestFirst = (ms) => [...ms].sort((x, y) => Number(y.internalDate) - Number(x.internalDate));
    const message = (m) => ({ request: get(`/messages/${m.id}?format=raw`), response: ok({ id: m.id, threadId: m.threadId, labelIds: m.labelIds, snippet: '', historyId: m.historyId, internalDate: m.internalDate, sizeEstimate: Buffer.from(rawOf(m.file), 'base64url').length, raw: rawOf(m.file) }) });
    const profile = (historyId) => ({ request: get('/profile'), response: ok({ emailAddress: a.address, messagesTotal: mine.length, threadsTotal: new Set(mine.map((m) => m.threadId)).size, historyId }) });
    const initial = newestFirst(mine.filter((m) => m.phase === 'initial'));
    const polled = mine.filter((m) => m.phase === 'poll');
    const t = {};
    // A first sync: the profile's historyId is the cursor, and the inbox is listed once, bounded by PAGE.
    t.initial = [profile(a.startHistoryId), { request: get(listPath()), response: ok({ messages: initial.map((m) => ({ id: m.id, threadId: m.threadId })), resultSizeEstimate: initial.length }) }, ...initial.map(message)];
    // A poll from the cursor: messageAdded records, the first page pointing at a second.
    if (polled.length) {
      const added = (m) => ({ id: m.historyId, messages: [{ id: m.id, threadId: m.threadId }], messagesAdded: [{ message: { id: m.id, threadId: m.threadId, labelIds: m.labelIds } }] });
      t.poll = [
        { request: get(historyPath(a.startHistoryId)), response: ok({ history: [added(polled[0])], nextPageToken: 'page-2', historyId: a.afterPollHistoryId }) },
        { request: get(historyPath(a.startHistoryId, 'page-2')), response: ok({ history: polled.slice(1).map(added), historyId: a.afterPollHistoryId }) },
        ...polled.map(message),
      ];
    }
    // A poll with nothing new: no history field, the same historyId.
    t.quiet = [{ request: get(historyPath(a.afterPollHistoryId)), response: ok({ historyId: a.afterPollHistoryId }) }];
    // The cursor has expired: 404, then a bounded list since the newest message seen, by its internalDate in seconds.
    const newest = newestFirst(mine)[0];
    const after = Math.floor(Number(newest.internalDate) / 1000);
    t.expired = [
      { request: get(historyPath(a.afterPollHistoryId)), response: NOT_FOUND },
      profile(String(Number(a.afterPollHistoryId) + 110)),
      { request: get(listPath(after)), response: ok({ messages: [{ id: newest.id, threadId: newest.threadId }], resultSizeEstimate: 1 }) },
    ];
    tapes[a.label] = t;
  }
  return tapes;
}

const text = (tape) => `${JSON.stringify(tape, null, 2)}\n`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--write')) assertNotExperimentTree(ROOT);
  const tapes = build();
  let same = true;
  for (const [label, tape] of Object.entries(tapes)) {
    const file = join(OUT, `${label}.json`);
    if (process.argv.includes('--write')) writeFileSync(file, text(tape));
    else {
      let disk = null;
      try { disk = readFileSync(file, 'utf8'); } catch { disk = null; }
      if (disk !== text(tape)) { same = false; console.log(`${label}.json differs from what the corpus builds`); }
    }
  }
  if (!process.argv.includes('--write')) { console.log(same ? 'the tapes are the corpus\'s' : 'run with --write'); process.exitCode = same ? 0 : 1; }
}

export { text };
