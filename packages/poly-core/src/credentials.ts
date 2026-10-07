// PT10e (M9 step 5, S203): the provider profile a credential names, read from std/credentials/providers/<p>.json by
// poly-check and passed in as data, so the checker and the lowering never read the file system. poly-ref reads the
// same file on its own.

/** A provider profile, as PT10e and std/credentials/providers/PROVENANCE.md give its fields. */
export interface ProviderProfile {
  v: 1;
  provider: string;
  /** The addresses calls made with the credential go to; each an https URL ending in `/`, written as parsed. */
  bases: string[];
  authorization: string;
  token: string;
  revocation: string;
  grants: ('authorization_code' | 'client_credentials')[];
  pkce: boolean;
  scopes: string[];
  source: string;
  read: string;
}

/** A profile as poly-check found it: the parsed JSON (unchecked), the file, and the digest of its bytes. */
export interface ProviderEntry {
  profile: unknown;
  file: string;
  digest: string;
}

const SCOPE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** What is wrong with a profile for provider `name`, or null when it has every field PT10e names, well formed. */
export function profileProblem(p: unknown, name: string): string | null {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'is not a JSON object';
  const o = p as Record<string, unknown>;
  if (o.v !== 1) return 'has no version 1';
  if (o.provider !== name) return `names the provider ${JSON.stringify(o.provider)}, not "${name}"`;
  const https = (v: unknown): boolean => {
    if (typeof v !== 'string') return false;
    try { const u = new URL(v); return u.protocol === 'https:' && u.href === v && !u.username && !u.password && !u.search && !u.hash; } catch { return false; }
  };
  if (!Array.isArray(o.bases) || !o.bases.length || !o.bases.every((b) => https(b) && (b as string).endsWith('/'))) return 'has no base addresses, or one that is not an https URL ending in /, written as parsed';
  for (const k of ['authorization', 'token', 'revocation']) if (!https(o[k])) return `has no ${k} endpoint as an https URL, written as parsed`;
  if (!Array.isArray(o.grants) || !o.grants.length || !o.grants.every((g) => g === 'authorization_code' || g === 'client_credentials')) return 'names no grant, or one other than authorization_code and client_credentials';
  if (typeof o.pkce !== 'boolean') return 'does not say whether it supports PKCE';
  if (!Array.isArray(o.scopes) || !o.scopes.length || !o.scopes.every((s) => typeof s === 'string' && SCOPE.test(s))) return 'defines no scope, or one that is not an identifier or a dotted one';
  if (typeof o.source !== 'string' || !o.source || typeof o.read !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.read)) return 'does not name its source and the date it was read';
  return null;
}

/** PL6823: an egress target lies under a base address, the base ending in `/` and both written as parsed (S151). */
export function underBase(target: string, bases: readonly string[]): boolean {
  return bases.some((b) => target.startsWith(b));
}
