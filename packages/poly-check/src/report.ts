// `poly report risks` (PT34.4, S586): for each risk a counted certificate names, what each policy item that names it did,
// counted from the verified journal. It reads a copy of the store, so the store itself is never opened and no byte of
// it moves; and it asserts that no chain head of the copy moved, as `poly journal eval` does.
//
// What the journal cannot say is stated, not inferred: allows are counted per scope (an allow names no rule), a refusal
// is counted for the one item the engine reports, and a run whose certificate cannot be identified is listed, not
// counted. The JSON is RFC 8785 with every list sorted by a stated key; the Markdown is rendered from the JSON alone.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
import { canonicalize, certificateDigest, certificateMessage, loadCatalogs, sha256OfBytes, type Certificate } from '@poly/core';
import { STD } from './uses.js';

export class ReportUsageError extends Error {}

export const MEANING = 'These counts are evidence that each rule was applied to the decisions recorded in the journal. They are not proof that a risk was removed or reduced.';
const attributionLine = (version: string) => `Risk domains and subdomains: MIT AI Risk Repository, Domain Taxonomy, ${version}, airisk.mit.edu, licensed under CC BY 4.0.`;

export interface RiskReportInput {
  db: string;
  build: string;
  certificates: string[];
  /** Each `--trust <keyId>=<public key file>`, as `poly journal verify` takes it. */
  trust: string[];
  period?: string;
}

interface Counts { refused: number; escalated: number; approved: number; timedOut: number; open: number; onUnknown: number }
interface UnknownOutcome { intent: string; run: string; effectKind: string; outcome: 'lost' | 'lapsed' | 'exhausted'; resolution?: { action: string; seq: number } }
const zero = (): Counts => ({ refused: 0, escalated: 0, approved: 0, timedOut: 0, open: 0, onUnknown: 0 });
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const by = <T>(key: (x: T) => string) => (a: T, b: T) => cmp(key(a), key(b));

/** PT34.4: `YYYY-MM` or `YYYY-MM-DD`, UTC; its first and last day. */
function periodOf(p: string | undefined): { asked: string | null; from: string | null; to: string | null; holds: (at: number) => boolean } {
  if (p === undefined) return { asked: null, from: null, to: null, holds: () => true };
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p);
  const month = /^(\d{4})-(\d{2})$/.exec(p);
  if (!day && !month) throw new ReportUsageError(`--period is YYYY-MM or YYYY-MM-DD, not ${p}`);
  const y = Number((day ?? month)![1]);
  const m = Number((day ?? month)![2]);
  if (m < 1 || m > 12) throw new ReportUsageError(`--period names no month: ${p}`);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (day && (Number(day[3]) < 1 || Number(day[3]) > last)) throw new ReportUsageError(`--period names no day: ${p}`);
  const from = day ? p : `${p}-01`;
  const to = day ? p : `${p}-${String(last).padStart(2, '0')}`;
  return { asked: p, from, to, holds: (at) => { const d = new Date(at).toISOString().slice(0, 10); return d >= from && d <= to; } };
}

function trustOf(list: string[]): Record<string, string> {
  return Object.fromEntries(list.map((t) => {
    const eq = t.indexOf('=');
    if (eq <= 0) throw new ReportUsageError(`--trust takes <keyId>=<public key file>, not ${t}`);
    const file = t.slice(eq + 1).replace(/^file:/, '');
    if (!existsSync(file)) throw new ReportUsageError(`--trust ${t}: no file ${file}`);
    return [t.slice(0, eq), readFileSync(file, 'utf8')];
  }));
}

/** A certified path in the build directory given: `.poly/build/x` is `<build>/x`; anything else is under the project. */
function inBuild(build: string, path: string): string {
  return path.startsWith('.poly/build/') ? join(build, path.slice('.poly/build/'.length)) : join(build, '..', '..', path);
}

