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
