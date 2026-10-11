// plan-ex.md E2.0: the MIME reader of poly-io, which turns a received message's bytes (Gmail's `raw`, and an SES object
// in S3 after v1) into the text a decision reads. Mail is untrusted input: the reader never throws on what a sender
// writes, bounds how deep and how many parts it reads, and names each problem it met. Over the synthetic corpus only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { readMime } from '@poly/io';
import { ROOT } from './helpers.mjs';

const CORPUS = join(ROOT, 'test', 'fixtures', 'inbox', 'corpus');
/** As a provider delivers it: CRLF line ends (RFC 5322 section 2.1). */
const mail = (f) => Buffer.from(readFileSync(join(CORPUS, f), 'utf8').replace(/\r?\n/g, '\r\n'), 'utf8');

test('E2.0: a plain 7bit message: its addresses, subject, date, ids and text', () => {
  const m = readMime(mail('work-1.eml'));
  assert.deepEqual(m.from, { name: 'Alice Moreau', address: 'alice@supplier.example.com' });
  assert.deepEqual(m.to, [{ name: 'Owner', address: 'owner@work.example.com' }]);
  assert.equal(m.subject, 'Invoice 4471 for the October delivery');
  assert.equal(m.date, Date.parse('2026-10-05T09:12:00Z'));
  assert.equal(m.messageId, '<inv-4471@supplier.example.com>');
  assert.match(m.text, /The amount is 1,240\.00 EUR and it is due on Friday 9 October\./);
  assert.ok(!m.text.includes('\r'), 'text lines end with LF');
  assert.equal(m.fromHtml, false);
  assert.deepEqual(m.attachments, []);
  assert.deepEqual(m.problems, []);
});

test('E2.0: multipart/alternative takes text/plain, and quoted-printable joins a UTF-8 character split by a soft break', () => {
  const m = readMime(mail('work-2.eml'));
  assert.match(m.text, /The total is 1,240\.00 €\./);
  assert.match(m.text, /Thank you – Alice/);
  assert.ok(!m.text.includes('<p>'));
  assert.equal(m.inReplyTo, '<inv-4471@supplier.example.com>');
  assert.deepEqual(m.references, ['<inv-4471@supplier.example.com>']);
  assert.ok(!m.text.includes('This is a multi-part message'), 'the preamble is not text');
});

test('E2.0: an HTML-only message becomes text, without its script, style or tags', () => {
  const m = readMime(mail('work-3.eml'));
  assert.equal(m.fromHtml, true);
  assert.match(m.text, /This week in logistics/);
  assert.match(m.text, /Three stories & one chart\./);
  for (const gone of ['track()', 'color', '<a', 'href']) assert.ok(!m.text.includes(gone), gone);
});

test('E2.0: RFC 2047 encoded words in a name and a subject, and a base64 UTF-8 body', () => {
  const m = readMime(mail('home-1.eml'));
  assert.deepEqual(m.from, { name: 'Camille Bérard', address: 'camille@friends.example.org' });
  assert.equal(m.subject, 'Dîner samedi ?');
  assert.match(m.text, /On dîne chez nous samedi à 20 h \? Dis-moi si tu viens\./);
  assert.equal(m.date, Date.parse('2026-10-04T16:05:00Z'));
});

test('E2.0: ISO-8859-1 in a quoted-printable subject and body', () => {
  const m = readMime(mail('home-2.eml'));
  assert.equal(m.subject, 'Votre colis a été expédié');
  assert.match(m.text, /Votre colis 55120 a été expédié et arrivera jeudi\./);
  assert.match(m.text, /Aucune action n'est nécessaire\./);
});

test('E2.0: multipart/mixed: the inline text is read, an attachment is listed by name, type and size, never read', () => {
  const m = readMime(mail('club-1.eml'));
  assert.match(m.text, /Could you present the budget for\nnext season\?/);
  assert.deepEqual(m.attachments, [{ filename: 'budget-draft.pdf', type: 'application/pdf', size: 78 }]);
  assert.ok(!m.text.includes('%PDF') && !m.text.includes('JVBER'));
});

test('E2.0: a message with no Content-Type is text/plain in US-ASCII (RFC 2045 section 5.2), and LF line ends are read too', () => {
  const crlf = readMime(mail('club-2.eml'));
  assert.match(crlf.text, /The regatta is on the 18th\./);
  const lf = readMime(Buffer.from(readFileSync(join(CORPUS, 'club-2.eml'), 'utf8'), 'utf8'));
  assert.equal(lf.text, crlf.text);
  assert.equal(lf.subject, crlf.subject);
});

test('E2.0: folded headers unfold, and adjacent encoded words join without the space between them (RFC 2047 section 6.2)', () => {
  const raw = 'Subject: =?UTF-8?Q?caf=C3=A9?=\r\n =?UTF-8?Q?_cr=C3=A8me?= and\r\n\tmore\r\nFrom: "Doe, Jane" <JANE@Example.COM>\r\nTo: a@example.com, "B, C" <b@example.com>\r\n\r\nbody\r\n';
  const m = readMime(raw);
  assert.equal(m.subject, 'café crème and more');
  assert.deepEqual(m.from, { name: 'Doe, Jane', address: 'jane@example.com' });
  assert.deepEqual(m.to.map((a) => a.address), ['a@example.com', 'b@example.com']);
});

test('E2.0: untrusted structure is bounded and named, never thrown: depth, part count, a missing boundary, an unknown charset', () => {
  let deep = 'Content-Type: text/plain\r\n\r\ninnermost\r\n';
  for (let i = 0; i < 20; i++) deep = `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n${deep}--b${i}--\r\n`;
  const d = readMime(deep);
  assert.ok(d.problems.includes('depth'), JSON.stringify(d.problems));
  assert.ok(!d.text.includes('innermost'));

  let many = 'Content-Type: multipart/mixed; boundary=x\r\n\r\n';
  for (let i = 0; i < 300; i++) many += `--x\r\nContent-Type: text/plain\r\n\r\npart ${i}\r\n`;
  many += '--x--\r\n';
  const p = readMime(many);
  assert.ok(p.problems.includes('parts'));
  assert.ok(p.text.includes('part 0') && !p.text.includes('part 299'));

  const nb = readMime('Content-Type: multipart/mixed\r\n\r\nloose text\r\n');
  assert.ok(nb.problems.includes('no-boundary'));
  assert.match(nb.text, /loose text/);

  const cs = readMime('Content-Type: text/plain; charset=x-unknown-9\r\n\r\nplain words\r\n');
  assert.ok(cs.problems.includes('charset:x-unknown-9'));
  assert.match(cs.text, /plain words/);

  const bad = readMime('Content-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\n!!!not base64***\r\n');
  assert.equal(typeof bad.text, 'string');
  assert.equal(readMime('').text, '');
  assert.equal(readMime('no headers at all').text, '');
});
