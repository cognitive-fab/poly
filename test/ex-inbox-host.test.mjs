// plan-ex.md E2, S459: the draft handler's message, on its own. The envelope's values become headers, so a value with
// a line break, which would write a header of its own, is refused; a subject that is not ASCII is written as RFC 2047
// encoded words; the body is base64 UTF-8; and the thread's Gmail id is read from the source's thread key only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';

const { draftMessage, threadIdOf, createDraft, DRAFTS_URL } = await import(pathToFileURL(join(ROOT, 'examples', 'inbox', 'host', 'drafts.mjs')).href);
const ENV = { to: 'alice@supplier.example.com', subject: 'Re: Invoice 4471', inReplyTo: '<a@x>', references: ['<z@x>', '<a@x>'] };

test('S459: the draft is the envelope\'s headers and the body, base64 UTF-8', () => {
  const m = draftMessage(JSON.stringify(ENV), 'Merci, Alice.');
  const [head, body] = m.split('\r\n\r\n');
  assert.deepEqual(head.split('\r\n'), ['To: alice@supplier.example.com', 'Subject: Re: Invoice 4471', 'In-Reply-To: <a@x>', 'References: <z@x> <a@x>', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64']);
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), 'Merci, Alice.');
  // A subject that is not ASCII is encoded words, which decode to it.
  const s = draftMessage({ ...ENV, subject: 'Re: Facture été' }, 'x').split('\r\n')[1];
  assert.match(s, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  assert.equal(Buffer.from(s.slice('Subject: =?UTF-8?B?'.length, -2), 'base64').toString('utf8'), 'Re: Facture été');
  // With no threading headers, none is written.
  assert.ok(!/In-Reply-To|References/.test(draftMessage({ to: 'a@x', subject: 's', inReplyTo: null, references: [] }, 'x')));
});

test('S459: a value with a line break is refused, as is an envelope with no recipient, and a thread key that names no Gmail thread', () => {
  for (const bad of [{ ...ENV, subject: 'Re: x\r\nBcc: eve@x' }, { ...ENV, to: 'a@x\nBcc: eve@x' }, { ...ENV, references: ['<a@x>\r\nX: y'] }]) assert.throws(() => draftMessage(bad, 'x'), /line break/);
  assert.throws(() => draftMessage({ ...ENV, to: '' }, 'x'), /recipient/);
  assert.equal(threadIdOf('work/19a2f0c4d1e70a01'), '19a2f0c4d1e70a01');
  for (const k of ['', 'work/', 'work/../x', 'work/a b']) assert.throws(() => threadIdOf(k), /names no Gmail thread/);
});

test('S455, S459: the handler reads its two bodies through content.read and posts one draft through api, at the drafts URL', async () => {
  const reads = [];
  const posts = [];
  const caps = {
    content: { read: async (d) => { reads.push(d); return d === 'sha256:e' ? JSON.stringify(ENV) : 'Body.'; } },
    api: { post: async (url, body) => { posts.push({ url, body }); return { status: 200, headers: {}, body: '{}' }; } },
  };
  assert.deepEqual(await createDraft({ account: 'acct-work', t: 'work/19a2f0c4d1e70a01', e: 'sha256:e', body: 'sha256:b' }, caps), { ok: true });
  assert.deepEqual(reads, ['sha256:e', 'sha256:b']);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, DRAFTS_URL);
  assert.equal(posts[0].body.message.threadId, '19a2f0c4d1e70a01');
  assert.match(Buffer.from(posts[0].body.message.raw, 'base64url').toString('utf8'), /^To: alice@supplier\.example\.com\r\n/);
  // An answer other than 200 fails the effect, so the to-do returns to its draft.
  await assert.rejects(createDraft({ t: 'work/19a2f0c4d1e70a01', e: 'sha256:e', body: 'sha256:b' }, { ...caps, api: { post: async () => ({ status: 403, headers: {}, body: '' }) } }), /403/);
});
