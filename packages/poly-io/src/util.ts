// Helpers every adapter shares: HMACs compared in constant time, form bodies, and the failure classes of a send.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { HttpResponse, SendResult } from '@poly/runtime/adapters';

export function hmac(alg: 'sha1' | 'sha256', key: string | Buffer, data: string): Buffer {
  return createHmac(alg, key).update(data, 'utf8').digest();
}

/** Constant-time comparison of two encoded signatures; a length difference is a mismatch, never an exception. */
export function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** An application/x-www-form-urlencoded body, as ordered pairs. */
export function formPairs(body: string): [string, string][] {
  return [...new URLSearchParams(body).entries()];
}

export function form(body: string): Record<string, string> {
  return Object.fromEntries(formPairs(body));
}

export function encodeForm(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

export function json(body: string): unknown {
  return JSON.parse(body);
}

/** A provider's HTTP answer to a send that failed: 429 and 5xx are worth a retry, any other 4xx is not. */
export function httpFailure(r: HttpResponse, error: string): SendResult {
  return { ok: false, permanent: r.status >= 400 && r.status < 500 && r.status !== 429, error };
}

/** A transport error (no answer at all) is worth a retry. */
export function noAnswer(e: unknown): SendResult {
  return { ok: false, permanent: false, error: `no answer: ${e instanceof Error ? e.message : String(e)}` };
}

/** Seconds between a provider's timestamp and now (ms); NaN for a timestamp that is not a number. */
export function skewSeconds(timestamp: string, now: number): number {
  if (!/^\d+$/.test(timestamp)) return Number.NaN;
  return Math.abs(now / 1000 - Number(timestamp));
}
