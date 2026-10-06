// SMTP submission (RFC 5321, read on 2026-10-05): EHLO, AUTH PLAIN, MAIL FROM, RCPT TO, DATA, the message with
// dot-stuffing ended by <CRLF>.<CRLF>, and QUIT. 2yz and 3yz replies go on; a 5yz reply is a permanent failure (for a
// recipient, a bounce) and a 4yz one a transient failure.
import type { SendResult, SmtpSession, SmtpTransport } from '@poly/runtime/adapters';

export interface Submission {
  from: string;
  to: string;
  heloName: string;
  username: string;
  password: string;
  /** The message, header and body, lines ended by CRLF, not yet dot-stuffed. */
  message: string;
}

/** The reply code of a reply, the first three digits of its last line. */
function codeOf(reply: string): number {
  const last = reply.split(/\r?\n/).filter(Boolean).at(-1) ?? '';
  return /^\d{3}/.test(last) ? Number(last.slice(0, 3)) : 0;
}

/** RFC 5321 4.5.2: a line of the message that starts with a period gets one more. */
export function dotStuff(message: string): string {
  return message.split('\r\n').map((l) => (l.startsWith('.') ? `.${l}` : l)).join('\r\n');
}

export async function submit(transport: SmtpTransport, s: Submission): Promise<SendResult> {
  let session: SmtpSession;
  try { session = await transport.open(); } catch (e) { return { ok: false, permanent: false, error: `no answer: ${e instanceof Error ? e.message : String(e)}` }; }
  const step = async (line: string | null, want: number): Promise<SendResult | null> => {
    if (line !== null) await session.write(line);
    const reply = await session.read();
    const code = codeOf(reply);
    if (Math.floor(code / 100) === Math.floor(want / 100)) return null;
    return { ok: false, permanent: code >= 500 && code < 600, error: reply.trim() };
  };
  try {
    const failed =
      (await step(null, 220)) ??
      (await step(`EHLO ${s.heloName}`, 250)) ??
      (await step(`AUTH PLAIN ${Buffer.from(`\0${s.username}\0${s.password}`).toString('base64')}`, 235)) ??
      (await step(`MAIL FROM:<${s.from}>`, 250)) ??
      (await step(`RCPT TO:<${s.to}>`, 250)) ??
      (await step('DATA', 354)) ??
      // The message's own final CRLF, if it has one, is the one before the end-of-data indicator (polywatch).
      (await step(`${dotStuff(s.message).replace(/\r\n$/, '')}\r\n.`, 250));
    if (failed) {
      try { await session.write('QUIT'); await session.read(); } catch { /* the failure is what is reported */ }
      return failed;
    }
    await step('QUIT', 221);
    return { ok: true, providerId: '' };
  } catch (e) {
    return { ok: false, permanent: false, error: `the session ended: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    await session.close();
  }
}
