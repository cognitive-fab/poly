// SMTP submission (RFC 5321, read on 2026-10-05): EHLO, AUTH PLAIN, MAIL FROM, RCPT TO, DATA, the message with
// dot-stuffing ended by <CRLF>.<CRLF>, and QUIT. 2yz and 3yz replies go on; a 5yz reply is a permanent failure and a
// 4yz one a transient failure. The result names the stage that failed: only a 5yz reply to RCPT TO is the recipient's
// rejection, a bounce (review B-F5, M8b).
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

/**
 * RFC 5321 4.5.2: a line of the message that starts with a period gets one more. Review C-F2 (M8b): a bare CR or a
 * bare LF ends a line too (RFC 5321 2.3.8 forbids them alone), so each becomes CRLF first; a server that took a bare CR
 * for a line end would otherwise read "\r.\r\n" as the end of the data.
 */
export function dotStuff(message: string): string {
  return message.replace(/\r\n|\r|\n/g, '\r\n').split('\r\n').map((l) => (l.startsWith('.') ? `.${l}` : l)).join('\r\n');
}

/** The stage of a session a failure came at, so a caller can tell a recipient's rejection (a bounce) from the rest. */
export type Stage = 'connect' | 'greeting' | 'ehlo' | 'auth' | 'mail' | 'rcpt' | 'data' | 'message' | 'quit' | 'session' | 'refused';

export async function submit(transport: SmtpTransport, s: Submission): Promise<SendResult & { stage?: Stage }> {
  // Review C-F1 (M8b): every command is one line, so a value with CR or LF in it would write a second command of the
  // caller's choosing (RCPT TO for another recipient, or QUIT). It is refused before the session opens.
  for (const [name, value] of [['from', s.from], ['to', s.to], ['heloName', s.heloName], ['username', s.username], ['password', s.password]] as const) {
    if (/[\r\n]/.test(value)) return { ok: false, permanent: true, error: `the ${name} of a submission holds CR or LF, which would end its command line`, stage: 'refused' };
  }
  let session: SmtpSession;
  try { session = await transport.open(); } catch (e) { return { ok: false, permanent: false, error: `no answer: ${e instanceof Error ? e.message : String(e)}`, stage: 'connect' }; }
  const step = async (stage: Stage, line: string | null, want: number): Promise<(SendResult & { stage: Stage }) | null> => {
    if (line !== null) await session.write(line);
    const reply = await session.read();
    const code = codeOf(reply);
    if (Math.floor(code / 100) === Math.floor(want / 100)) return null;
    return { ok: false, permanent: code >= 500 && code < 600, error: reply.trim(), stage };
  };
  try {
    const failed =
      (await step('greeting', null, 220)) ??
      (await step('ehlo', `EHLO ${s.heloName}`, 250)) ??
      (await step('auth', `AUTH PLAIN ${Buffer.from(`\0${s.username}\0${s.password}`).toString('base64')}`, 235)) ??
      (await step('mail', `MAIL FROM:<${s.from}>`, 250)) ??
      (await step('rcpt', `RCPT TO:<${s.to}>`, 250)) ??
      (await step('data', 'DATA', 354)) ??
      // The message's own final CRLF, if it has one, is the one before the end-of-data indicator (polywatch).
      (await step('message', `${dotStuff(s.message).replace(/\r\n$/, '')}\r\n.`, 250));
    if (failed) {
      try { await session.write('QUIT'); await session.read(); } catch { /* the failure is what is reported */ }
      return failed;
    }
    await step('quit', 'QUIT', 221);
    return { ok: true, providerId: '' };
  } catch (e) {
    return { ok: false, permanent: false, error: `the session ended: ${e instanceof Error ? e.message : String(e)}`, stage: 'session' };
  } finally {
    await session.close();
  }
}
