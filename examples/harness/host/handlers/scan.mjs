// plan-e3.md E3.3, HF3.5, S554: the credential scan and the redaction. Deterministic code, no model. It runs on every tool
// output before any model sees it, the cheaper reader included. It finds (1) the shapes credentials commonly take and
// (2) every secret the host knows, which the vault gives it, in the four encodings the standing canary test knows (plain,
// base64, base64url, URL-encoded). A flagged output is redacted, and the unredacted bytes are never stored as Content.
// This is the assumption "scan-verdict" of assumptions.json. Its limit is stated there: a credential that is of no common
// shape and not in the vault is not recognised.
export const PATTERNS = [
  { kind: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { kind: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  { kind: 'sk-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: 'assignment', re: /\b(?:api[_-]?key|secret|token|passwd|password)\b\s*[:=]\s*["']?[^\s"']{8,}/gi },
];

/** The four encodings of a known secret that the scan looks for. */
export const encodings = (s) => [s, Buffer.from(s).toString('base64'), Buffer.from(s).toString('base64url'), encodeURIComponent(s)];

const MIN_SECRET = 12;

/**
 * @param {string} text a tool output
 * @param {string[]} secrets the host's known secrets (the vault's tokens), at least 12 characters each
 * @returns {{ clean: boolean, matches: { kind: string, start: number, end: number }[] }} matches are merged and sorted
 */
export function scanText(text, secrets = []) {
  for (const s of secrets) if (typeof s !== 'string' || s.length < MIN_SECRET) throw new Error(`a known secret is at least ${MIN_SECRET} characters, or the scan would flag ordinary text`);
  const found = [];
  for (const { kind, re } of PATTERNS) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) found.push({ kind, start: m.index, end: m.index + m[0].length });
  }
  for (const s of secrets) {
    for (const e of new Set(encodings(s))) {
      for (let at = text.indexOf(e); at !== -1; at = text.indexOf(e, at + 1)) found.push({ kind: 'known-secret', start: at, end: at + e.length });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const f of found) {
    const last = merged[merged.length - 1];
    if (last && f.start <= last.end) {
      last.end = Math.max(last.end, f.end);
      if (last.kind !== f.kind) last.kind = 'multiple';
    } else merged.push({ ...f });
  }
  return { clean: merged.length === 0, matches: merged };
}

/** The text with each match replaced by its kind, so that nothing of a flagged span survives. */
export function redact(text, matches) {
  let out = '';
  let at = 0;
  for (const m of matches) {
    out += text.slice(at, m.start) + `[REDACTED:${m.kind}]`;
    at = m.end;
  }
  return out + text.slice(at);
}

/**
 * The effect handler of tool.scan. The tool output of the turn is read from the output table and the vault's known secrets from the secret known-secrets (read:store, write:store, read:private; the effect declares both targets); a flagged output
 * is a permanent failure, which completes as the effect's failed outcome (Flagged), and the redacted copy is written for
 * the store step. The unredacted output is never written anywhere by this handler.
 */
export async function scan(_payload, caps, ctx) {
  const out = await caps.store.read('output', ctx.instanceId);
  const given = await caps.secrets.get('known-secrets');
  const secrets = typeof given === 'string' ? JSON.parse(given) : given;
  const r = scanText(out.text, secrets);
  if (r.clean) return { ok: true };
  await caps.store.write('redacted', ctx.instanceId, { text: redact(out.text, r.matches), kinds: [...new Set(r.matches.map((m) => m.kind))] });
  throw Object.assign(new Error(`the output holds ${r.matches.length} credential span(s): ${[...new Set(r.matches.map((m) => m.kind))].join(', ')}`), { permanent: true });
}
