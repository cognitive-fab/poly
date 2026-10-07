// PT10e (M9 step 5, S203): the provider profile a credential names, read from std/credentials/providers/<p>.json by
// poly-check and passed in as data, so the checker and the lowering never read the file system. poly-ref reads the
// same file on its own.
import type * as A from './ast.js';
import { diag, type Diagnostic } from './diagnostics.js';

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
  /** PT10f: the value each scope is sent as, the attachment of the credential, and the revocation's form. */
  scopeValues?: Record<string, string>;
  authParams?: Record<string, string>;
  attach?: 'bearer' | 'stripe-account';
  revocationStyle?: 'rfc7009' | 'stripe-deauthorize';
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
  // PT10f: the optional fields of the vault adapter.
  if (o.scopeValues !== undefined && (!o.scopeValues || typeof o.scopeValues !== 'object' || Array.isArray(o.scopeValues) || !Object.entries(o.scopeValues).every(([k, v]) => (o.scopes as string[]).includes(k) && typeof v === 'string' && v !== ''))) return 'has scope values for a scope it does not define, or an empty one';
  if (o.authParams !== undefined && (!o.authParams || typeof o.authParams !== 'object' || Array.isArray(o.authParams) || !Object.values(o.authParams).every((v) => typeof v === 'string'))) return 'has authorization parameters that are not strings';
  // Polywatch: a fixed parameter never names one the grant sets itself.
  if (o.authParams && Object.keys(o.authParams).some((k) => ['response_type', 'client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method'].includes(k))) return 'has an authorization parameter the grant sets itself';
  if (o.attach !== undefined && o.attach !== 'bearer' && o.attach !== 'stripe-account') return 'attaches its credential neither as bearer nor as stripe-account';
  if (o.revocationStyle !== undefined && o.revocationStyle !== 'rfc7009' && o.revocationStyle !== 'stripe-deauthorize') return 'revokes neither by RFC 7009 nor by stripe-deauthorize';
  if (typeof o.source !== 'string' || !o.source || typeof o.read !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.read)) return 'does not name its source and the date it was read';
  return null;
}

/** PL6823: an egress target lies under a base address, the base ending in `/` and both written as parsed (S151). */
export function underBase(target: string, bases: readonly string[]): boolean {
  return bases.some((b) => target.startsWith(b));
}

/** PS16.1: a scope's field in its credential's ScopeSet: the scope with every `.` written `_`. */
export const scopeField = (scope: string): string => scope.split('.').join('_');

/**
 * PS16.0, PS16.1 (S209): each credential `c` of a module `m` means the module `m.c`, `std.credentials` instantiated with
 * `c`'s own ScopeSet: one bool field per declared scope, and every record literal of ScopeSet's fields read with the new
 * fields, each false. poly-ref instantiates it from the source on its own.
 */
export function expandCredentials(module: A.Module, program: A.Module[]): { extra: A.Module[]; diagnostics: Diagnostic[] } {
  const creds = module.decls.filter((d): d is A.Credential => d.kind === 'Credential');
  const diagnostics: Diagnostic[] = [];
  if (!creds.length) return { extra: [], diagnostics };
  const at = (n: A.NodeBase) => ({ module: module.name, node: n.id, line: n.span?.line, col: n.span?.col });
  const lib = program.find((m) => m.name === 'std.credentials');
  const scopeSet = lib?.decls.find((d): d is A.RecordDecl => d.kind === 'RecordDecl' && d.name === 'ScopeSet');
  if (!lib || !scopeSet || !lib.decls.some((d) => d.kind === 'Machine' && d.name === 'Grant')) {
    diagnostics.push(diag('PL1001', at(creds[0]), `no module std.credentials with the record ScopeSet and the machine Grant, which a credential means (PS16.0)`));
    return { extra: [], diagnostics };
  }
  const libFields = scopeSet.fields.map((f) => f.name).sort().join(',');
  const channels = new Set(module.decls.filter((d) => d.kind === 'Channel').map((d) => (d as A.Channel).name));
  const extra: A.Module[] = [];
  for (const c of creds) {
    if (channels.has(c.name)) { diagnostics.push(diag('PL1002', at(c), `credential ${c.name} has the name of a channel; each means a module ${module.name}.${c.name} (PS15, PS16)`)); continue; }
    const fields = c.scopes.map(scopeField);
    const twice = fields.find((f, i) => fields.indexOf(f) !== i);
    if (twice) { diagnostics.push(diag('PL1002', at(c), `credential ${c.name}: two of its scopes give the field ${twice} of its ScopeSet; a scope's field is the scope with each . written _ (PS16.1)`)); continue; }
    const rewrite = (x: unknown): unknown => {
      if (Array.isArray(x)) return x.map(rewrite);
      if (!x || typeof x !== 'object') return x;
      const n = x as Record<string, unknown>;
      if (n.kind === 'RecordDecl' && n.name === 'ScopeSet') return { ...n, fields: fields.map((f, i) => ({ kind: 'PayloadField', id: `${n.id as string}:${c.name}:${i}`, name: f, type: { kind: 'TBool', id: `${n.id as string}:${c.name}:${i}:t` } })) };
      if (n.kind === 'MapLit' && Array.isArray(n.entries) && (n.entries as { key: { kind: string; name?: string } }[]).every((e) => e.key.kind === 'Name') && (n.entries as { key: { name: string } }[]).map((e) => e.key.name).sort().join(',') === libFields) {
        return { ...n, entries: fields.map((f, i) => ({ key: { kind: 'Name', id: `${n.id as string}:${c.name}:${i}:k`, name: f }, value: { kind: 'Bool', id: `${n.id as string}:${c.name}:${i}:v`, value: false } })) };
      }
      return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, rewrite(v)]));
    };
    extra.push({ ...(rewrite(structuredClone(lib)) as A.Module), name: `${module.name}.${c.name}`, id: `${c.id}:module` });
  }
  return { extra, diagnostics };
}