interface ReadCertificate {
  file: string; cert: Certificate; digest: string; buildId: string; signers: string[]; problem: string | null;
  docs: { scope: string; doc: Record<string, unknown>; reads: string[] }[];
  obligations: Set<string>;
  /** Each obligation's kind and scope, from the certified documents. */
  kinds: Map<string, { kind: string; scope: string }>;
  policySets: Record<string, string>;
  moduleDigests: Set<string>;
}

/** A certificate, its signature against the trusted keys, and its policy documents read from the build by their digests. */
function readCertificate(file: string, build: string, trust: Record<string, string>): ReadCertificate {
  let cert: Certificate;
  try { cert = JSON.parse(readFileSync(file, 'utf8')) as Certificate; } catch (e) { throw new ReportUsageError(`--certificate ${file}: ${(e as Error).message}`); }
  const signers = (cert.signatures ?? []).map((s) => s.keyId).sort();
  let problem: string | null = null;
  if (certificateDigest(cert) !== cert.digest) problem = 'the certificate was edited after it was sealed';
  else if (!(cert.signatures ?? []).some((s) => trust[s.keyId] && (() => { try { return verify(null, Buffer.from(certificateMessage(cert.digest), 'utf8'), createPublicKey(trust[s.keyId]), Buffer.from(s.sig, 'base64')); } catch { return false; } })())) problem = `no signature by a key given with --trust (signed by ${signers.join(', ') || 'nobody'})`;
  const docs: ReadCertificate['docs'] = [];
  for (const p of cert.poly?.policies ?? []) {
    const f = inBuild(build, p.path);
    if (!existsSync(f)) { problem ??= `the build holds no ${p.path}`; continue; }
    const bytes = readFileSync(f);
    if (cert.artefacts?.[p.path] !== sha256OfBytes(bytes)) { problem ??= `${p.path} in the build is not the document the certificate certifies`; continue; }
    docs.push({ scope: p.scope, doc: JSON.parse(bytes.toString('utf8')) as Record<string, unknown>, reads: p.reads });
  }
  const obligations = new Set(docs.flatMap((d) => ((d.doc.obligations ?? []) as { id: string }[]).map((o) => o.id)));
  const kinds = new Map(docs.flatMap((d) => ((d.doc.obligations ?? []) as { id: string; kind: string }[]).map((o) => [o.id, { kind: o.kind, scope: d.scope }] as const)));
  // PT34.4 item 2: a step records its machine's version as the first twelve hex digits of the SHA-256 of the machine's
  // certified next.cjs, and that form alone is matched.
  const versions = new Set((cert.subject?.machines ?? []).flatMap((m) => { const d = cert.artefacts?.[`${m.dir}/next.cjs`]; return d ? [d.replace(/^sha256:/, '').slice(0, 12)] : []; }));
  return { file, cert, digest: cert.digest, buildId: cert.buildId, signers, problem, docs, obligations, kinds, policySets: {}, moduleDigests: versions };
}

/**
 * The item a gate reason names, in a certificate's documents: the longest obligation id the reason ends with, or is
 * followed in by a colon (`<id>:escalate`, `<id>:<guard reason>`). A reason that names none is the runtime's.
 */
function itemOf(reason: string | null | undefined, c: ReadCertificate): { item: string; unknown: boolean } | null {
  if (!reason) return null;
  const tail = reason.slice(reason.lastIndexOf('::') + (reason.includes('::') ? 2 : 0));
  let best: string | null = null;
  for (const id of c.obligations) if ((tail === id || tail.startsWith(`${id}:`)) && (!best || id.length > best.length)) best = id;
  if (!best) return null;
  return best.endsWith('.unknown') && c.obligations.has(best.slice(0, -'.unknown'.length)) ? { item: best.slice(0, -'.unknown'.length), unknown: true } : { item: best, unknown: false };
}

