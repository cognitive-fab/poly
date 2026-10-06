// Helpers every adapter shares: HMACs compared in constant time, form bodies, and the failure classes of a send.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { HttpResponse, SendResult } from '@poly/runtime/adapters';

export function hmac(alg: 'sha1' | 'sha256', key: string | Buffer, data: string): Buffer {
  return createHmac(alg, key).update(data, 'utf8').digest();
}

/**
 * The seeded mutants of the adapter tests: a signature check that always matches, and a timestamp check that never
 * refuses. An adapter takes one only from its configuration, and only a test gives one.
 */
export const ADAPTER_FAULTS = ['signature-always-matches', 'timestamp-never-stale'] as const;
export type AdapterFault = (typeof ADAPTER_FAULTS)[number];

/** A signature as received against the one expected, in constant time. */
export function signatureMatches(received: string, expected: string, fault?: AdapterFault): boolean {
  return fault === 'signature-always-matches' || sameText(received, expected);
}

/** Whether a provider's timestamp is within tolerance seconds of now (ms). */
export function fresh(timestamp: string, now: number, tolerance: number, fault?: AdapterFault): boolean {
  return fault === 'timestamp-never-stale' || skewSeconds(timestamp, now) <= tolerance;
}

/**
 * S182, plan step 10: every adapter this package makes, so the runtime can tell one made by the certified package from
 * a look-alike object. The set is this module instance's: an adapter made by another copy of the package is not in it.
 */
const MADE = new WeakSet<object>();
// Review D-F1 (M8b): an adapter is frozen when it is made, so no holder can swap its send or verify, or its kind,
// after the runtime certified it by identity.
export function made<T extends object>(adapter: T): T { Object.freeze(adapter); MADE.add(adapter); return adapter; }

/**
 * Review C-F6 (M8b): an adapter is not made with an empty secret, token or name: a signature under an empty secret
 * proves nothing, and a verify token that is empty matches an empty query.
 */
export function need(adapter: string, fields: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value !== 'string' || value === '') throw new Error(`${adapter}: ${name} is empty, and an adapter made with an empty secret or name would accept what anyone signs`);
  }
}

/** Review C-F1 (M8b): no configured value that goes into a header or a command holds CR or LF. */
export function oneLine(adapter: string, fields: Record<string, string>): void {
  for (const [name, value] of Object.entries(fields)) if (/[\r\n]/.test(value)) throw new Error(`${adapter}: ${name} holds CR or LF, and it goes into a header or a command line`);
}
export function madeHere(adapter: unknown): boolean { return typeof adapter === 'object' && adapter !== null && MADE.has(adapter); }

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