export async function riskReport(input: RiskReportInput): Promise<Record<string, unknown>> {
  const { openJournal, verifyRun, ledgerProblems, loadPolyaxion, PolicyGate } = await import('@poly/runtime');
  if (!existsSync(input.db)) throw new ReportUsageError(`no store at ${input.db}`);
  if (!input.certificates.length) throw new ReportUsageError('poly report risks needs at least one --certificate <file>');
  const period = periodOf(input.period);
  const trust = trustOf(input.trust);
  const certs = input.certificates.map((f) => readCertificate(f, input.build, trust));
  // PT34.4 item 2: each certificate's policy set, computed by declaring its documents in a fresh engine, as replay does.
  const px = await loadPolyaxion();
  for (const c of certs) {
    // Every module of the program, governed or open: a module no policy governs has the open gate's policy set, which its
    // runs record too (measured on the concierge's channel conversations and route, 2026-11-04).
    const modules = [...new Set([...c.docs.map((d) => d.scope), ...(c.cert.subject?.machines ?? []).map((m) => m.id.slice(0, m.id.lastIndexOf('.')))])].sort();
    try { c.policySets = await PolicyGate.policySets(px, c.docs, modules); } catch (e) { throw new ReportUsageError(`the policy set of ${c.file} cannot be computed: ${(e as Error).message}; the journal naming its certificate is then a precondition of the report (PT34.4, S586 Q6)`); }
  }

  // The store is copied, and only the copy is opened: the report writes nothing to the store (PT34.4).
  const tmp = mkdtempSync(join(tmpdir(), 'poly-report-'));
  const copy = join(tmp, 'store.db');
  copyFileSync(input.db, copy);
  if (existsSync(`${input.db}-wal`)) copyFileSync(`${input.db}-wal`, `${copy}-wal`);
  const store = openJournal(copy);
  const notCounted: { run: string; problem: string }[] = [];
  const unidentified: { run: string }[] = [];
  const ambiguous: { run: string; certificates: string[] }[] = [];
  const counted: { run: string; module: string; c: ReadCertificate; events: { kind: string; at: number; body: Record<string, any> }[]; lineage: Map<number, { origin: unknown; prev: string | null }> }[] = [];
  let runs = 0;
  try {
    const before: Record<string, string | null> = {};
    const all = await store.runs();
    for (const r of all) before[r.run] = (await store.chain(r.run)).at(-1)?.hash ?? null;
    const anchors = await store.anchors();
    const latest = anchors.length ? anchors[anchors.length - 1] : null;
    for (const r of [...all].sort(by((x) => x.run))) {
      // PT34.4 item 2: the runtime's own runs are skipped, and a run with no step or no gate record holds no decision.
      if (r.run.startsWith('runtime:')) continue;
      const chain = await store.chain(r.run);
      const steps = chain.filter((e) => e.kind === 'step');
      const gate = chain.filter((e) => e.kind === 'verdict' && (e.body as { stage?: string })?.stage === 'gate');
      if (!steps.length || !gate.length) continue;
      runs++;
      if (!Object.keys(trust).length) { notCounted.push({ run: r.run, problem: 'no key was given with --trust, so the run is not verified' }); continue; }
      const heads = await store.heads(r.run);
      const lineage = await store.lineage(r.run);
      const v = verifyRun(chain, heads, trust, await store.journal(r.run), lineage, await store.evidence(r.run));
      v.problems.push(...ledgerProblems(r.run, heads, latest, trust));
      if (v.problems.length) { notCounted.push({ run: r.run, problem: v.problems.join('; ') }); continue; }
      const versions = new Set(steps.map((e) => String((e.body as { machineVersion?: unknown }).machineVersion)));
      const sets = new Set(gate.flatMap((e) => { const s = (e.body as { policySet?: unknown }).policySet; return typeof s === 'string' ? [s] : []; }));
      const matches = certs.filter((c) => !c.problem && [...versions].every((x) => c.moduleDigests.has(x)) && [...sets].every((s) => Object.values(c.policySets).includes(s)));
      if (!matches.length) { unidentified.push({ run: r.run }); continue; }
      if (matches.length > 1) { ambiguous.push({ run: r.run, certificates: matches.map((c) => c.digest).sort() }); continue; }
      counted.push({ run: r.run, module: r.wf.slice(0, r.wf.lastIndexOf('.')), c: matches[0], events: chain.map((e) => ({ kind: e.kind, at: e.at, body: (e.body ?? {}) as Record<string, any> })), lineage });
    }
    const after: Record<string, string | null> = {};
    for (const r of await store.runs()) after[r.run] = (await store.chain(r.run)).at(-1)?.hash ?? null;
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('poly report risks changed a chain, which it must never do');
  } finally {
    await store.close();
    rmSync(tmp, { recursive: true, force: true });
  }

  // The certificates counted runs matched: their items, the risks they name and the catalogs they record.
  const countedCerts = certs.filter((c) => counted.some((r) => r.c === c));
  const items = new Map<string, { id: string; scope: string; kind: string; risks: string[]; controls: string[]; verdict?: string; signer: string | null; signerName: string | null; sequence: number | null; counts: Counts; approvedBy: Map<string, { keyId: string; name: string | null; count: number }>; unknownOutcomes: UnknownOutcome[] }>();
  for (const c of countedCerts) {
    const people = new Map((c.cert.poly?.keyrings?.people ?? []).map((p) => [p.keyId, p.name]));
    for (const [id, x] of Object.entries(c.cert.poly?.risk?.items ?? {})) {
      if (items.has(id)) continue;
      const pol = (c.cert.poly?.policies ?? []).find((p) => p.scope === x.scope);
      const signer = pol?.signature?.by ?? null;
      items.set(id, { id, scope: x.scope, kind: x.kind, risks: x.risks, controls: x.controls, ...(x.verdict ? { verdict: x.verdict } : {}), signer, signerName: signer ? people.get(signer) ?? null : null, sequence: pol?.sequence ?? null, counts: zero(), approvedBy: new Map(), unknownOutcomes: [] });
    }
  }
  const scopes = new Map<string, { scope: string; allowed: number; unknownOutcomes: UnknownOutcome[]; open?: true }>();
  for (const c of countedCerts) for (const p of c.cert.poly?.policies ?? []) if (!scopes.has(p.scope)) scopes.set(p.scope, { scope: p.scope, allowed: 0, unknownOutcomes: [] });
  const runtime = new Map<string, { kind: 'refused' | 'escalated'; reason: string; endedBy?: string; count: number }>();
  const bump = (kind: 'refused' | 'escalated', reason: string, endedBy?: string) => {
    const k = `${kind}\u0000${reason}\u0000${endedBy ?? ''}`;
    const x = runtime.get(k) ?? { kind, reason, ...(endedBy ? { endedBy } : {}), count: 0 };
    x.count++;
    runtime.set(k, x);
  };
  const days: string[] = [];
  // Items a certificate lists with no risk keep their counts too, under Rules that name no risk; an item of a
  // certificate with no poly.risk is counted there by its id alone.
  const untaggedExtra = new Map<string, { kind: string; scope: string; counts: Counts }>();
  let current: ReadCertificate | null = null;
  const credit = (id: string, k: keyof Counts) => {
    const it = items.get(id);
    if (it) { it.counts[k]++; return; }
    const c = untaggedExtra.get(id) ?? { ...(current?.kinds.get(id) ?? { kind: 'rule', scope: '' }), counts: zero() };
    c.counts[k]++;
    untaggedExtra.set(id, c);
  };

  for (const r of counted) {
    current = r.c;
    const people = new Map((r.c.cert.poly?.keyrings?.people ?? []).map((p) => [p.keyId, p.name]));
    // Per intent: the escalation still open (by an item, or by the runtime), what sent it to a person, and whether it was allowed.
    const open = new Map<string, { item: string | null }>();
    const sentByItem = new Map<string, string>();
    const allowedIntents = new Set<string>();
    const kinds = new Map<string, string>();
    for (const e of r.events) {
      if (e.kind !== 'verdict' || e.body.stage !== 'gate' || !period.holds(e.at)) continue;
      const b = e.body;
      const intent = String(b.intent ?? '');
      if (b.effectKind) kinds.set(intent, String(b.effectKind));
      const named = itemOf(b.reason, r.c);
      switch (b.outcome) {
        case 'allowed': {
          // A module no policy of the certificate governs is an open scope (PT9), and is said to be one.
          const s = scopes.get(r.module) ?? { scope: r.module, allowed: 0, unknownOutcomes: [], ...(r.c.docs.some((d) => d.scope === r.module) ? {} : { open: true as const }) };
          s.allowed++;
          scopes.set(r.module, s);
          allowedIntents.add(intent);
          break;
        }
        case 'denied': {
          if (b.reason === 'escalate-once') { bump('escalated', typeof b.escalatedBy === 'string' ? b.escalatedBy : 'not recorded', 'escalate-once'); break; }
          if (b.reason === 'escalation-timeout') {
            // The timeout of an item's escalation, on unknown input or not, is the item's; of one the runtime made, the
            // runtime's (PT34.4 item 4).
            const o = open.get(intent);
            open.delete(intent);
            if (o?.item) credit(o.item, 'timedOut');
            else bump('refused', 'escalation-timeout');
            break;
          }
          if (named) { if (named.unknown) credit(named.item, 'onUnknown'); credit(named.item, 'refused'); break; }
          bump('refused', String(b.reason ?? 'denied'));
          break;
        }
        case 'escalated': {
          if (named) {
            if (named.unknown) credit(named.item, 'onUnknown');
            credit(named.item, 'escalated');
            open.set(intent, { item: named.item });
            sentByItem.set(intent, named.item);
            break;
          }
          bump('escalated', String(b.reason ?? 'escalated'));
          open.set(intent, { item: null });
          break;
        }
        case 'approved': {
          const o = open.get(intent);
          open.delete(intent);
          if (!o?.item) break;
          credit(o.item, 'approved');
          const it = items.get(o.item);
          if (!it) break;
          const key = String(b.by ?? 'unknown');
          const a = it.approvedBy.get(key) ?? { keyId: key, name: people.get(key) ?? null, count: 0 };
          a.count++;
          it.approvedBy.set(key, a);
          break;
        }
        default: break;
      }
      days.push(new Date(e.at).toISOString().slice(0, 10));
    }
    for (const [, o] of open) if (o.item) credit(o.item, 'open');
    // PT34.4 item 5: the outcomes PS23 calls possibly executed and unknown, of an intent a person approved after an item sent
    // it, or of one allowed in its scope: an attempt lost or lapsed, and an exhausted completion.
    const approvedIntents = new Set([...sentByItem.keys()].filter((i) => r.events.some((e) => e.kind === 'verdict' && e.body.stage === 'gate' && e.body.outcome === 'approved' && String(e.body.intent) === i && period.holds(e.at))));
    const seen = new Set<string>();
    for (const e of r.events) {
      if (!period.holds(e.at)) continue;
      let intent: string | null = null;
      let outcome: UnknownOutcome['outcome'] | null = null;
      if (e.kind === 'observation' && e.body.stage === 'handler' && (e.body.outcome === 'lost' || e.body.outcome === 'lapsed')) { intent = String(e.body.intent); outcome = e.body.outcome; }
      if (e.kind === 'step' && typeof e.body.actionId === 'string' && e.body.actionId.endsWith(':exhausted')) { intent = e.body.actionId.slice(0, -':exhausted'.length); outcome = 'exhausted'; }
      if (!intent || !outcome || seen.has(`${intent}\u0000${outcome}`)) continue;
      const u: UnknownOutcome = { intent, run: r.run, effectKind: kinds.get(intent) ?? '', outcome, ...resolutionAfter(r.events, r.events.indexOf(e), r.lineage) };
      if (approvedIntents.has(intent)) { const it = items.get(sentByItem.get(intent)!); if (it) { it.unknownOutcomes.push(u); seen.add(`${intent}\u0000${outcome}`); } }
      else if (allowedIntents.has(intent)) { scopes.get(r.module)?.unknownOutcomes.push(u); seen.add(`${intent}\u0000${outcome}`); }
    }
  }

  const bundled = loadCatalogs(STD);
  const labelOf = (risk: string, recorded: { catalog: string; digest: string }[]): string | null => {
    const mit = recorded.find((c) => c.catalog === 'mit');
    if (!mit || mit.digest !== bundled.mit.digest) return null;
    return bundled.mit.labels.get(risk.replace(/^mit:/, '')) ?? null;
  };
  const catalogs = [...new Map(countedCerts.flatMap((c) => c.cert.poly?.risk?.catalogs ?? []).map((c) => [`${c.catalog}\u0000${c.version}\u0000${c.digest}`, c])).values()].sort(by((c) => `${c.catalog}\u0000${c.version}`));
  const riskIds = [...new Set([...items.values()].flatMap((i) => i.risks))].sort();
  const itemJson = (i: NonNullable<ReturnType<typeof items.get>>) => ({
    id: i.id, kind: i.kind, controls: [...i.controls].sort(), signer: i.signer, signerName: i.signerName, sequence: i.sequence, ...(i.verdict ? { verdict: i.verdict } : {}), counts: i.counts,
    approvedBy: [...i.approvedBy.values()].sort(by((a) => a.keyId)),
    unknownOutcomes: [...i.unknownOutcomes].sort(by((u) => `${u.intent}\u0000${u.outcome}`)),
  });
  const risks = riskIds.map((id) => ({ id, label: labelOf(id, catalogs), items: [...items.values()].filter((i) => i.risks.includes(id)).sort(by((i) => i.id)).map(itemJson) }));
  const uncovered = [...new Set(countedCerts.flatMap((c) => (c.cert.poly?.risk?.exposure ?? []).filter((r) => ![...Object.values(c.cert.poly?.risk?.items ?? {})].some((x) => x.risks.includes(r)))))].sort().map((id) => ({ id, label: labelOf(id, catalogs) }));
  const untagged = [...items.values()].filter((i) => !i.risks.length).sort(by((i) => i.id)).map((i) => ({ id: i.id, kind: i.kind, scope: i.scope, counts: i.counts }));
  for (const [id, c] of untaggedExtra) if (!items.has(id)) untagged.push({ id, kind: c.kind, scope: c.scope, counts: c.counts });
  untagged.sort(by((i) => i.id));
  const mit = catalogs.find((c) => c.catalog === 'mit');
  const sortedDays = [...new Set(days)].sort();
  return {
    v: 1,
    meaning: MEANING,
    attribution: attributionLine(mit?.version ?? bundled.mit.version),
    period: { asked: period.asked, from: period.from ?? sortedDays[0] ?? null, to: period.to ?? sortedDays.at(-1) ?? null },
    store: { runs, counted: counted.length, notCounted: notCounted.sort(by((x) => x.run)), trusted: Object.keys(trust).sort() },
    // PT34.4 items 8 and 9, RT25: a certificate is named by its digest and build id, not by the path given, which
    // depends on the host.
    certificates: certs.map((c) => ({ digest: c.digest, buildId: c.buildId, signers: c.signers, verified: c.problem === null, ...(c.problem ? { problem: c.problem } : {}), counted: counted.filter((r) => r.c === c).length })).sort(by((c) => c.digest)),
    catalogs,
    risks,
    scopes: [...scopes.values()].map((s) => ({ ...s, unknownOutcomes: [...s.unknownOutcomes].sort(by((u) => `${u.intent}\u0000${u.outcome}`)) })).sort(by((s) => s.scope)),
    runtime: [...runtime.values()].sort(by((x) => `${x.kind}\u0000${x.reason}\u0000${x.endedBy ?? ''}`)),
    uncovered,
    untagged,
    unidentified: unidentified.sort(by((x) => x.run)),
    ambiguous: ambiguous.sort(by((x) => x.run)),
  };
}

/**
 * PT34.4 item 5: the person's resolution of an unknown outcome, the first accepted step of the run after it that was
 * dispatched from outside with claims: its lineage starts a chain and its origin holds claims. By action and seq only.
 */
function resolutionAfter(events: { kind: string; body: Record<string, any> }[], at: number, lineage: Map<number, { origin: unknown; prev: string | null }>): { resolution?: { action: string; seq: number } } {
  for (const e of events.slice(at + 1)) {
    if (e.kind !== 'step' || e.body.stepKind !== 'accepted') continue;
    const l = lineage.get(Number(e.body.seq));
    if (l && l.prev === null && l.origin !== null && typeof l.origin === 'object') return { resolution: { action: String(e.body.action), seq: Number(e.body.seq) } };
  }
  return {};
}

/** The JSON form: RFC 8785, one line. */
export const reportJson = (j: Record<string, unknown>): string => canonicalize(j) + '\n';

/** The Markdown, rendered from the JSON alone (PT34.4 items 6 and 8). */
export function reportMarkdown(j: any): string {
  const out: string[] = [];
  const cell = (s: unknown) => String(s ?? '').replace(/\|/g, '\\|');
  const signer = (i: any) => (i.signer ? `${i.signerName ? `${i.signerName} (${i.signer})` : i.signer}${i.sequence !== null ? `, sequence ${i.sequence}` : ''}` : 'not signed');
  const resolved = (u: any) => (u.resolution ? `; resolved by ${u.resolution.action} at seq ${u.resolution.seq}` : '; no resolution recorded');
  const outcomes = (list: any[]) => list.map((u) => `- ${u.outcome}: intent \`${u.intent}\` (${u.effectKind}), run ${u.run}${resolved(u)}`);
  out.push('# Risk report', '', `*${j.meaning}*`, '');
  out.push(j.attribution, '');
  out.push(`- Period: ${j.period.asked ? `${j.period.asked} (${j.period.from} to ${j.period.to}, UTC)` : j.period.from ? `${j.period.from} to ${j.period.to} (the first and last day of the counted events, UTC)` : 'no event counted'}`);
  out.push(`- Runs: ${j.store.runs} with a gate record; ${j.store.counted} counted, ${j.store.notCounted.length} not verified, ${j.unidentified.length} with no certificate identified, ${j.ambiguous.length} with two`);
  if (!j.store.trusted.length) out.push('- No key was given with --trust, so no run verifies and no run is counted.');
  else out.push(`- Keys trusted: ${j.store.trusted.join(', ')}`);
  for (const c of j.certificates) out.push(`- Certificate of build ${c.buildId}: ${c.digest}, signed by ${c.signers.join(', ') || 'nobody'}${c.verified ? '' : `; not verified: ${c.problem}`}; ${c.counted} run(s) matched`);
  for (const c of j.catalogs) out.push(`- Catalog ${c.catalog}: ${c.version}, ${c.digest}`);
  out.push('');
  for (const r of j.risks) {
    out.push(`## ${r.id}${r.label ? ` ${r.label}` : ''}`, '');
    const decided = r.items.some((i: any) => Object.values(i.counts).some((n) => (n as number) > 0));
    if (!decided) out.push('*no decision in the period*', '');
    out.push('| Item | Kind | Controls | Signer | Refused | Sent to a person | Approved | Timed out | Open | On unknown input |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const i of r.items) {
      const c = i.counts;
      const decides = i.kind !== 'recalled' && i.kind !== 'never';
      out.push(`| ${cell(i.id)} | ${i.kind} | ${cell(i.controls.join(', ') || 'none')} | ${cell(signer(i))} | ${decides ? [c.refused, c.escalated, c.approved, c.timedOut, c.open, c.onUnknown].join(' | ') : i.kind === 'never' ? `${i.verdict ?? 'proved'} by the check | | | | |` : 'declared | | | | |'} |`);
    }
    out.push('');
    const approvals = r.items.flatMap((i: any) => i.approvedBy.map((a: any) => `- ${i.id}: approved ${a.count} time(s) by ${a.name ? `${a.name} (${a.keyId})` : a.keyId}`));
    if (approvals.length) out.push(...approvals, '');
    const unknown = r.items.flatMap((i: any) => i.unknownOutcomes.map((u: any) => ({ ...u, item: i.id })));
    if (unknown.length) out.push('Outcomes possibly executed and unknown (PS23):', ...unknown.map((u: any) => `- ${u.item}: ${u.outcome}, intent \`${u.intent}\` (${u.effectKind}), run ${u.run}${resolved(u)}`), '');
  }
  out.push('## Allowed in each scope', '', 'An allow names no rule, so allows are counted per scope and no item is credited with one.', '', '| Scope | Allowed |', '|---|---|');
  for (const s of j.scopes) out.push(`| ${cell(s.scope)}${s.open ? ' (open: no policy governs it)' : ''} | ${s.allowed} |`);
  const scopeUnknown = j.scopes.flatMap((s: any) => s.unknownOutcomes);
  if (scopeUnknown.length) out.push('', 'Outcomes possibly executed and unknown (PS23):', ...outcomes(scopeUnknown));
  out.push('', '## Refused by the runtime (no rule)', '');
  const refused = j.runtime.filter((x: any) => x.kind === 'refused');
  if (refused.length) { out.push('| Reason | Refusals |', '|---|---|'); for (const x of refused) out.push(`| ${cell(x.reason)} | ${x.count} |`); } else out.push('None in the period.');
  out.push('', '## Escalated by the runtime (no rule)', '');
  const escalated = j.runtime.filter((x: any) => x.kind === 'escalated');
  if (escalated.length) {
    out.push('| Cause | Sent to a person | Then denied by rule 2 (escalate-once) |', '|---|---|---|');
    for (const cause of [...new Set(escalated.map((x: any) => x.reason as string))].sort()) {
      const direct = escalated.filter((x: any) => x.reason === cause && !x.endedBy).reduce((n: number, x: any) => n + x.count, 0);
      const once = escalated.filter((x: any) => x.reason === cause && x.endedBy === 'escalate-once').reduce((n: number, x: any) => n + x.count, 0);
      out.push(`| ${cell(cause)} | ${direct} | ${once} |`);
    }
  } else out.push('None in the period.');
  out.push('', '## Exposed and not covered', '');
  if (j.uncovered.length) out.push('Listed as an exposure, and named by no item in mitigates:', '', ...j.uncovered.map((u: any) => `- ${u.id}${u.label ? ` ${u.label}` : ''}`)); else out.push('Every exposed risk is named by an item.');
  out.push('', '## Rules that name no risk', '');
  if (j.untagged.length) {
    out.push('| Item | Kind | Refused | Sent to a person | Approved | Timed out | Open | On unknown input |', '|---|---|---|---|---|---|---|---|');
    for (const i of j.untagged) { const c = i.counts; out.push(`| ${cell(i.id)} | ${i.kind} | ${[c.refused, c.escalated, c.approved, c.timedOut, c.open, c.onUnknown].join(' | ')} |`); }
  } else out.push('None.');
  out.push('', '## Runs not counted', '');
  if (j.store.notCounted.length) out.push(...j.store.notCounted.map((x: any) => `- ${x.run}: ${x.problem}`)); else out.push('None: every run with a gate record verified.');
  out.push('', '## How the counts are made', '',
    '- Every run of the store is verified as `poly journal verify` verifies it; a run that does not verify is not counted.',
    '- A run is counted under the certificate whose machine versions and policy set it recorded, and its tags come from that certificate, never from the sources on disk.',
    '- Allows are counted per scope: an allow names no rule, so no item is credited with one.',
    '- One item per refusal: the engine reports the first item that refused a proposal, so another item that would also have refused it is not credited.',
    '- An escalation is followed through the intent\'s later events in the period: approved, refused at its timeout, or open at the end of the period.',
    '- An escalation the runtime made, which rule 2 of PT9.7 then denied escalate-once, is counted under its cause, never as a refusal and never for an item.',
    '- The period is selected by the event\'s UTC day.');
  if (j.unidentified.length) out.push('', '## Certificate not identified', '', ...j.unidentified.map((x: any) => `- ${x.run}: no certificate given records its module digests and policy set`));
  if (j.ambiguous.length) out.push('', '## Certificate ambiguous', '', ...j.ambiguous.map((x: any) => `- ${x.run}: matched by ${x.certificates.join(', ')}`));
  return out.join('\n') + '\n';
}

