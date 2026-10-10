// The host runtime API (PT15): polyrun's runtime with the certificate check at load, the ledger written in each
// step's transaction (S121), and, from the outbox worker on, the gate interface (S118, S119).
//
//   const rt = await load('./.poly/build', { certificate: './.poly/certificate.json', trust: { 'ops-2026': pem },
//                                           store: { sqlite: './orders.db' } })
//   const order = await rt.create('orders.Order')
//   const r = await rt.dispatch(order.id, 'Place', {}, { actionId: 'req-7781' })
//
// What M4's runtime does not do is stated in the certificate's `limits` and printed with it (S118, S134, S135).
import { digest } from '@cognitive-fab/polyflow-kernel/digest';
import { personKeyVerifier, evidenceOf as claimsEvidence, chainProblem, withinScope, type Verifier, type Evidence, type Mandate } from './verifier.js';
import { lineageDigest, type Lineage } from './ledger-store.js';
import { capabilitiesFor, withinPrefix, CapabilityRefused, CredentialUnavailable, CREDENTIAL_HANDLE, type ApiTransport, type ContentAccess, type Transports } from './capabilities.js';
import type { ChannelAdapter, ChannelTransports, HttpRequest, HttpResponse, IngressAnswer, SourceAdapter, VaultAdapter, Verified, Webhook } from './adapters.js';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createRuntime, type Runtime, type DispatchResult, type JournalRow } from '@cognitive-fab/polygraph/polyrun/src/index.mjs';
import { RESERVED_MODULE, grantRequestSubject, memoryVerifySubject, forgetSubject, recordAnchor, recordDigest, revocationSubject, verifyRecord, type Certificate, type SignedRecord } from '@poly/core';
import { LedgerStore, openLedgerStore, InputOutsideType } from './ledger-store.js';
import { contentValues, dataOutside } from './types.js';
import { verifyBuild, recheckCopy, LoadError, type VerifiedBuild, type VerifiedWorkflow, type WorkOrderTool } from './load.js';
import { deriveKey, keyFields, keyOfRun, runIdOf, WorkflowError } from './workflows.js';
import { verifyRunChain, type LedgerEvent, type ChainResult } from './ledger.js';
import { EffectWorker, ALLOW_ALL, type Gate, type EffectHandler, type WorkerDrift, type ReportOutcome, parseOrderId } from './worker.js';
import { verifiedModels, modelSource, BOUNDS } from './model.js';
import { PolicyGate, type PolicyGateOptions, type ProgramView, type SessionEvent, type SessionReplay } from './policy-gate.js';
import { polyaxionPeer, loadPolyaxion } from './peers.js';
import { decisionHandler, mapDigest, type DecisionMemory, type DecisionRecord, type Provider, type ProviderConfig } from './provider.js';
import { Memory, BOTTOM, DIGEST, SourceRefused, type Taint } from './memory.js';
import { RoutingHost } from './routing.js';
import { signHeads, headsOf, publishAnchor, verifyRun, evidenceOf, type LedgerSigner, type SignedHead, type Anchor, type RunVerification , countersignHeads, type CountersignAdapter, type Countersignature } from './journal.js';

export { LoadError };

export interface LoadOptions {
  certificate: string;
  /** Trusted admission keys: key id to public key, PEM. The runtime never reads a private key at load. */
  trust: Record<string, string>;
  /** S135: SQLite only. ':memory:' when omitted. */
  store?: { sqlite: string };
  /** S190, for tests only: the std root a certificate's `std:` paths are read under, instead of the repository's std/. */
  std?: string;
  /** Ruled on step 9, for tests only: the Polyaxion checkout to check against its pin, instead of the sibling one. */
  policyEngine?: string;
  /** For one test only (ruled on step 9): a recipient digest without the store's key, the seeded control. */
  fault?: (typeof RUNTIME_FAULTS)[number];
  now?: () => number;
  /** S139: load a witness certificate, for an exported witness test only; refused when NODE_ENV is production. */
  allowWitness?: boolean;
  /**
   * S118: the gate interface; allow-all when omitted, and the policy gate when the build has policies (PT9). `policy`
   * configures the policy gate; a build with policies takes no other gate.
   */
  gate?: { gate?: Gate; escalationTimeoutMs?: number; policy?: PolicyGateOptions };
  worker?: { leaseMs?: number; batch?: number; drift?: WorkerDrift };
  /** S123: the head signer, and how often heads are signed and anchors published, off the step path. */
  ledger?: LedgerSigner & { headMs?: number; anchorMs?: number };
  /** PD5.1.4, K11: the verifier adapter for actions with claims; the person-key adapter over the certified keyrings by default (S107). */
  verifier?: Verifier;
  /**
   * S134, S151: the host functions handlers' capabilities are built over. poly-runtime imports no network module;
   * each capability checks a call against its effect's declared targets before calling the transport.
   */
  transports?: Transports;
}

export type Handler = EffectHandler;

/** An outside dispatch that the runtime refuses before any step, with an audit row (K9, K10). */
/** PD2.4: an adjudication with no decision event to link; a checked program cannot reach it (PL6203). */
/** S173: an open work order, as an agent takes it: the gate's decision is the intent's, once; the order id is the attempt's (PF8.5a, S173 as amended). */
export interface WorkOrder { orderId: string; intent: string; /** PT10, S173 as amended: the intent's id, the same for every attempt; it names nothing a report can give. */ idempotencyKey: string; instanceId: string; workflow: string; kind: string; tool: string; target?: string; why: string; args: Record<string, unknown>; attempt: number; deadline: number }

/** S189: the runtime's own ledger run for the approvals drop folder; `runtime.*` is reserved for the runtime (S143). */
export const APPROVALS_RUN = 'runtime:approvals';
/** E13: the vendored polygraph's version, from its package.json beside the kernel's entry point. */
function polygraphVersion(): string {
  let dir = dirname(createRequire(import.meta.url).resolve('@cognitive-fab/polygraph/polyrun/src/index.mjs'));
  for (let i = 0; i < 6; i++) {
    const p = join(dir, 'package.json');
    if (existsSync(p)) { const j = JSON.parse(readFileSync(p, 'utf8')) as { name?: string; version?: string }; if (j.name === '@cognitive-fab/polygraph' && j.version) return j.version; }
    dir = dirname(dir);
  }
  return '0.0.0';
}

/** PS15.4: the runtime's own run, on which every inbound message's delivery or refusal is journaled. */
export const INGRESS_RUN = 'runtime:ingress';
/** S205: the runtime's own run, on which every erasure of a body or an address is journaled. */
export const CONTENT_RUN = 'runtime:content';
/** PS17.5: the runtime's own run where memory verifications are recorded. */
export const MEMORY_RUN = 'runtime:memory';

/** S182, plan step 10: the adapters @poly/io makes, by the name a channel declares (`adapter "whatsapp"`). */
export const IO_ADAPTERS = ['whatsapp', 'sms', 'email', 'slack', 'webhook'];

/**
 * S182, PT20.2: the installed runtime adapter package, pinned by name, version and digest: SHA-256 over each of its
 * files the runtime loads (its package.json and every module under dist/src), path and digest, in path order.
 */
export function adapterPackagePin(): { package: string; version: string; digest: string } {
  const entry = realpathSync(createRequire(import.meta.url).resolve('@poly/io'));
  const root = dirname(dirname(dirname(entry)));
  const files: string[] = [];
  const walk = (d: string): void => { for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(join(root, 'dist', 'src'));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string; version: string };
  const h = createHash('sha256');
  for (const f of [join(root, 'package.json'), ...files]) h.update(`${relative(root, f).split(sep).join('/')} ${createHash('sha256').update(readFileSync(f)).digest('hex')}\n`);
  return { package: pkg.name, version: pkg.version, digest: `sha256:${h.digest('hex')}` };
}

/** What rt.inbound and rt.receive did with one message (PT21.4). */
export interface InboundResult {
  outcome: 'delivered' | 'refused';
  reason?: 'unknown-thread' | 'thread-not-started' | 'creation-unavailable' | 'claims-unverified' | 'outside-type';
  application: string;
  conversation: string;
}

/** PT28.1b: an action of a machine's generated declarations, `{ action, data }`. */
export type HostAction = { action: string; data: unknown };
/** The data of action K of T; unknown when T is the untyped default. */
export type DataOf<T extends HostAction, K> = string extends T['action'] ? unknown : Extract<T, { action: K }>['data'];
/**
 * rt.dispatch's arguments after the instance: one tuple per action of T, so the data is the named action's; untyped when
 * T is the default.
 */
export type DispatchArgs<T extends HostAction, O> = string extends T['action'] ? [action: string, data?: unknown, opts?: O] : T extends HostAction ? [action: T['action'], data: T['data'], opts?: O] : never;
type DispatchOpts = { actionId?: string; credentials?: unknown; [SUPPLIED_CLAIMS]?: Record<string, unknown>; [GRANT_STEP]?: true };

/** K11, PT21.4: the claims the runtime itself supplies for an Inbound (the adapter's verified output), never a caller. */
const SUPPLIED_CLAIMS = Symbol('supplied claims');
/** PS16.4, review B2 (M9): a dispatch the runtime makes to a grant, from its own sources. */
const GRANT_STEP = Symbol('grant step');
/** The Grant's actions only the runtime takes: from the vault's callback, rt.requestGrant, the refresh's completion, and PS16.4's sources. */
const GRANT_ONLY = new Set(['Callback', 'Reauthorize', 'Refreshed', 'RefreshFailed', 'Revoke']);

/** Deliberately broken runtimes, for one test each: the recipient digest without the store's key (ruled on step 9). */
export const RUNTIME_FAULTS = ['unkeyed-recipient', 'address-in-clear'] as const;

/**
 * S182: the certified adapter package as the runtime loaded it: whether it made an adapter, and (S460) the credential
 * handle a source adapter was built with, or null. A package with no credentialHandleOf answers none.
 */
export interface IoPackage { madeHere(a: unknown): boolean; credentialHandleOf?(a: unknown): unknown }

/** A name under `dir` that no file has yet: `name`, else `name.2`, `name.3`, ... so a record is never overwritten. */
function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  for (let k = 2; ; k++) if (!existsSync(join(dir, `${name}.${k}`))) return `${name}.${k}`;
}

export class OutcomeWithoutDecision extends Error {
  constructor(message: string) { super(message); this.name = 'OutcomeWithoutDecision'; }
}

/** PT12.5: an approval that is not a person's signed record for a waiting escalation. Audited, with no effect. */
/** S189: why an approval was refused, as the drop folder names it. */
export type ApprovalRefusal = 'not-a-record' | 'wrong-key' | 'unmatched' | 'replayed' | 'expired' | 'wrong-project' | 'holder-mismatch';

export class ApprovalRefused extends Error {
  constructor(message: string, readonly reason: ApprovalRefusal = 'unmatched') { super(message); this.name = 'ApprovalRefused'; }
}

export class RefusedDispatch extends Error {
  constructor(message: string, readonly rule: string) { super(message); this.name = 'RefusedDispatch'; }
}

export class PolyRuntime {
  /**
   * The handlers by kind. Review D-F2 (M8b): private to the runtime, so a handler is added only by rt.handle, by
   * rt.provide or by rt.connectChannel, each with its own checks.
   */
  readonly #handlers = new Map<string, Handler>();
  /**
   * S182: the certified adapter package, as this runtime loaded it (given at load when the certificate binds
   * adapters). Review D-F2 (M8b): private and set once, so no host can put in a package that calls a look-alike its own.
   */
  readonly #ioPackage: IoPackage | null;
  /** For one test each: a deliberately broken runtime (RUNTIME_FAULTS). */
  readonly #fault: LoadOptions['fault'];
  /** Review D-F4 (M8b): each channel's connected adapter, with which rt.receive verifies the channel's webhooks. */
  readonly #adapters = new Map<string, ChannelAdapter>();
  /** S460: each source credential handle this runtime made, and the credential it is for. */
  readonly #handles = new WeakMap<object, string>();
  /** PT10f: each credential's certified vault. */
  readonly #vaults = new Map<string, VaultAdapter>();
  /** PS18.2, PS18.4: the routes' and budgets' instances, reservations and tier providers. */
  readonly #routing: RoutingHost;
  private readonly channelSenders = new Map<string, { kind: string; sender: string }>();
  /** Review A-F2: approvals entries refused or applied but not movable, journaled once and passed over since. */
  private readonly unmovable = new Set<string>();
  readonly worker: EffectWorker;
  /** Review B5: whether a gate was given at load; only then are recorded gate decisions recomputed. */
  readonly gateGiven: boolean;
  /** S173: each workflow's work-order kinds, by machine id, with the tool each maps to. */
  private readonly orderTools = new Map<string, Map<string, WorkOrderTool & { workflow: string }>>();
  /** PD2.2: each decision's record, from the provider's return to its completion's commit, by intent id. */
  private readonly records = new Map<string, DecisionRecord>();
  private readonly inputSubscribers = new Map<string, Set<(step: unknown) => void>>();
  private readonly intentSubscribers = new Map<string, Set<(intent: unknown) => void>>();
  private timers: NodeJS.Timeout[] = [];

  /** S142: the exports of each certified handler file, as the runtime imported it from its verified copy. */
  private readonly certified: Map<string, Readonly<Record<string, unknown>>>;
  private readonly certifiedFunctions: Set<unknown>;

  /** PT9: the policy gate, when the build has policies. */
  readonly policyGate: PolicyGate | null;

  /** PD5.1.4: the verifier adapter. */
  private readonly verifier: Verifier;

  /** PS17 (M10): the taint of each body, the item sets retrievals return, and the sources' adapters. */
  readonly memory: Memory;

  constructor(readonly kernel: Runtime, readonly store: LedgerStore, readonly verified: VerifiedBuild, readonly ledger: LoadOptions['ledger'] = undefined, opts: Pick<LoadOptions, 'gate' | 'worker' | 'transports' | 'verifier' | 'fault'> & { certified?: Map<string, Readonly<Record<string, unknown>>>; policyGate?: PolicyGate | null; ioPackage?: IoPackage | null } = {}) {
    this.policyGate = opts.policyGate ?? null;
    this.#ioPackage = opts.ioPackage ?? null;
    this.#fault = opts.fault;
    this.verifier = opts.verifier ?? personKeyVerifier(verified.certificate.poly.keyrings ?? { people: [], agents: [] });
    this.certified = opts.certified ?? new Map();
    this.certifiedFunctions = new Set([...this.certified.values()].flatMap((ns) => Object.values(ns).filter((v) => typeof v === 'function')));
    this.gateGiven = opts.gate?.gate !== undefined || this.policyGate !== null;
    store.decisionCompletions = (machineId) => this.decisionCompletions(machineId);
    store.allowWitnessCompletions = verified.certificate.purpose === 'witness';
    for (const w of verified.workflows) {
      if (!this.orderTools.has(w.machine)) this.orderTools.set(w.machine, new Map());
      for (const [kind, t] of Object.entries(w.tools)) this.orderTools.get(w.machine)!.set(kind, { ...t, workflow: w.name });
    }
    this.memory = new Memory(store, verified.memory.sources, verified.memory.flows);
    const builtins: Record<string, EffectHandler> = {};
    for (const m of verified.machines) for (const kind of Object.keys(m.manifest?.effects ?? {})) if (kind.startsWith('outcome.')) builtins[kind] = () => ({});
    // PS17.2, PS17.5: a retrieval and a remember are the runtime's own effects, run through the source's certified
    // adapter. S41 with S451 (ruled 2026-10-09): every retrieval of a source shares its kind, so each intent runs the
    // entry of its own machine's manifest, never one entry for the program (the last machine's, before the ruling).
    type RetrieveSpec = { source: string; owner: string | null; key?: { name: string; param: string }; limit: number; envelope?: boolean };
    type RememberSpec = { source: string; provenance: string; about: string };
    const perMachine = new Map<string, Map<string, { retrieve?: RetrieveSpec; remember?: RememberSpec }>>();
    for (const m of verified.machines) for (const [kind, e] of Object.entries(m.manifest?.effects ?? {})) {
      if (!e?.retrieve && !e?.remember) continue;
      const retrieve = e.retrieve as RetrieveSpec | undefined;
      // PS17.2, S459: an envelope retrieval, of kind source.<s>.envelope, names its key.
      if (retrieve?.envelope === true && !retrieve.key) throw new LoadError(`refused at load: the envelope retrieval ${kind} names no key (PT10j, S459)`);
      if (!perMachine.has(kind)) perMachine.set(kind, new Map());
      perMachine.get(kind)!.set(m.id, { ...(retrieve ? { retrieve } : {}), ...(e.remember ? { remember: e.remember as RememberSpec } : {}) });
    }
    const specOf = (kind: string, instanceId: string) => {
      const machine = this.store.db.prepare('SELECT machine_id FROM pr_instance WHERE instance_id = ?').get(instanceId)?.machine_id as string | undefined;
      const spec = machine ? perMachine.get(kind)?.get(machine) : undefined;
      if (!spec) throw new SourceRefused(`no machine of the build declares ${kind} for instance ${instanceId} (PS17.2)`);
      return spec;
    };
    for (const kind of perMachine.keys()) {
      builtins[kind] = (payload, _caps, ctx) => {
        const s = specOf(kind, ctx.instanceId);
        const data = (payload ?? {}) as Record<string, unknown>;
        // PS17.2, S459: an envelope retrieval completes with its body's digest as r.envelope.
        if (s.retrieve?.envelope === true) return this.memory.envelope(s.retrieve.source, { owner: s.retrieve.owner, key: s.retrieve.key! }, data);
        if (s.retrieve) return this.memory.retrieve(s.retrieve.source, s.retrieve, data, ctx.idempotencyKey);
        return this.memory.remember(s.remember!, data, ctx.instanceId, ctx.idempotencyKey, this.now());
      };
    }
    this.memory.body = (d) => this.contentBody(d);
    // PS18.2: a route's call runs its tier's provider, through the runtime's own handler.
    this.#routing = new RoutingHost(kernel, store, verified.routes, verified.budgets, () => this.now(), this.records, (r) => verified.machines.find((x) => x.id === r.decision.machine)?.manifest?.effects?.[`decision.${r.decision.name}`]?.decision?.result ?? null);
    for (const r of verified.routes) builtins[r.effectKind] = this.#routing.handler(r);
    // PS18.4a (S454): each unrouted decision's budget, as its certified manifest entry gives it.
    for (const m of verified.machines) for (const [kind, e] of Object.entries(m.manifest?.effects ?? {})) {
      if (e?.decision?.budget && !e.decision.route) this.#routing.decisionBudgets.set(`${m.id}\u0000${kind}`, e.decision.budget);
    }
    // S402: a tier's call reads its decision's materials, as the decision's own provider would (PS17.2).
    this.#routing.materials = async (payload) => { const m = await this.memory.materials(payload, (d) => this.contentBody(d), (b, t, s) => this.#putTainted(b, t, s)); return { bodies: m.bodies, items: m.items }; };
    this.worker = new EffectWorker(kernel, store, this.#handlers, {
      gate: this.policyGate ?? opts.gate?.gate ?? ALLOW_ALL, escalationTimeoutMs: opts.gate?.escalationTimeoutMs, ...opts.worker, builtins,
      outsideType: (instanceId, action, data) => this.outsideType(instanceId, action, data),
      // S180: an effect's completion is marked like a dispatch when its Content names no body.
      markContent: (instanceId, action, data) => {
        const id = this.store.db.prepare('SELECT machine_id FROM pr_instance WHERE instance_id = ?').get(instanceId)?.machine_id as string | undefined;
        return id ? this.markContent(id, action, data) as Record<string, unknown> : data;
      },
      // PD2.2, K10: the decision event is written with the completion step, in its transaction.
      beforeCompletion: (row, decl) => {
        // PS18.6: a tier's call writes its own decision event, with its usage and cost, on the route's instance.
        const record = decl?.decision || this.#routing.tierOf(row) ? this.records.get(row.intent_id) : undefined;
        if (record) this.store.pending.set(`${row.instance_id}\u0000${row.intent_id}:done`, { before: [{ kind: 'decision', body: record }] });
      },
      capabilities: (row, decl) => capabilitiesFor(decl ?? {}, opts.transports ?? {}, async (reason) => {
        await this.store.insertAudit({ at: this.now(), instanceId: row.instance_id, action: row.kind, actionId: row.intent_id, rule: 'PL6406', reason });
      }, this.apiFor(decl, (row.payload ?? {}) as Record<string, unknown>), this.#contentFor(row)),
      onAllowed: (row, proposal) => { for (const f of this.intentSubscribers.get(row.kind) ?? []) f({ intent: row.intent_id, kind: row.kind, instance: row.instance_id, seq: row.seq, payload: row.payload, proposal }); },
      afterCompletion: (row) => { this.store.pending.delete(`${row.instance_id}\u0000${row.intent_id}:done`); this.records.delete(row.intent_id); },
      // PT25.1, S185: a send of channel.<c>.send is proposed with its channel: the name, the kind, the recipient as a
      // keyed digest (never the address itself, G10), its class (external in M8, S181), and the message kind it carries.
      outsideMandate: (row) => this.outsideMandate(row.instance_id, row.seq, row.kind, (row.payload ?? {}) as Record<string, unknown>),
      grantCheck: (row, decl) => this.grantCheck(row.instance_id, decl, (row.payload ?? {}) as Record<string, unknown>),
      // PS17.3a, PT10j (S459): an effect whose entry names an envelope parameter sends only with an envelope the runtime
      // stored from its source; none, or any other value, is denied envelope-origin, before the memory check.
      envelopeCheck: (row, decl) => {
        const e = decl?.envelope;
        if (e === undefined || e === null) return null;
        // An entry's envelope that is no parameter name is denied too: fail closed.
        const v = typeof e === 'string' ? ((row.payload ?? {}) as Record<string, unknown>)[e] : undefined;
        return this.memory.isEnvelope(v) ? null : { deny: 'envelope-origin' };
      },
      // PT10k (S302, S307): the flow rule and freshness, before the grant check and the policy.
      memoryCheck: (row, decl, approved) => {
        if (!this.memory.flows.size) return null;
        // S402, PT10r: a tier's call is judged as its decision is, over the decision's payload: its taint and items.
        const tier = this.#routing.tierOf(row as never);
        if (tier) {
          const d = this.store.db.prepare('SELECT instance_id, seq, kind FROM pr_outbox WHERE intent_id = ?').get(tier.decision.intent) as { instance_id: string; seq: number; kind: string } | undefined;
          const dm = d ? this.store.db.prepare('SELECT machine_id FROM pr_instance WHERE instance_id = ?').get(d.instance_id)?.machine_id as string | undefined : undefined;
          if (!d || !dm) return null;
          const dj = this.store.db.prepare('SELECT action, data FROM pr_journal WHERE instance_id = ? AND seq = ?').get(d.instance_id, d.seq) as { action: string; data: string } | undefined;
          const dc = dj ? JSON.parse(dj.data)?.$claims : null;
          return this.memory.check({ instance: d.instance_id, machineId: dm, kind: d.kind, payload: (tier.decision.payload ?? {}) as Record<string, unknown>, decl: { decision: true }, step: { action: dj?.action ?? null, claims: dc && typeof dc === 'object' ? dc : null }, channelAudience: null, approved, now: this.now(), keyed: (s) => store.recipientDigest(`principal:${s}`) });
        }
        const machineId = this.store.db.prepare('SELECT machine_id FROM pr_instance WHERE instance_id = ?').get(row.instance_id)?.machine_id as string | undefined;
        if (!machineId) return null;
        const j = this.store.db.prepare('SELECT action, data FROM pr_journal WHERE instance_id = ? AND seq = ?').get(row.instance_id, row.seq) as { action: string; data: string } | undefined;
        const claims = j ? JSON.parse(j.data)?.$claims : null;
        const ch = /^channel\.([A-Za-z_][A-Za-z0-9_]*)\.send$/.exec(row.kind);
        return this.memory.check({ instance: row.instance_id, machineId, kind: row.kind, payload: (row.payload ?? {}) as Record<string, unknown>, decl, step: { action: j?.action ?? null, claims: claims && typeof claims === 'object' ? claims : null }, channelAudience: ch ? verified.channels.find((c) => c.channel === ch[1])?.audience ?? null : null, approved, now: this.now(), keyed: (s) => store.recipientDigest(`principal:${s}`) });
      },
      // PS18.4, S353: a tier's call is read against its budget before any policy, and reserved with its allow.
      budgetCheck: (row, approved) => this.#routing.budgetCheck(row, approved),
      reserve: (row, plan) => this.#routing.reserve(row, plan),
      onTerminal: (row, action) => this.#routing.settle(row, action),
      issueRoute: (row, decl) => this.#issueRoute(row, decl),
      sweep: () => this.#sweepRoutes(),
      channelOf: (row) => {
        const m = /^channel\.([A-Za-z_][A-Za-z0-9_]*)\.send$/.exec(row.kind);
        const d = m && verified.channels.find((c) => c.channel === m[1]);
        if (!m || !d) return null;
        // Review D-F8 (M8b): only the channel's conversation sends on it; the compiler refuses an author's effect of
        // this kind (PL1208), and an instance of another machine is never proposed as the channel's.
        const machine = this.store.db.prepare('SELECT machine_id FROM pr_instance WHERE instance_id = ?').get(row.instance_id)?.machine_id;
        const suffix = `/${m[1]}`;
        if (machine !== d.conversation || !row.instance_id.startsWith(`${m[1]}:`) || !row.instance_id.endsWith(suffix)) return null;
        const key = row.instance_id.slice(m[1].length + 1, -suffix.length);
        const p = (row.payload ?? {}) as { kind?: unknown };
        // Ruled on step 9: keyed by the store's key, so the journaled proposal cannot be inverted to the address.
        // The seeded control hashes the address itself, which the key is the keyed digest of (S191).
        const recipient = opts.fault === 'unkeyed-recipient' ? `sha256:${createHash('sha256').update(`${d.kind}:${this.addressOf(key) ?? key}`).digest('hex')}` : store.recipientDigest(`${d.kind}:${key}`);
        return { name: m[1], kind: d.kind, recipient, recipientClass: 'external', ...(typeof p.kind === 'string' ? { messageKind: p.kind } : {}) };
      },
      workOrder: (row) => {
        const t = this.orderToolOf(row.instance_id, row.kind);
        return t ? { tool: t.tool, ...(t.target !== undefined ? { target: t.target } : {}), why: t.why } : null;
      },
    });
    // PD2.4, S129: an adjudication's outcome event, linked to the run's most recent decision event for its decision.
    store.onOutbox = (instanceId, rows) => rows.filter((r) => r.kind.startsWith('outcome.')).map((r) => {
      const decision = r.kind.slice('outcome.'.length);
      const link = store.lastDecision(instanceId, decision);
      if (!link) throw new OutcomeWithoutDecision(`${instanceId} adjudicates ${decision}, and the run has no decision event for it (PD2.4, S129)`);
      return { kind: 'outcome', body: { decision, outcome: (r.payload as { outcome: string }).outcome, intent: r.intentId, decisionEvent: link } };
    });
    kernel.events.on('step', (step) => {
      for (const f of this.inputSubscribers.get(step.instanceId) ?? []) f(step);
    });
  }

  get now(): () => number { return this.kernel.now; }
  get certificate(): Certificate { return this.verified.certificate; }
  /** The project root the certificate's paths are relative to. */
  get root(): string { return this.verified.root; }
  /** The verified copy of a machine's lowered module, the bytes polyrun registered. */
  modulePath(machineId: string): string {
    const m = this.verified.machines.find((x) => x.id === machineId);
    if (!m) throw new Error(`machine ${machineId} is not in the certificate`);
    return m.module;
  }
  /** S118: each recorded gate decision of a run, recomputed from its recorded proposal and snapshot (K6). */
  /** S118, S146: every recorded event of every gate session, from every run's chain, with its bodies. */
  async sessionEvents(): Promise<SessionEvent[]> {
    const out: SessionEvent[] = [];
    const rows = this.store.db.prepare("SELECT run, seq, event FROM poly_ledger WHERE kind = 'verdict'").all() as { run: string; seq: number; event: string }[];
    for (const r of rows) {
      const b = JSON.parse(r.event).body as Record<string, any>;
      if (typeof b?.session !== 'string' || !b.action) continue;
      const action = await this.store.body(b.action) as Record<string, unknown>;
      // Review C1: a late answer is a proposal or a settle the engine took after the host had held the intent.
      if (b.outcome === 'settled' || b.late === 'settle') out.push({ session: b.session, sseq: b.sseq, kind: 'settle', action, intent: b.intent, observed: b.observed, stateBefore: b.stateBefore, stateAfter: b.stateAfter, run: r.run, ledgerSeq: r.seq });
      else out.push({ session: b.session, sseq: b.sseq, kind: 'propose', action, intent: b.intent, approvedBy: b.approvedBy, gateDecision: b.gateDecision, engineDecision: b.engineDecision, engineClass: b.engineClass ?? null, stateBefore: b.stateBefore, stateAfter: b.stateAfter, run: r.run, ledgerSeq: r.seq });
    }
    return out;
  }

  /** S118, S146: the sessions, replayed in sseq order on a fresh gate engine with the certified policies. */
  async replaySessions(): Promise<SessionReplay[]> {
    if (!this.policyGate) return [];
    const modules = [...new Set(this.verified.machines.map((m) => m.id.slice(0, m.id.lastIndexOf('.'))))];
    // Review C4: each session's counter, so a decision whose event was never written at the end is found.
    const counters = Object.fromEntries((this.store.db.prepare('SELECT session, sseq FROM poly_gate_session').all() as { session: string; sseq: number }[]).map((r) => [r.session, r.sseq]));
    return PolicyGate.replaySessions(await loadPolyaxion(), this.verified.policies, modules, await this.sessionEvents(), counters);
  }

  async gateReplays(instanceId: string): Promise<{ seq: number; decision: string; recompute: (() => string) | null; bySession?: boolean }[]> {
    const out: { seq: number; decision: string; recompute: (() => string) | null; bySession?: boolean }[] = [];
    for (const e of await this.chain(instanceId)) {
      const b = e.body as Record<string, any>;
      if (e.kind !== 'verdict' || b?.stage !== 'gate' || !b.proposal) continue;
      // S146: a policy gate's decisions depend on its session, so they are replayed by their session, in sseq order.
      if (this.policyGate) { out.push({ seq: e.seq, decision: b.outcome, recompute: null, bySession: true }); continue; }
      // Review B5: replay never substitutes a gate. Without the gate the runtime ran with, the decision is not replayed.
      if (!this.gateGiven) { out.push({ seq: e.seq, decision: b.outcome, recompute: null }); continue; }
      const proposal = await this.store.body(b.proposal) as any;
      const snapshot = await this.store.body(b.snapshot) as Record<string, unknown>;
      let g = await this.worker.gate.propose(proposal, snapshot);
      if (b.decision === 2 && g.decision === 'escalate') g = { decision: 'deny', reason: 'escalate-once' };
      const again = g.decision === 'allow' ? 'allowed' : g.decision === 'deny' ? 'denied' : 'escalated';
      out.push({ seq: e.seq, decision: b.outcome, recompute: () => again });
    }
    return out;
  }

  /** PT9.2: a recorded approval of an escalated intent (S118: no person-key signature until M5). */
  /** PT12.5: the latest escalation of an intent, by its verdict event's hash, which a signed approval names. */
  async escalationOf(intentId: string): Promise<{ hash: string; run: string; seq: number } | null> {
    return this.store.txn(() => {
      const rows = this.store.db.prepare(`SELECT run, seq, hash, event FROM poly_ledger WHERE kind = 'verdict' ORDER BY seq DESC`).all() as { run: string; seq: number; hash: string; event: string }[];
      for (const r of rows) {
        const b = JSON.parse(r.event).body;
        if (b?.intent === intentId && b?.outcome === 'escalated') return { hash: r.hash, run: r.run, seq: r.seq };
      }
      return null;
    });
  }

  /**
   * PT9.2, PT12.5, S150: a signed approval lifts the escalation it names, once. Its subject is the escalated verdict
   * event's hash; its key must be a person's in the certified keyring. Anything else is refused with an audit row,
   * and the intent stays Escalated until it is approved or times out.
   */
  async approve(record: unknown): Promise<void> {
    const r = record as { subject?: unknown } | null;
    const subject = typeof r?.subject === 'string' ? r.subject : '';
    const found = subject ? await this.store.txn(() => this.store.db.prepare(`SELECT run, event FROM poly_ledger WHERE hash = ? AND kind = 'verdict'`).get(subject) as { run: string; event: string } | undefined) : undefined;
    const body = found ? JSON.parse(found.event).body : null;
    const refuse = async (problem: string, reason: ApprovalRefusal): Promise<never> => {
      await this.store.insertAudit({ at: this.now(), instanceId: found?.run ?? '', action: 'Approve', actionId: body?.intent ?? subject, rule: 'PT12.5', reason: problem });
      throw new ApprovalRefused(`approval refused: ${problem}`, reason);
    };
    // O9 of the outage test: a keyring or verifier that cannot be read refuses the approval; nothing is assumed.
    let v: ReturnType<typeof verifyRecord>;
    try { v = verifyRecord(record, this.verified.certificate.poly.keyrings, { kind: 'approval' }); } catch (e) { return refuse(`the keyring cannot be read: ${(e as Error).message}`, 'wrong-key'); }
    if (!v.ok) {
      // An unverifiable record is audited against the escalation it names, when it names one.
      return refuse(v.problem, /^not a signed record/.test(v.problem) ? 'not-a-record' : 'wrong-key');
    }
    if (!found || body?.outcome !== 'escalated') return refuse(`the record names no escalation (${subject})`, 'unmatched');
    // Review A1, C3: one record lifts one escalation, once. After a Recheck an intent escalates again, and a record
    // naming the earlier escalation, or one already used, does not lift the new one.
    const current = await this.escalationOf(body.intent);
    if (current?.hash !== subject) return refuse(`the record names escalation ${subject}, and the intent's current escalation is ${current?.hash ?? 'none'}`, 'unmatched');
    const used = this.store.db.prepare(`SELECT event FROM poly_ledger WHERE run = ? AND kind = 'verdict'`).all(found.run).some((x: any) => { const b = JSON.parse(x.event).body; return b?.outcome === 'approved' && b?.record === v.digest; });
    if (used) return refuse(`the record ${v.digest} was already used`, 'replayed');
    try {
      await this.worker.approve(body.intent, { by: v.person.keyId, person: v.person.name, record: v.digest, subject, at: (record as { at: string }).at });
    } catch (e) { return refuse((e as Error).message, /timed out/.test((e as Error).message) ? 'expired' : 'unmatched'); }
  }

  /**
   * S189: one pass over the approvals drop folder. Each `*.json` record is taken in file-name order and applied through
   * rt.approve, which verifies it against the certified keyring and the open escalation it names. Every outcome is
   * journaled on the runtime's own `runtime:approvals` run, with the record kept by digest, so a replay reads the same
   * records in the same order; then the file is moved to applied/, or to refused/ with its reason in a sidecar file.
   */
  /**
   * PS15.4: a message from a channel's provider. Its thread key, from the channel's template over the message's
   * fields, names the application instance `<channel>:<key>`, whose conversation is `<channel>:<key>/<channel>`. An
   * unknown thread is created first when the channel declares it (`starts … on inbound`): the creation and its starts
   * step, which spawns the conversation, then the delivery of `Inbound` to the conversation, each journaled; a starts
   * step that is rejected refuses the message (`thread-not-started`). Otherwise an unknown thread is refused
   * (`unknown-thread`). Every refusal is journaled on `runtime:ingress` and changes no instance. A message is one step
   * however often it is delivered: its action id is `<channel>:<messageId>` (PF8.2).
   */
  /**
   * E13: whether the vendored kernel runs a detached spawn (polyrun's createInstance intent), expected from polygraph
   * 8.4.0. Before it, a channel's thread cannot be created at run time (PS15.4, creation-unavailable).
   */
  get kernelCreatesInstances(): boolean {
    const [maj, min] = polygraphVersion().split('.').map(Number);
    return maj > 8 || (maj === 8 && min >= 4);
  }

  /** S450: per channel, the host's mapping of a verified sender to its principal (K11). */
  #senderMaps = new Map<string, (sender: string, verified: boolean) => string | null>();

  /**
   * PS15.0a, PT10a (S450): registers the host's verifier of a channel's thread principal: it maps a sender the adapter
   * verified to a principal, or to null. It is host code, like the claims verifier, and the only source of the principal.
   */
  mapSenders(channel: string, f: (sender: string, verified: boolean) => string | null): void {
    if (!this.verified.channels.some((c) => c.channel === channel)) throw new Error(`no channel ${channel} is certified (PS15)`);
    if (typeof f !== 'function') throw new Error('a sender mapping is a function (S450)');
    this.#senderMaps.set(channel, f);
  }

  /** S450: the principal a thread was fixed to, or null. */
  threadPrincipal(application: string): string | null {
    this.store.db.exec('CREATE TABLE IF NOT EXISTS poly_thread_principal (thread TEXT PRIMARY KEY, principal TEXT NOT NULL)');
    return (this.store.db.prepare('SELECT principal FROM poly_thread_principal WHERE thread = ?').get(application) as { principal: string } | undefined)?.principal ?? null;
  }

  async inbound(channel: string, fields: Record<string, unknown>, opts: { messageId: string }): Promise<InboundResult> {
    // Review D-F4 (M8b): a caller supplies no claims. An Inbound that declares claims takes them only from a certified
    // adapter's verify, through rt.receive; here it is refused claims-unverified.
    return this.#deliver(channel, fields, opts.messageId, null);
  }

  /**
   * PT21.4, review D-F4 (M8b): the whole of ingress for one webhook, with a certified adapter of the channel (the one
   * given, else the one connected): its verify, its nonce taken once in the store, the refusal or the receipts and
   * claims journaled on runtime:ingress, and each message delivered with the claims that adapter verified. An adapter
   * the certified package did not make, or of another kind, is refused as rt.connectChannel refuses it (PL6408).
   */
  async receive(channel: string, w: Webhook, given?: ChannelAdapter): Promise<IngressAnswer> {
    const adapter = given ?? this.#adapters.get(channel);
    if (!adapter) return { status: 404, contentType: 'text/plain', body: 'no adapter is connected to this channel' };
    this.#certify(channel, adapter);
    const now = this.now();
    let v: Verified | { refused: string };
    // A body the adapter cannot read is a refusal like any other, never an exception out of ingress.
    try { v = adapter.verify(w, now); } catch (e) { v = { refused: `malformed: ${e instanceof Error ? e.message : String(e)}` }; }
    if (!('refused' in v) && v.nonce && !(await this.claimNonce(channel, v.nonce.key, v.nonce.until, now))) v = { refused: 'token-replayed' };
    if ('refused' in v) {
      await this.ingressRecord(channel, { stage: 'verify', outcome: 'refused', provider: adapter.provider, reason: v.refused });
      return { status: 401, contentType: 'text/plain', body: 'refused' };
    }
    for (const r of v.receipts) await this.ingressRecord(channel, { stage: 'receipt', outcome: 'recorded', provider: adapter.provider, providerId: r.providerId, status: r.status, ...(r.error ? { reason: r.error } : {}) });
    const desc = this.verified.channels.find((c) => c.channel === channel);
    for (const m of v.messages) {
      // S191: the sender the adapter verified is an address, journaled by its keyed digest.
      let sender = m.claims.sender;
      if (this.#fault !== 'address-in-clear') await this.store.txn(() => { sender = this.store.keepAddress(m.claims.sender); });
      // PS15.0a (S450): the host maps a verified sender to its principal; any other sender's claims carry the keyed
      // digest of its address, a principal no source owns, which never fixes a thread.
      const map = m.claims.verified ? this.#senderMaps.get(channel) : undefined;
      let mapped: string | null = null;
      if (map) { const r = map(m.claims.sender, true); mapped = typeof r === 'string' && r.length ? r : null; }
      const named = mapped ?? this.store.recipientDigest(m.claims.sender);
      let thread: string | null = null;
      let fixed: string | null = null;
      if (desc?.principal) {
        thread = await this.threadId(channel, desc.thread.template.replace(/\{([^}]*)\}/g, (_, f: string) => String(m.fields[f])));
        fixed = this.threadPrincipal(thread);
        // PS15.4 (S450): a thread whose principal is fixed refuses a message that names another, before the conversation.
        if (mapped && fixed && fixed !== mapped) {
          this.store.ensureRun(INGRESS_RUN, 'runtime', 'ingress');
          await this.store.txn(() => { this.store.appendEvent(INGRESS_RUN, 'verdict', { stage: 'inbound', channel, thread, messageId: m.providerMessageId, outcome: 'refused', reason: 'principal-mismatch', principal: this.store.recipientDigest(`principal:${mapped}`) }, this.now()); });
          continue;
        }
      }
      // PS17.4, S327: a body received on a channel is owned by its sender, at the channel's class; with principal from,
      // by the thread's principal once it is fixed (S450).
      const principal = desc?.principal ? (fixed ?? mapped) : null;
      const owner = principal ?? this.store.recipientDigest(m.claims.sender);
      const content = this.memory.flows.size ? await this.#putTainted(m.body, { c: this.channelClass(channel), o: [owner] }, null) : await this.putContent(m.body);
      await this.ingressRecord(channel, { stage: 'claims', outcome: m.claims.verified ? 'verified' : 'unverified', provider: adapter.provider, messageId: m.providerMessageId, claims: { ...m.claims, sender, principal: this.store.recipientDigest(`principal:${named}`) } });
      // K11, PT21.4: the adapter's claims, typed as std's Sender (verified is Verified or Unverified, and the principal).
      const delivered = await this.#deliver(channel, { ...m.fields, body: content }, m.providerMessageId, { verified: m.claims.verified ? 'Verified' : 'Unverified', principal: named });
      if (delivered.outcome === 'delivered' && thread && mapped && !fixed) {
        await this.store.txn(() => { this.threadPrincipal(thread!); this.store.db.prepare('INSERT OR IGNORE INTO poly_thread_principal (thread, principal) VALUES (?, ?)').run(thread, mapped); });
      }
      // PS17.3 (S450): with principal from, the recipient of the thread's send is its principal, or none until it is fixed.
      const recipient = desc?.principal ? principal : owner;
      if (this.memory.flows.size && delivered.conversation && recipient) await this.store.txn(() => this.memory.setThreadSender(delivered.conversation, recipient));
    }
    return v.answer ?? { status: 200, contentType: 'text/plain', body: 'ok' };
  }

  async #deliver(channel: string, fields: Record<string, unknown>, messageId: string, claims: Record<string, unknown> | null): Promise<InboundResult> {
    const d = this.verified.channels.find((c) => c.channel === channel);
    if (!d) throw new Error(`no channel ${channel}; the certificate names ${this.verified.channels.map((c) => c.channel).join(', ') || 'none'} (PS15)`);
    if (d.inbound.to !== 'conversation') throw new Error(`channel ${channel}: its descriptor routes inbound to ${d.inbound.to}, and PS15.4 routes it to the conversation`);
    let application = '';
    let conversation = '';
    const refuse = async (reason: NonNullable<InboundResult['reason']>) => {
      this.store.ensureRun(INGRESS_RUN, 'runtime', 'ingress');
      await this.store.txn(() => { this.store.appendEvent(INGRESS_RUN, 'verdict', { stage: 'inbound', channel, thread: application || null, messageId, outcome: 'refused', reason }, this.now()); });
      return { outcome: 'refused' as const, reason, application, conversation };
    };
    // Review D-F7 (M8b): fields outside the conversation's Inbound type are refused here, journaled like every other
    // refusal of ingress, before the thread key is read from them (S140).
    if (this.outsideType('', d.inbound.action, fields, d.conversation)) return refuse('outside-type');
    // The thread key is a checked string, used only as a key: each field the template reads is a string the
    // conversation's Inbound declares, and its value is in its domain (checked above).
    const key = d.thread.template.replace(/\{([^}]*)\}/g, (_, f: string) => String(fields[f]));
    // S191, S205 (PS15.4): the key and each field it reads are addresses, kept in the erasable store; the instance is
    // named, and the message delivered, with their keyed digests. The fault address-in-clear is the scan's control.
    if (this.#fault === 'address-in-clear') application = `${channel}:${key}`;
    else {
      application = await this.threadId(channel, key);
      const read = new Set([...d.thread.template.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]));
      const keyed: Record<string, unknown> = { ...fields };
      await this.store.txn(() => { for (const f of read) keyed[f] = this.store.keepAddress(String(fields[f])); });
      fields = keyed;
    }
    conversation = `${application}/${channel}`;
    if (!(await this.store.getInstance(application))) {
      if (!d.starts.onInbound) return refuse('unknown-thread');
      // Until E13 the kernel cannot spawn the conversation, so a creation is refused before it reaches the kernel.
      if (!this.kernelCreatesInstances) return refuse('creation-unavailable');
      try { await this.create(d.application, { id: application, creation: { action: d.starts.action, data: {} } }); } catch (e) { if (e instanceof RefusedDispatch) return refuse('thread-not-started'); throw e; }
      const started = (await this.getJournal(application)).find((j) => j.action === d.starts.action);
      if (!started || started.step_kind !== 'accepted') return refuse('thread-not-started');
    }
    // A thread whose starts was rejected has no conversation, so its later messages are refused the same way.
    if (!(await this.store.getInstance(conversation))) return refuse('thread-not-started');
    // K11, PT21.4: an Inbound that declares claims takes the ones its adapter verified, and only those.
    if (!claims && this.claimed(d.conversation, d.inbound.action)) return refuse('claims-unverified');
    await this.dispatch(conversation, d.inbound.action, fields, { actionId: `${channel}:${messageId}`, ...(claims ? { [SUPPLIED_CLAIMS]: claims } : {}) });
    this.store.ensureRun(INGRESS_RUN, 'runtime', 'ingress');
    await this.store.txn(() => { this.store.appendEvent(INGRESS_RUN, 'verdict', { stage: 'inbound', channel, thread: application, messageId, outcome: 'delivered' }, this.now()); });
    return { outcome: 'delivered', application, conversation };
  }

  /**
   * S191, S205 (PS15.4): the application instance a thread key names, `<channel>:<keyed digest of the key>`, with the
   * key kept in the erasable store. A host that creates a thread itself names it with this.
   */
  async threadId(channel: string, key: string): Promise<string> {
    if (!this.verified.channels.some((c) => c.channel === channel)) throw new Error(`no channel ${channel}; the certificate names ${this.verified.channels.map((c) => c.channel).join(', ') || 'none'} (PS15)`);
    let d = '';
    await this.store.txn(() => { d = this.store.keepAddress(key); });
    return `${channel}:${d}`;
  }

  /** S191: the address a keyed digest names in the erasable store, or null when it is unknown or erased. */
  addressOf(d: string): string | null {
    if (!d.startsWith('hmac-sha256:')) return null;
    const r = this.store.db.prepare('SELECT body FROM poly_content WHERE digest = ?').get(d) as { body: string } | undefined;
    return r ? (JSON.parse(r.body) as string) : null;
  }

  /**
   * S205 (PS3.2): erases a body or an address: the body is deleted, its digest kept with an erasure record journaled on
   * runtime:content, and it is never stored again. The records the journal and the ledger keep by digest are refused.
   */
  async erase(d: string): Promise<void> {
    if (this.store.erased(d)) return;
    if (!this.store.db.prepare('SELECT 1 FROM poly_erasable WHERE digest = ?').get(d)) throw new Error(`${d} is not erasable: only bodies and addresses are (S205)`);
    this.store.ensureRun(CONTENT_RUN, 'runtime', 'content');
    await this.store.txn(() => {
      this.store.db.prepare('DELETE FROM poly_content WHERE digest = ?').run(d);
      this.store.db.prepare('INSERT OR IGNORE INTO poly_erased (digest, at) VALUES (?, ?)').run(d, this.now());
      this.store.appendEvent(CONTENT_RUN, 'verdict', { stage: 'erasure', digest: d }, this.now());
    });
  }

  /**
   * PT21.4, S182: what ingress records on runtime:ingress besides a delivery: a webhook its adapter refused (nothing
   * is dispatched), a provider's receipt for an earlier send, and the sender claims of a message (K11). The channel
   * must be one the certificate names.
   */
  async ingressRecord(channel: string, record: { stage: 'verify' | 'receipt' | 'claims'; outcome: string; provider: string; reason?: string; providerId?: string; status?: string; claims?: { verified: boolean; sender: string; principal?: string }; messageId?: string }): Promise<void> {
    if (!this.verified.channels.some((c) => c.channel === channel)) throw new Error(`no channel ${channel}; the certificate names ${this.verified.channels.map((c) => c.channel).join(', ') || 'none'} (PS15)`);
    this.store.ensureRun(INGRESS_RUN, 'runtime', 'ingress');
    await this.store.txn(() => { this.store.appendEvent(INGRESS_RUN, 'verdict', { channel, ...record }, this.now()); });
  }

  /**
   * PT21.4: takes a provider's nonce once (Mailgun's token). The store keeps it until `until`, the time after which the
   * adapter refuses its signature as stale, so a replay after a restart is refused too. Review D-F6 (M8b): each nonce
   * keeps its own expiry, computed from the provider's timestamp, so a provider clock ahead of ours cannot outlive it.
   */
  async claimNonce(channel: string, key: string, until: number, now: number): Promise<boolean> {
    let taken = false;
    await this.store.txn(() => {
      // Every channel's expired nonces are pruned, so the table holds at most a window's worth.
      this.store.db.prepare('DELETE FROM poly_ingress_nonce WHERE until < ?').run(now);
      taken = this.store.db.prepare('INSERT OR IGNORE INTO poly_ingress_nonce (channel, nonce, until) VALUES (?, ?, ?)').run(channel, key, until).changes === 1;
    });
    return taken;
  }

  /**
   * PT21.5, PS15.4: the channel's adapter sends for its conversations. A send of channel.<c>.send runs from the outbox
   * worker, after the gate allows, to the thread's recipient (its key); a failure the adapter reports with provider
   * events delivers each to the conversation as an Inbound, before the send's failure completes. The adapter is runtime
   * configuration, like a decision's provider; its certification by digest is plan step 10's.
   */
  /** S182, plan step 10: only an adapter the certified package made, of the adapter the channel declares (PL6408). */
  #certify(channel: string, adapter: ChannelAdapter): void {
    if (!this.verified.channels.some((c) => c.channel === channel)) throw new Error(`no channel ${channel}; the certificate names ${this.verified.channels.map((c) => c.channel).join(', ') || 'none'} (PS15)`);
    const pin = this.certificate.poly.adapters?.find((x) => x.channel === channel);
    if (!pin) throw new Error(`PL6408 ADAPTER_NOT_CERTIFIED: the certificate binds no adapter to channel ${channel} (S182)`);
    if (!this.#ioPackage?.madeHere(adapter)) throw new Error(`PL6408 ADAPTER_NOT_CERTIFIED: the adapter for ${channel} was not made by the certified ${pin.package} ${pin.version} as this runtime loaded it (S182)`);
    if (adapter.kind !== pin.adapter) throw new Error(`PL6408 ADAPTER_NOT_CERTIFIED: channel ${channel} declares adapter ${pin.adapter}, and this is a ${adapter.kind} adapter (S182)`);
  }

  // ── grants (PS16, PT10g) ──────────────────────────────────────────────────────────────────────────────────────

  /**
   * PS16.1: the certified credential, as load read its descriptor once with the certified bytes (review D4, B7, M9), or
   * null for an unknown credential.
   */
  #credential(c: string): { machine: string; provider: string; scopes: string[]; holder: boolean; person: boolean; bases: string[] } | null {
    return this.verified.credentials.find((x) => x.name === c) ?? null;
  }

  /** PT10g: the keyed digest a holder is named by, never the holder itself (S191). */
  #holderKey(holder: string | null): string { return holder === null ? '-' : this.store.recipientDigest(`holder:${holder}`); }

  /** PS16.2: the current grant instance of a credential and holder, or null. */
  grantOf(c: string, holder: string | null): string | null {
    const r = this.store.db.prepare('SELECT instance FROM poly_grant WHERE credential = ? AND holder = ? ORDER BY generation DESC LIMIT 1').get(c, this.#holderKey(holder)) as { instance: string } | undefined;
    return r?.instance ?? null;
  }

  /** PT22.3: the authorization URLs of the grants requested through the approvals folder, for the host to deliver. */
  readonly #authorizations: { credential: string; url: string }[] = [];
  takeAuthorizations(): { credential: string; url: string }[] { return this.#authorizations.splice(0); }

  /** PS16.4: a person's signed revocation, matched to its grant by its subject. */
  private async revokeBySubject(record: unknown): Promise<void> {
    const subject = (record as { subject?: unknown } | null)?.subject;
    const rows = this.store.db.prepare('SELECT credential, instance FROM poly_grant').all() as { credential: string; instance: string }[];
    const hit = rows.find((r) => revocationSubject(r.instance) === subject);
    if (!hit) throw new ApprovalRefused('the revocation names no grant of this store', 'unmatched');
    const v = verifyRecord(record, this.certificate.poly.keyrings ?? { people: [], agents: [] }, { kind: 'revocation', subject: revocationSubject(hit.instance) });
    if (!v.ok) throw new ApprovalRefused(`the revocation is refused: ${v.problem} (PS16.4)`, 'wrong-key');
    await this.dispatch(hit.instance, 'Revoke', {}, { [GRANT_STEP]: true });
    this.store.ensureRun(INGRESS_RUN, 'runtime', 'ingress');
    await this.store.txn(() => { this.store.appendEvent(INGRESS_RUN, 'verdict', { stage: 'revocation', credential: hit.credential, grant: hit.instance, source: 'person' }, this.now()); });
  }

  /**
   * S210, B3 and D6 (PT10g): a grant request is a person's signed record of the kind grant-request over { credential,
   * holder }, taken once: unsigned it is not-a-record, by an agent's or an unknown key or over another subject it is
   * wrong-key, and taken before it is replayed. So writing to the approvals folder alone cannot push a grant back to
   * Requested.
   */
  async #takeGrantRequest(credential: string, holder: string | null, record: unknown): Promise<void> {
    const r = record as Partial<SignedRecord> | null;
    if (!r || typeof r !== 'object' || typeof r.sig !== 'string') throw new ApprovalRefused('a grant request is signed by a person (S210)', 'not-a-record');
    const v = verifyRecord(r, this.certificate.poly.keyrings ?? { people: [], agents: [] }, { kind: 'grant-request', subject: grantRequestSubject(credential, holder) });
    if (!v.ok) throw new ApprovalRefused(`the grant request is refused: ${v.problem} (S210)`, v.problem.startsWith('not a signed record') ? 'not-a-record' : 'wrong-key');
    const d = recordDigest(r as SignedRecord);
    let fresh = false;
    await this.store.txn(() => { fresh = this.store.db.prepare('INSERT OR IGNORE INTO poly_used_record (digest, at) VALUES (?, ?)').run(d, this.now()).changes === 1; });
    if (!fresh) throw new ApprovalRefused('the grant request was taken before (S210)', 'replayed');
  }

  /**
   * A person's signed record of a kind over a subject, verified and not yet taken: not-a-record, wrong-key or replayed
   * otherwise. It is taken (#useRecord) in the transaction that records what it did, so a run cut short does not use it
   * up (review C1).
   */
  #checkRecord(record: unknown, kind: 'verify' | 'forget', subject: string, what: string): string {
    const r = record as Partial<SignedRecord> | null;
    if (!r || typeof r !== 'object' || typeof r.sig !== 'string') throw new ApprovalRefused(`${what} is signed by a person (PS17)`, 'not-a-record');
    // S321: a record bound to another project's anchor is refused before anything else is looked at.
    const named = recordAnchor(r.subject);
    if (named !== null && named !== this.anchorId) throw new ApprovalRefused(`${what} is bound to another project's anchor (S321)`, 'wrong-project');
    const v = verifyRecord(r, this.certificate.poly.keyrings ?? { people: [], agents: [] }, { kind, subject });
    if (!v.ok) throw new ApprovalRefused(`${what} is refused: ${v.problem}`, v.problem.startsWith('not a signed record') ? 'not-a-record' : 'wrong-key');
    const d = recordDigest(r as SignedRecord);
    if (this.store.db.prepare('SELECT 1 FROM poly_used_record WHERE digest = ?').get(d)) throw new ApprovalRefused(`${what} was taken before`, 'replayed');
    return d;
  }

  /** Takes a checked record, inside the caller's transaction; false when another took it first. */
  #useRecord(d: string): boolean {
    return this.store.db.prepare('INSERT OR IGNORE INTO poly_used_record (digest, at) VALUES (?, ?)').run(d, this.now()).changes === 1;
  }

  /** S327: a channel's class in the program's audience: the one it declares, else the lowest. */
  private channelClass(channel: string): number {
    const flow = [...this.memory.flows.values()][0];
    const a = this.verified.channels.find((c) => c.channel === channel)?.audience ?? null;
    return flow && a ? Math.max(0, flow.audience.indexOf(a)) : 0;
  }

  /** S321: the id of the project's anchor, which a memory record names. */
  get anchorId(): string | null { return this.verified.anchorId; }

  /** PS17.5 (S309): a person's signed record of the kind verify promotes a memory item to verified, once. */
  async verifyMemory(item: string, record: unknown): Promise<void> {
    if (!this.memory.memoryItem(item)) throw new Error(`no memory item ${item}`);
    const d = this.#checkRecord(record, 'verify', memoryVerifySubject(this.anchorId ?? '', item), 'a memory verification');
    this.store.ensureRun(MEMORY_RUN, 'runtime', 'memory');
    let taken = false;
    await this.store.txn(() => {
      if (!(taken = this.#useRecord(d))) return;
      this.memory.markVerified(item);
      this.store.appendEvent(MEMORY_RUN, 'verdict', { stage: 'memory', outcome: 'verified', item, record: d }, this.now());
    });
    if (!taken) throw new ApprovalRefused('a memory verification was taken before', 'replayed');
  }

  /**
   * PS17.7 (S306): a person's signed record of the kind forget erases every body about a subject, or from a source, removes
   * the items that name it, asks each connected adapter to forget the subject, and records what it erased by digest.
   */
  async forget(target: { subject: string } | { source: string }, record: unknown): Promise<{ erased: string[] }> {
    // Review S4: a source the build does not have is refused before the record is looked at.
    if ('source' in target && !this.memory.hasSource(target.source)) throw new Error(`no source ${target.source} in the certified build`);
    const d = this.#checkRecord(record, 'forget', forgetSubject(this.anchorId ?? '', target), 'a forget');
    // Review S2: only an erasable body is erased, and only those are listed.
    const bodies = this.memory.forgettable(target).bodies.filter((b) => this.store.db.prepare('SELECT 1 FROM poly_erasable WHERE digest = ?').get(b));
    // Review C1: each erasure and the adapters' forget may be run again; the record is taken with the forget event, so a
    // forget cut short by a failing adapter is completed by the same record.
    for (const b of bodies) await this.erase(b);
    if ('subject' in target) for (const a of this.memory.connected()) await a.forget(target.subject);
    this.store.ensureRun(CONTENT_RUN, 'runtime', 'content');
    let taken = false;
    await this.store.txn(() => {
      if (!(taken = this.#useRecord(d))) return;
      this.memory.removeItems(target);
      // Review C5: an erased body's taint record would keep the subject beside its digest.
      this.memory.dropTaint(bodies);
      this.store.appendEvent(CONTENT_RUN, 'verdict', { stage: 'forget', ...('subject' in target ? { subject: this.store.recipientDigest(`principal:${target.subject}`) } : { source: target.source }), erased: bodies, record: d }, this.now());
    });
    if (!taken) throw new ApprovalRefused('a forget was taken before', 'replayed');
    return { erased: bodies };
  }

  /** PS11.3a: each erased body, with the hash of the forget event that erased it (null for an erasure on its own). */
  forgottenBodies(): Map<string, string | null> {
    const out = new Map<string, string | null>();
    for (const r of this.store.db.prepare('SELECT digest FROM poly_erased').all() as { digest: string }[]) out.set(r.digest, null);
    for (const r of this.store.db.prepare("SELECT event, hash FROM poly_ledger WHERE run = ? AND kind = 'verdict'").all(CONTENT_RUN) as { event: string; hash: string }[]) {
      const b = JSON.parse(r.event).body;
      if (b?.stage === 'forget') for (const x of b.erased ?? []) out.set(x, r.hash);
    }
    return out;
  }

  /** PS16.4: what a person signs to revoke the current grant of a credential and holder. */
  revocationSubject(c: string, holder: string | null): string {
    const g = this.grantOf(c, holder);
    if (!g) throw new Error(`no grant of credential ${c} for that holder`);
    return revocationSubject(g);
  }

  /**
   * PT22.3, PT10g: asks the holder for a grant: the Grant instance is created (a new one after a revocation) or asked
   * again, and the vault's authorization URL is returned for the host to deliver. The URL is never journaled.
   */
  async requestGrant(c: string, holder: string | null): Promise<string> {
    const cred = this.#credential(c);
    if (!cred) throw new Error(`no credential ${c} in the certified build (PS16)`);
    if (cred.holder !== (holder !== null)) throw new Error(`credential ${c} ${cred.holder ? 'is granted by a holder, a Principal' : cred.person ? 'names no holder: a person\'s signed grant request names it (S457)' : 'is the service\'s own, with no holder'} (PT10e)`);
    // S457, PT10g: only a person's signed grant request creates the one grant of a person's credential with no holder.
    if (cred.person && !cred.holder && !this.#fixedHolder(c)) throw new Error(`credential ${c}'s holder is fixed by a person's signed grant request first (PT10g, S457)`);
    return this.#askGrant(c, holder);
  }

  /** S457: the keyed digest of the holder fixed for the current, unrevoked grant of a credential that names none, or null. */
  #fixedHolder(c: string): string | null {
    const id = this.grantOf(c, null);
    if (!id) return null;
    const row = this.store.db.prepare('SELECT state FROM pr_instance WHERE instance_id = ?').get(id) as { state: string } | undefined;
    if (!row || (JSON.parse(row.state) as { g?: string }).g === 'Revoked') return null;
    return (this.store.db.prepare('SELECT holder FROM poly_grant_holder WHERE instance = ?').get(id) as { holder: string } | undefined)?.holder ?? null;
  }

  /**
   * S457, PT10g: a person's signed grant request for a credential that names no holder. With no unrevoked grant it creates
   * the next one and fixes its holder by keyed digest; with one, the same holder asks again and another is refused
   * holder-mismatch, so replacing the holder needs a revocation.
   */
  async #requestForHolder(c: string, holder: string): Promise<string> {
    const key = this.#holderKey(holder);
    const fixed = this.#fixedHolder(c);
    if (fixed !== null && fixed !== key) throw new ApprovalRefused(`the grant of credential ${c} has another holder; it is replaced only after a revocation (PS16.2, S457)`, 'holder-mismatch');
    const url = await this.#askGrant(c, null);
    if (fixed === null) {
      const id = this.grantOf(c, null)!;
      await this.store.txn(() => { this.store.db.prepare('INSERT OR REPLACE INTO poly_grant_holder (instance, holder) VALUES (?, ?)').run(id, key); });
    }
    return url;
  }

  async #askGrant(c: string, holder: string | null): Promise<string> {
    const cred = this.#credential(c)!;
    const vault = this.#vaults.get(c);
    if (!vault) throw new Error(`no vault is connected for credential ${c} (PT10f)`);
    let id = this.grantOf(c, holder);
    const state = id ? (await this.store.getInstance(id))?.state as { g?: string } | undefined : undefined;
    if (!id || state?.g === 'Revoked') {
      const key = this.#holderKey(holder);
      const generation = ((this.store.db.prepare('SELECT MAX(generation) AS n FROM poly_grant WHERE credential = ? AND holder = ?').get(c, key) as { n: number | null }).n ?? 0) + 1;
      id = holder === null ? `grant:${c}#${generation}` : `grant:${c}:${key}#${generation}`;
      await this.create(cred.machine, { id });
      const grantId = id;
      await this.store.txn(() => { this.store.db.prepare('INSERT INTO poly_grant (credential, holder, generation, instance) VALUES (?, ?, ?, ?)').run(c, key, generation, grantId); });
    } else if (state?.g === 'Granted' || state?.g === 'Expired') await this.dispatch(id, 'Reauthorize', {}, { [GRANT_STEP]: true });
    return (await vault.authorize({ grantId: id, scopes: cred.scopes, now: this.now() })).url;
  }

  /**
   * PT10f, S202 (CredentialHost): the holder's consent, from the provider's redirect, as Callback(granted); true when
   * the grant took it (review C2, M9). A grant id is the credential's by its own prefix only (review C8, M9).
   */
  async grantCallback(c: string, grantId: string, scopes: string[]): Promise<boolean> {
    const cred = this.#credential(c);
    if (!cred || !(grantId.startsWith(`grant:${c}:`) || grantId.startsWith(`grant:${c}#`))) throw new Error(`grant ${grantId} is not one of credential ${c}`);
    const granted = Object.fromEntries(cred.scopes.map((s) => [s.split('.').join('_'), scopes.includes(s)]));
    return (await this.dispatch(grantId, 'Callback', { granted }, { [GRANT_STEP]: true })).stepKind === 'accepted';
  }

  /** PT10f (CredentialHost): a callback's outcome, on runtime:ingress; never a code, a state or a token. */
  async credentialRecord(credential: string, record: { stage: 'callback'; outcome: 'refused' | 'granted'; provider: string; reason?: string }): Promise<void> {
    this.store.ensureRun(INGRESS_RUN, 'runtime', 'ingress');
    await this.store.txn(() => { this.store.appendEvent(INGRESS_RUN, 'verdict', { credential, ...record }, this.now()); });
  }

  /**
   * PS16.4: revokes the current grant of a credential and holder: from the provider, a security signal, or a person's
   * signed record of the kind revocation, by a key of the people ring. The source is recorded on runtime:ingress.
   */
  async revokeGrant(c: string, holder: string | null, opts: { source: 'provider' | 'security' | 'person'; record?: unknown }): Promise<void> {
    const id = this.grantOf(c, holder);
    if (!id) throw new Error(`no grant of credential ${c} for that holder`);
    if (opts.source === 'person') {
      const v = verifyRecord(opts.record, this.certificate.poly.keyrings ?? { people: [], agents: [] }, { kind: 'revocation', subject: revocationSubject(id) });
      if (!v.ok) throw new Error(`the revocation is refused: ${v.problem} (PS16.4)`);
    }
    await this.dispatch(id, 'Revoke', {}, { [GRANT_STEP]: true });
    this.store.ensureRun(INGRESS_RUN, 'runtime', 'ingress');
    await this.store.txn(() => { this.store.appendEvent(INGRESS_RUN, 'verdict', { stage: 'revocation', credential: c, grant: id, source: opts.source }, this.now()); });
  }

  /**
   * PS16.3, S199: the grant check of an intent whose effect uses a credential, read as of now: no vault, no grant, or a
   * grant not Granted is credential-unavailable; a scope it does not hold is insufficient-scope.
   */
  grantCheck(instanceId: string, decl: { uses?: { credential: string; scopes: string[]; holder: string | null } } | null, payload: Record<string, unknown>): { deny: string; reads?: Record<string, number> } | { credential: { name: string; grantState: string; scopes: string[] }; reads: Record<string, number> } | null {
    const uses = decl?.uses;
    if (!uses) return null;
    const holder = uses.holder === null ? null : payload[uses.holder];
    if (uses.holder !== null && (typeof holder !== 'string' || holder === '')) return { deny: 'credential-unavailable' };
    const id = this.#vaults.has(uses.credential) ? this.grantOf(uses.credential, holder as string | null) : null;
    const row = id ? this.store.db.prepare('SELECT seq, state FROM pr_instance WHERE instance_id = ?').get(id) as { seq: number; state: string } | undefined : undefined;
    if (!id || !row) return { deny: 'credential-unavailable' };
    const reads = { [id]: Number(row.seq) };
    const state = JSON.parse(row.state) as Record<string, unknown>;
    if (state.g !== 'Granted') return { deny: 'credential-unavailable', reads };
    const cred = this.#credential(uses.credential)!;
    const held = cred.scopes.filter((s) => scopeHeld(state, s));
    if (!uses.scopes.every((s) => held.includes(s))) return { deny: 'insufficient-scope', reads };
    return { credential: { name: uses.credential, grantState: 'Granted', scopes: held }, reads };
  }

  /** PT22.5: the vault's transport for an intent of an effect that uses a credential, bound to the intent's grant. */
  apiFor(decl: { uses?: { credential: string; holder: string | null } } | null, payload: Record<string, unknown>): ApiTransport | undefined {
    const uses = decl?.uses;
    const vault = uses ? this.#vaults.get(uses.credential) : undefined;
    if (!uses || !vault) return undefined;
    const holder = uses.holder === null ? null : (payload[uses.holder] as string);
    return { request: async (r) => { const id = this.grantOf(uses.credential, holder); if (!id) throw new Error(`no grant of credential ${uses.credential}`); return vault.withToken(id, r); } };
  }

  /**
   * PS17.0, PT10j (S460): the handle a source's adapter is built with, for credential c, which a source of the build names
   * and which has no holder. Each request is refused before it is sent when its URL lies outside the provider's base
   * addresses (PL6406, audited as a capability refusal is) and while c's one grant is not Granted (credential-unavailable,
   * read at the request, so a revocation stops the next one); otherwise it goes through the vault's withToken for the
   * grant, which attaches the token and strips it from the answer. The handle holds no token and no way to get one: its
   * one method is request, and the runtime keeps which handles it made.
   */
  credentialHandle(c: string): Readonly<{ request(r: { method: string; url: string; headers?: Record<string, string>; body?: string }): Promise<HttpResponse> }> {
    const cred = this.#credential(c);
    if (!cred) throw new Error(`no credential ${c} in the certified build (PS16)`);
    if (!this.verified.memory.sources.some((s) => s.credential === c)) throw new Error(`credential ${c} is named by no source of the build; a handle is for a source's adapter (PS17.0, S460)`);
    if (cred.holder) throw new Error(`credential ${c} has a holder, and a source's credential has none (PS17.0, S460)`);
    const bases = [...cred.bases];
    const request = async (r: { method: string; url: string; headers?: Record<string, string>; body?: string }): Promise<HttpResponse> => {
      const method = String(r?.method ?? '');
      const url = String(r?.url ?? '');
      const at = withinPrefix(url, bases);
      if (at === null) {
        const reason = `${method} ${url} is outside the base addresses of credential ${c}'s provider ${JSON.stringify(bases)}`;
        await this.store.insertAudit({ at: this.now(), instanceId: this.grantOf(c, null) ?? `credential:${c}`, action: `credential.${c}.request`, actionId: `credential.${c}.request`, rule: 'PL6406', reason });
        throw new CapabilityRefused(`PL6406 CAPABILITY_REFUSED: ${reason}`);
      }
      const vault = this.#vaults.get(c);
      const id = vault ? this.grantOf(c, null) : null;
      const row = id ? this.store.db.prepare('SELECT state FROM pr_instance WHERE instance_id = ?').get(id) as { state: string } | undefined : undefined;
      if (!vault || !id || !row || (JSON.parse(row.state) as { g?: unknown }).g !== 'Granted') throw new CredentialUnavailable(`credential-unavailable: credential ${c} has no Granted grant, so its source's adapter sends nothing (PS16.4, S460)`);
      const req: HttpRequest = { method, url: at, headers: { ...(r.headers ?? {}) }, body: typeof r.body === 'string' ? r.body : '' };
      const res = await vault.withToken(id, req);
      return { status: res.status, headers: { ...res.headers }, body: res.body };
    };
    const handle = Object.freeze({ request, [CREDENTIAL_HANDLE]: true });
    this.#handles.set(handle, c);
    return handle;
  }

  /**
   * PT10f, S200: the vault of a credential the certificate names, made by the certified adapter package, of the store the
   * certificate binds (PL6408 otherwise). The runtime holds it for the grant check and `api` (PT22.4, PT22.5).
   */
  connectVault(credential: string, adapter: VaultAdapter): void {
    const pin = this.certificate.poly.vaults?.find((v) => v.credential === credential);
    if (!pin) throw new Error(`no credential ${credential}; the certificate binds ${(this.certificate.poly.vaults ?? []).map((v) => v.credential).join(', ') || 'none'} (PT10f)`);
    if (!this.#ioPackage?.madeHere(adapter) || adapter.kind !== 'vault') throw new Error(`PL6408 ADAPTER_NOT_CERTIFIED: the vault for ${credential} was not made by the certified ${pin.package} ${pin.version} as this runtime loaded it (S200)`);
    if (adapter.store !== pin.store) throw new Error(`PL6408 ADAPTER_NOT_CERTIFIED: credential ${credential} is certified with the ${pin.store} store, and this vault keeps its tokens in the ${adapter.store} store (S200)`);
    // S210, D9: the anchor says production, whatever the certificate's store; the development keychain never runs there.
    if (this.verified.production && adapter.store === 'dev-keychain') throw new Error(`PL6826 VAULT_NOT_FOR_PRODUCTION: credential ${credential}'s vault keeps its tokens in the development keychain, and this project's anchor says it is production (S200, S210)`);
    const cred = this.#credential(credential);
    if (!cred || adapter.provider !== cred.provider) throw new Error(`PL6408 ADAPTER_NOT_CERTIFIED: credential ${credential} is certified for provider ${cred?.provider ?? 'none'}, and this vault is for ${adapter.provider} (PT10f)`);
    this.#vaults.set(credential, adapter);
    // PT10g: the Grant's effects, run by the vault: a refresh completes Refreshed(valid), a revoke forgets the tokens.
    const vaultOf = (instanceId: string) => {
      const c = /^grant:([^:#]+)/.exec(instanceId)?.[1];
      const v = c ? this.#vaults.get(c) : undefined;
      if (!v) throw Object.assign(new Error(`no vault for ${instanceId}`), { permanent: true });
      return v;
    };
    this.#handlers.set('credential.refresh', async (_p, _caps, ctx) => vaultOf(ctx.instanceId).refresh(ctx.instanceId));
    this.#handlers.set('credential.revoke', async (_p, _caps, ctx) => { await vaultOf(ctx.instanceId).revoke(ctx.instanceId); return {}; });
  }

  /** PT26, S308: binds a source's adapter; only one the certified poly-io made, of the kind the source declares. */
  connectSource(source: string, adapter: SourceAdapter): void {
    const pin = this.certificate.poly.memory?.sources.find((x) => x.name === source);
    if (!pin) throw new Error(`no source ${source}; the certificate names ${(this.certificate.poly.memory?.sources ?? []).map((x) => x.name).join(', ') || 'none'} (PS17.0)`);
    if (pin.adapter === null) throw new Error(`source ${source} is the project's memory, which the runtime keeps itself (PS17.5)`);
    if (!this.#ioPackage?.madeHere(adapter)) throw new Error(`PL6408 ADAPTER_NOT_CERTIFIED: the adapter for source ${source} was not made by the certified ${pin.package} ${pin.version} as this runtime loaded it (S308)`);
    if (adapter.kind !== pin.adapter) throw new Error(`PL6408 ADAPTER_NOT_CERTIFIED: source ${source} declares adapter ${pin.adapter}, and this is a ${adapter.kind} adapter (S308)`);
    // PS17.0, PT10j (S460): a source that names a credential takes only an adapter built with this runtime's handle for
    // it, so its requests go through the vault under the grant; a source that names none takes no adapter built with a
    // handle. A package that cannot say what an adapter was built with says none, so a credential's source is refused.
    const want = this.memory.sources.get(source)?.credential;
    const handle = typeof this.#ioPackage?.credentialHandleOf === 'function' ? this.#ioPackage.credentialHandleOf(adapter) : null;
    const built = handle !== null && typeof handle === 'object' ? this.#handles.get(handle) : undefined;
    if (want !== undefined && built !== want) throw new Error(`PL6408 ADAPTER_NOT_CERTIFIED: source ${source} names credential ${want}, and this adapter was not built with this runtime's handle for it (rt.credentialHandle, S460)`);
    if (want === undefined && handle !== null && handle !== undefined) throw new Error(`PL6408 ADAPTER_NOT_CERTIFIED: source ${source} names no credential, and this adapter was built with a credential handle (S460)`);
    this.memory.connect(source, adapter);
  }

  connectChannel(channel: string, adapter: ChannelAdapter, transports: ChannelTransports): void {
    const d = this.verified.channels.find((c) => c.channel === channel);
    if (!d) throw new Error(`no channel ${channel}; the certificate names ${this.verified.channels.map((c) => c.channel).join(', ') || 'none'} (PS15)`);
    this.#certify(channel, adapter);
    // What a provider ties to an address (an SMS opt-out, an email bounce) it ties to its sender and the address; a
    // thread is one address of one channel, so two channels may not send as one sender (std PROVENANCE.md).
    for (const [other, s] of this.channelSenders) if (other !== channel && s.kind === adapter.kind && s.sender === adapter.sender) throw new Error(`channel ${other} already sends as ${adapter.kind} sender ${adapter.sender}; two channels that send as one sender would keep the provider's per-address state on two threads`);
    this.channelSenders.set(channel, { kind: adapter.kind, sender: adapter.sender });
    this.#adapters.set(channel, adapter);
    const kind = `channel.${channel}.send`;
    const handler: EffectHandler = async (payload, _caps, ctx) => {
      // The conversation is <channel>:<key>/<channel>, and its thread's recipient is the key (PS15.4).
      const suffix = `/${channel}`;
      if (!ctx.instanceId.startsWith(`${channel}:`) || !ctx.instanceId.endsWith(suffix)) throw Object.assign(new Error(`${ctx.instanceId} is no conversation of channel ${channel}`), { permanent: true });
      // S191: the recipient is read from the erasable store by the thread's keyed digest; an erased one is not sent to.
      const key = ctx.instanceId.slice(channel.length + 1, -suffix.length);
      const to = this.addressOf(key);
      if (to === null) throw Object.assign(new Error(`the recipient of ${ctx.instanceId} is not in the content store: unknown or erased (S205)`), { permanent: true });
      const p = (payload ?? {}) as { body?: unknown; kind?: unknown };
      const body = typeof p.body === 'string' ? await this.contentBody(p.body) : '';
      if (body === null) throw Object.assign(new Error(`the body ${String(p.body)} is not in the content store`), { permanent: true });
      const r = await adapter.send({ to, body, ...(typeof p.kind === 'string' ? { kind: p.kind } : {}), idempotencyKey: ctx.idempotencyKey, now: this.now() }, transports);
      if (r.ok) return { providerId: r.providerId };
      // S191, review B1 (M9): what the provider reports names addresses as ingress does, so each field the thread's
      // template reads is replaced by its keyed digest, and the recipient by the thread's digest in the error text.
      const error = r.error.split(to).join(key);
      const read = new Set([...d.thread.template.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]));
      for (const e of r.events ?? []) {
        const content = await this.putContent('');
        const fields: Record<string, unknown> = { ...e.fields };
        await this.store.txn(() => { for (const f of read) if (f in fields) fields[f] = this.store.keepAddress(String(fields[f])); });
        // A provider event is the provider's own report: its claim is verified.
        // S450: a provider event names the thread's principal when it is fixed, else a principal no source owns.
        const app = ctx.instanceId.slice(0, ctx.instanceId.lastIndexOf('/'));
        await this.dispatch(ctx.instanceId, d.inbound.action, { ...fields, body: content }, { actionId: `${channel}:${e.providerId}`, [SUPPLIED_CLAIMS]: { verified: 'Verified', principal: this.threadPrincipal(app) ?? this.store.recipientDigest(`provider:${channel}`) } });
        await this.ingressRecord(channel, { stage: 'receipt', outcome: 'delivered', provider: adapter.provider, providerId: e.providerId, reason: error });
      }
      throw Object.assign(new Error(error), { permanent: r.permanent });
    };
    this.#handlers.set(kind, handler);
  }

  async takeApprovals(dir: string): Promise<{ file: string; outcome: 'applied' | 'refused'; reason?: ApprovalRefusal }[]> {
    const out: { file: string; outcome: 'applied' | 'refused'; reason?: ApprovalRefusal }[] = [];
    let names: string[];
    try { names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.name.endsWith('.json') && !e.isDirectory()).map((e) => e.name).sort(); } catch { return out; }
    this.store.ensureRun(APPROVALS_RUN, 'runtime', 'approvals');
    for (const file of names) {
      if (this.unmovable.has(file)) continue;
      // Review A-F2: an entry that is not a regular file, or cannot be read, is refused like any bad record, and the
      // pass goes on; one bad entry never holds back another's approval.
      let text = '';
      let reason: ApprovalRefusal | undefined;
      let message = '';
      let record: unknown = null;
      try {
        if (!lstatSync(join(dir, file)).isFile()) { reason = 'not-a-record'; message = 'the entry is not a regular file'; }
        else text = readFileSync(join(dir, file), 'utf8');
      } catch (e) { reason = 'not-a-record'; message = `the file cannot be read (${(e as NodeJS.ErrnoException).code ?? 'error'})`; }
      if (!reason) { try { record = JSON.parse(text); } catch { reason = 'not-a-record'; message = 'the file is not JSON'; } }
      // PT10g: the approvals folder takes a grant request and a person's signed revocation too. A request is not kept
      // in the journal, since it names a holder; its outcome is.
      const kind = (record as { kind?: unknown } | null)?.kind;
      if (!reason && (kind === 'grant-request' || kind === 'revocation')) {
        try {
          if (kind === 'grant-request') {
            const r = record as { credential?: unknown; holder?: unknown; record?: unknown };
            if (typeof r.credential !== 'string' || (r.holder !== null && typeof r.holder !== 'string')) throw new ApprovalRefused('a grant request names a credential and a holder or null', 'not-a-record');
            await this.#takeGrantRequest(r.credential, r.holder as string | null, r.record);
            // S457: a person's credential with no holder is requested for the person the signed request names.
            const cred = this.#credential(r.credential);
            if (cred?.person && !cred.holder) {
              if (typeof r.holder !== 'string') throw new ApprovalRefused('a grant request for a credential that names no holder names the person as holder (PT10g, S457)', 'not-a-record');
              this.#authorizations.push({ credential: r.credential, url: await this.#requestForHolder(r.credential, r.holder) });
            } else this.#authorizations.push({ credential: r.credential, url: await this.requestGrant(r.credential, r.holder as string | null) });
          } else await this.revokeBySubject(record);
        } catch (e) { reason = e instanceof ApprovalRefused ? e.reason : 'unmatched'; message = (e as Error).message; }
        await this.store.txn(() => { this.store.appendEvent(APPROVALS_RUN, 'verdict', { stage: kind, file, ...(kind === 'revocation' ? { record: this.store.keep(text) } : {}), outcome: reason ? 'refused' : 'applied', ...(reason ? { reason } : {}) }, this.now()); });
        const to = join(dir, reason ? 'refused' : 'applied');
        mkdirSync(to, { recursive: true });
        const target = freeName(to, file);
        try { renameSync(join(dir, file), join(to, target)); if (reason) writeFileSync(join(to, `${target}.reason.txt`), `${reason}: ${message}\n`); } catch { this.unmovable.add(file); }
        out.push({ file, outcome: reason ? 'refused' : 'applied', ...(reason ? { reason } : {}) });
        continue;
      }
      if (!reason) {
        try { await this.approve(record); } catch (e) {
          if (!(e instanceof ApprovalRefused)) throw e;
          reason = e.reason;
          message = e.message;
        }
      }
      await this.store.txn(() => {
        this.store.appendEvent(APPROVALS_RUN, 'verdict', { stage: 'approval', file, record: this.store.keep(text), outcome: reason ? 'refused' : 'applied', ...(reason ? { reason } : {}) }, this.now());
      });
      const to = join(dir, reason ? 'refused' : 'applied');
      mkdirSync(to, { recursive: true });
      const target = freeName(to, file);
      // An entry that cannot be moved stays where it is, journaled once, and is passed over from then on.
      try {
        renameSync(join(dir, file), join(to, target));
        if (reason) writeFileSync(join(to, `${target}.reason.txt`), `${reason}: ${message}\n`);
      } catch { this.unmovable.add(file); }
      out.push({ file, outcome: reason ? 'refused' : 'applied', ...(reason ? { reason } : {}) });
    }
    return out;
  }

  /** The outbox rows of an instance (polyrun's), for hosts and tests that watch the intents. */
  outbox(instanceId: string) { return this.store.getOutbox(instanceId); }

  /** One outbox row by its intent id (its status and attempts), or null. */
  async outboxRow(intentId: string): Promise<{ intent_id: string; instance_id: string; kind: string; status: string; attempts: number; last_error: string | null } | null> {
    return this.store.txn(() => this.store.db.prepare('SELECT intent_id, instance_id, kind, status, attempts, last_error FROM pr_outbox WHERE intent_id = ?').get(intentId) ?? null);
  }

  /** The runtime's own model behind a machine id (an OutboxIntent instance), or null for a program's machine. */
  modelOf(machineId: string): { source: string; module: string } | null {
    const m = /^runtime(\d*)\.OutboxIntent$/.exec(machineId);
    if (!m) return null;
    const bound = m[1] ? Number(m[1]) : 3;
    return { source: modelSource(bound), module: verifiedModels([bound])[0].module };
  }

  /** S142: the exports of a certified handler file (a path poly.json names), as the runtime loaded it. */
  handlerExports(path: string): Readonly<Record<string, unknown>> {
    const ns = this.certified.get(path);
    if (!ns) throw new Error(`no certified handler file ${path}; the certificate binds ${[...this.certified.keys()].join(', ') || 'none'} (S142)`);
    return ns;
  }

  /**
   * PS18.2: a routed decision's intent, started, starts its route and waits for its end: the claim is held until the
   * route ends, which the sweep sees, so no lease runs out on a route whose tiers wait at the gate.
   */
  async #issueRoute(row: { intent_id: string; instance_id: string; kind: string }, decl: { decision?: { route?: string } } | null): Promise<boolean> {
    if (!decl?.decision?.route) return false;
    const machine = this.store.db.prepare('SELECT machine_id FROM pr_instance WHERE instance_id = ?').get(row.instance_id)?.machine_id as string;
    const route = this.#routing.routeOfDecision(machine, row.kind);
    if (!route) throw new Error(`${row.kind} of ${machine} names route ${decl.decision.route}, which the certificate does not name (PS18.2)`);
    await this.store.txn(async () => {
      const instance = await this.#routing.issue(row as never, route);
      this.store.appendEvent(row.instance_id, 'observation', { stage: 'route', intent: row.intent_id, outcome: 'issued', route: route.name, instance }, this.now());
      this.store.db.prepare(`UPDATE pr_outbox SET claimed_until = ? WHERE intent_id = ? AND status = 'inflight'`).run(Number.MAX_SAFE_INTEGER, row.intent_id);
    });
    return true;
  }

  /**
   * PS18.2: each route that ended completes its decision's intent: Answered with the answering tier's answer, whose
   * decision event the decision's own repeats and links; Exhausted with route-exhausted. Run after every pass of the
   * worker, so a route that ended before a crash completes at the next. Passes run at once share one sweep at a
   * time, so no route's end is taken twice.
   */
  #sweeping: Promise<void> = Promise.resolve();
  #sweepRoutes(): Promise<void> {
    const next = this.#sweeping.then(() => this.#sweepOnce());
    this.#sweeping = next.catch(() => undefined);
    return next;
  }

  async #sweepOnce(): Promise<void> {
    const running = this.store.db.prepare("SELECT intent, instance FROM poly_route WHERE status = 'running'").all() as { intent: string; instance: string }[];
    for (const r of running) {
      const end = ((await this.store.getInstance(r.instance))?.state as { r?: string } | undefined)?.r;
      if (end !== 'Answered' && end !== 'Exhausted') continue;
      if (end === 'Answered') {
        const e = this.store.db.prepare("SELECT event, hash FROM poly_ledger WHERE run = ? AND kind = 'decision' ORDER BY seq DESC LIMIT 1").get(r.instance) as { event: string; hash: string } | undefined;
        if (!e) throw new Error(`route ${r.instance} is Answered with no decision event for its answer (PS18.6)`);
        const body = JSON.parse(e.event).body as Record<string, unknown>;
        this.records.set(r.intent, { ...body, intent: r.intent, via: e.hash } as unknown as DecisionRecord);
        if (!(await this.worker.completeRoute(r.intent, { ok: true, result: { answer: body.answer, conf: body.conf, margin: body.margin } }))) continue;
      } else if (!(await this.worker.completeRoute(r.intent, { ok: false, reason: 'route-exhausted' }))) continue;
      // Review B1 (M11): the route is done only once its decision's intent is terminal, so a lost completion is taken again.
      await this.store.txn(() => { this.store.db.prepare("UPDATE poly_route SET status = 'done' WHERE intent = ?").run(r.intent); });
    }
  }

  /**
   * PS18.2, S356: the provider of every tier that names `provider`: host code, registered by the name the source gives,
   * and recorded in tests (recordedProvider). The tier's model, prices and map are the certificate's, never the host's.
   */
  provideTier(provider: string, fn: Provider): void {
    if (!this.verified.routes.some((r) => r.tiers.some((t) => t.provider === provider))) throw new Error(`no tier of a certified route names provider ${provider} (PS18.2)`);
    if (typeof fn !== 'function') throw new Error(`the provider of ${provider} is a function (S356)`);
    this.#routing.providers.set(provider, fn);
  }

  /** PT15: a handler for an effect kind. It runs only from the outbox worker, after the gate allows (PT9.2). */
  handle(kind: string, handler: Handler): void {
    // PS18.2: a route's call runs its tier's provider, through the runtime's own handler.
    if (this.verified.routes.some((r) => r.effectKind === kind)) throw new Error(`${kind} is a route's call: register its tiers' providers with rt.provideTier, never rt.handle (PS18.2)`);
    // S173: a workflow's mapped kind is a work order; the agent's report is its result, and no handler runs it.
    for (const [machine, kinds] of this.orderTools) if (kinds.has(kind)) throw new Error(`${kind} is a work order of workflow ${kinds.get(kind)!.workflow} on ${machine}: the agent's report settles it through rt.reportWorkOrder, and no handler runs it (S173)`);
    // Review B2: a decision's handler is the provider host's, which keeps the record its completion commits with.
    if (kind.startsWith('decision.')) throw new Error(`${kind} is a decision: register its provider with rt.provide, never rt.handle (PD2.2, K10)`);
    if (kind.startsWith('outcome.')) throw new Error(`${kind} is an adjudication's outcome, handled by the runtime itself (PD2.4)`);
    // PS17.2, PS17.5: a retrieval and a remember are the runtime's own, and so is an envelope retrieval (S459).
    if (/^source\.[^.]+\.(retrieve|remember|envelope)$/.test(kind)) throw new Error(`${kind} reads or writes a source: the runtime runs it through the source's certified adapter, connected with rt.connectSource (PS17.2)`);
    // Review D-F3 (M8b): a channel's send runs only through its certified adapter (S182).
    if (/^channel\.[^.]+\.send$/.test(kind)) throw new Error(`${kind} is a channel's send: connect its certified adapter with rt.connectChannel, never rt.handle (PT21.5, S182)`);
    // S142: only an export of a certified handler file, as this runtime loaded it, by identity. The same file imported
    // by the host is another module instance, and a closure is no file at all: neither is what the lint read.
    if (!this.certifiedFunctions.has(handler)) {
      const files = [...this.certified.keys()];
      throw new Error(`PL6404 HANDLER_NOT_CERTIFIED: the handler for ${kind} is not an export of a certified handler file as the runtime loaded it${files.length ? ` (take it from rt.handlerExports(${files.map((f) => JSON.stringify(f)).join(' | ')}))` : '; the certificate binds no handler file'} (S142)`);
    }
    this.#handlers.set(kind, handler);
  }

  /**
   * A creation action is a dispatch from outside too (review B1): caller-supplied $claims or $lineage are refused (S155),
   * and an action with claims gets them from the verifier, with the creation's credentials (PD5.1.4).
   */
  async create(machineId: string, opts: { id?: string; creation?: { action: string; data?: unknown }; credentials?: unknown } = {}): Promise<{ id: string; state: Record<string, unknown> }> {
    // PS18.4: a route's and a budget's instances are the runtime's own, created only by it.
    if (this.#routing.internal(machineId)) {
      const reason = `${machineId}: a route's or a budget's instance is created only by the runtime (PS18.2, PS18.4)`;
      await this.store.insertAudit({ at: this.now(), instanceId: opts.id ?? machineId, action: '$create', actionId: '$create', rule: 'PS18.4', reason });
      throw new RefusedDispatch(reason, 'PS18.4');
    }
    let creation = opts.creation;
    if (creation) {
      const id = opts.id ?? '';
      const actionId = `$create:${creation.action}`;
      const d = creation.data;
      const reserved = d && typeof d === 'object' && !Array.isArray(d) ? ['$claims', '$lineage', '$content'].filter((k) => k in (d as object)) : [];
      if (reserved.length) {
        const reason = `PL1208 RESERVED_NAME: the creation ${creation.action} of ${id || machineId} supplies ${reserved.join(' and ')}, which only the runtime writes (S155)`;
        await this.store.insertAudit({ at: this.now(), instanceId: id, action: creation.action, actionId, rule: 'S155', reason });
        throw new RefusedDispatch(reason, 'S155');
      }
      // Review C-F4, S140: creation data outside its action's type is no step, as at dispatch: refused, audited, no journal row.
      const why = this.outsideType(id, creation.action, d ?? {}, machineId);
      if (why) {
        const reason = `the creation ${creation.action} of ${id || machineId}: ${why}, so it is no step (PS3.2, S140)`;
        await this.store.insertAudit({ at: this.now(), instanceId: id, action: creation.action, actionId, rule: 'S140', reason });
        throw new RefusedDispatch(`${reason}: the input is outside its type`, 'S140');
      }
      if (this.claimed(machineId, creation.action)) {
        let claims: Record<string, unknown> | null = null;
        if (opts.credentials !== undefined) {
          try { claims = await this.verifier(opts.credentials, { instance: id, action: creation.action, data: d ?? {}, actionId }); } catch { claims = null; }
        }
        creation = { ...creation, data: { ...((d ?? {}) as object), $claims: claims ?? null } };
      }
    }
    if (creation) creation = { ...creation, data: this.markContent(machineId, creation.action, creation.data) };
    const r = await this.kernel.create(machineId, opts.id, creation);
    return { id: r.instanceId, state: r.state };
  }

  /**
   * PT15. polyrun refuses an outside dispatch of a live child's completion (K9); this refuses one of a decision's
   * completion (K10, S130), since only the worker delivers it with its decision event, and an input outside its
   * action's type (S140). Each comes before any step, with an audit row and no journal row.
   *
   * PT28.1b, PT10h: given a machine's Action from its types.d.ts, `rt.dispatch<Action>(id, 'A', data)` takes only one of
   * its actions and that action's data; with no type argument the call is untyped, as before.
   */
  async dispatch<T extends HostAction = HostAction>(instanceId: string, ...args: DispatchArgs<T, DispatchOpts>): Promise<DispatchResult> {
    const [action, data = {}, opts = {}] = args as [string, unknown?, DispatchOpts?];
    const actionId = opts.actionId ?? `${action}:${randomUUID()}`;
    const inst = await this.store.getInstance(instanceId);
    // S155: $claims and $lineage are the runtime's; a dispatch that supplies either is refused before any step.
    const reserved = data && typeof data === 'object' && !Array.isArray(data) ? ['$claims', '$lineage', '$content'].filter((k) => k in (data as object)) : [];
    if (reserved.length) {
      const reason = `PL1208 RESERVED_NAME: ${action} on ${instanceId} supplies ${reserved.join(' and ')}, which only the runtime writes (S155, S180)`;
      await this.store.insertAudit({ at: this.now(), instanceId, action, actionId, rule: 'S155', reason });
      throw new RefusedDispatch(reason, 'S155');
    }
    // Review C4: the hosted OutboxIntent instances are internal to the runtime; only its worker steps them.
    if (inst && this.modelOf(inst.machine_id)) {
      const reason = `${action} on ${instanceId}: an OutboxIntent instance is internal to the runtime, and only its worker takes its transitions (S119)`;
      await this.store.insertAudit({ at: this.now(), instanceId, action, actionId, rule: 'S119', reason });
      throw new RefusedDispatch(reason, 'S119');
    }
    // PS18.4: a route's and a budget's instances take steps only from the runtime: its reservations, settlements,
    // releases and its worker's completions.
    if (inst && this.#routing.internal(inst.machine_id)) {
      const reason = `${action} on ${instanceId}: a route's or a budget's instance takes steps only from the runtime, never from an outside dispatch (PS18.4)`;
      await this.store.insertAudit({ at: this.now(), instanceId, action, actionId, rule: 'PS18.4', reason });
      throw new RefusedDispatch(reason, 'PS18.4');
    }
    // PS16.4, review B2 (M9): a grant's transitions are the runtime's, from their sources; the host keeps TokenExpiring.
    if (inst && GRANT_ONLY.has(action) && !opts[GRANT_STEP] && this.verified.credentials.some((c) => c.machine === inst.machine_id)) {
      const reason = `${action} on ${instanceId}: a grant takes ${action} only from the runtime (its callback, its request, its refresh's completion, or a revocation of PS16.4), never from an outside dispatch`;
      await this.store.insertAudit({ at: this.now(), instanceId, action, actionId, rule: 'PS16.4', reason });
      throw new RefusedDispatch(reason, 'PS16.4');
    }
    const why = this.outsideType(instanceId, action, data, inst?.machine_id);
    if (why) {
      const reason = `${action} on ${instanceId}: ${why}, so it is no step (PS3.2, S140)`;
      await this.store.insertAudit({ at: this.now(), instanceId, action, actionId, rule: 'S140', reason });
      throw new RefusedDispatch(`${reason}: the input is outside its type`, 'S140');
    }
    // S173: a work order's completions are delivered by the runtime only, from the agent's report (K9).
    if (inst && this.workOrderCompletions(inst.machine_id).has(action)) {
      const reason = `K9: '${action}' completes a work order of '${instanceId}', and only the runtime delivers it, from the agent's report (S173)`;
      await this.store.insertAudit({ at: this.now(), instanceId, action, actionId, rule: 'K9', reason });
      throw new RefusedDispatch(reason, 'K9');
    }
    if (inst && this.decisionCompletions(inst.machine_id).has(action)) {
      const reason = `K10: '${action}' completes a decision of '${instanceId}', and only the outbox worker delivers it, with its decision event`;
      await this.store.insertAudit({ at: this.now(), instanceId, action, actionId, rule: 'K10', reason });
      throw new RefusedDispatch(reason, 'K10');
    }
    // S162: in a scope that requires attribution, an effect's completion and a timer's target are started only by
    // their completion or timer, which carry the emitting step's origin. From outside they would start a chain with no
    // origin, so they are refused before any step, as K9 and K10 refuse theirs; the gate's deny stays the second line.
    if (inst && this.policyGate?.requiresAttribution(inst.machine_id.slice(0, inst.machine_id.lastIndexOf('.'))) && this.startedInside(inst.machine_id).has(action)) {
      const reason = `S162: '${action}' on '${instanceId}' is started only by an effect's completion or a timer, and its scope requires attribution, so an outside dispatch of it would start a chain with no origin`;
      await this.store.insertAudit({ at: this.now(), instanceId, action, actionId, rule: 'S162', reason });
      throw new RefusedDispatch(reason, 'S162');
    }
    // PD5.1.4, K11: an action with claims gets them from the verifier adapter, under $claims; the module's first acceptor
    // rejects missing or bad ones (PS3.2's claims row). A verifier that throws is no answer: no claims (O10).
    let payload = inst ? this.markContent(inst.machine_id, action, data) : data;
    let evidence: Evidence | null = null;
    if (inst && this.claimed(inst.machine_id, action)) {
      let claims: Record<string, unknown> | null = opts[SUPPLIED_CLAIMS] ?? null;
      if (!claims && opts.credentials !== undefined) {
        try { claims = await this.verifier(opts.credentials, { instance: instanceId, action, data: data ?? {}, actionId }); } catch { claims = null; }
        evidence = claims ? claimsEvidence(claims) : null;
      }
      // PS8.9, K12: a mandate chain that widens anywhere, or holds a revoked mandate, is refused before any step.
      const problem = evidence?.mandates?.length ? chainProblem(evidence.mandates, (id) => this.mandateRevoked(id)) : null;
      if (problem) {
        const reason = `${problem}: ${action} on ${instanceId} carries a mandate chain that ${problem === 'mandate-revoked' ? 'holds a revoked mandate' : 'widens'}, so it is no step (PS8.9, K12)`;
        await this.store.insertAudit({ at: this.now(), instanceId, action, actionId, rule: 'PD6', reason });
        throw new RefusedDispatch(reason, 'PD6');
      }
      payload = { ...((payload ?? {}) as object), $claims: claims ? { ...claims } : null };
    }
    // PD5.2.2a: an outside dispatch starts a chain, whatever its action id.
    this.store.outside.add(`${instanceId}\u0000${actionId}`);
    // PS8.8, PS8.9: the evidence beside the claims is kept with the step and bound into its event.
    const evidenceKey = `${instanceId}\u0000${actionId}`;
    if (evidence && (evidence.verifiedAt !== undefined || evidence.statusAt !== undefined || evidence.mandates?.length)) this.store.pending.set(evidenceKey, { ...(this.store.pending.get(evidenceKey) ?? {}), evidence: { ...(evidence.verifiedAt !== undefined ? { verifiedAt: evidence.verifiedAt } : {}), ...(evidence.statusAt !== undefined ? { statusAt: evidence.statusAt } : {}), ...(evidence.mandates?.length ? { mandates: evidence.mandates } : {}) } });
    try {
      return await this.kernel.dispatch(instanceId, action, payload, actionId);
    } catch (e) {
      if (e instanceof InputOutsideType) {
        await this.store.insertAudit({ at: this.now(), instanceId, action, actionId, rule: 'S140', reason: e.message });
        throw new RefusedDispatch(e.message, 'S140');
      }
      if (!(e instanceof OutcomeWithoutDecision)) throw e;
      await this.store.insertAudit({ at: this.now(), instanceId, action, actionId, rule: 'PD2.4', reason: e.message });
      throw new RefusedDispatch(e.message, 'PD2.4');
    } finally {
      this.store.outside.delete(`${instanceId}\u0000${actionId}`);
      if (evidence) this.store.pending.delete(evidenceKey);
    }
  }

  /** PS8.9: whether a mandate was revoked; revoking one revokes every mandate beneath it, since every chain holds it. */
  mandateRevoked(id: string): boolean {
    return !!this.store.db.prepare('SELECT 1 FROM poly_revoked_mandate WHERE id = ?').get(id);
  }

  /** PS8.9, PD6-A6: revokes a mandate, and with it every mandate beneath it, from the next dispatch and the next proposal. */
  async revokeMandate(id: string): Promise<void> {
    await this.store.txn(() => { this.store.db.prepare('INSERT OR IGNORE INTO poly_revoked_mandate (id, at) VALUES (?, ?)').run(id, this.now()); });
  }

  /** PS8.8, PS8.9: the evidence kept with a run's step, or null. */
  stepEvidence(run: string, seq: number): Evidence | null {
    const r = this.store.db.prepare('SELECT body FROM poly_evidence WHERE run = ? AND seq = ?').get(run, seq) as { body: string } | undefined;
    return r ? (JSON.parse(r.body) as Evidence) : null;
  }

  /** PS8.9, S199: the runtime's mandate check of a proposal, before any policy: the innermost scope, at the decision time. */
  outsideMandate(run: string, seq: number, kind: string, payload: Record<string, unknown>): boolean {
    const chain = this.stepEvidence(run, seq)?.mandates as Mandate[] | undefined;
    if (!chain?.length) return false;
    if (chain.some((m) => this.mandateRevoked(m.id))) return true;
    return !withinScope(chain[chain.length - 1], kind, payload, this.now());
  }

  /**
   * PS3.2, S180: data whose Content names no body in the content store is marked, under the reserved key $content, so
   * the module's first acceptor rejects the step content-missing: journaled, the state unchanged. Every way in is
   * marked: a dispatch, a creation and an effect's completion.
   */
  markContent(machineId: string, action: string, data: unknown): unknown {
    const m = this.verified.machines.find((x) => x.id === machineId);
    if (!m) return data;
    const missing = contentValues(m.types, action, data).some((d) => !this.store.db.prepare('SELECT 1 FROM poly_content WHERE digest = ?').get(d));
    return missing ? { ...((data ?? {}) as object), $content: 'missing' } : data;
  }

  /** S180: stores a body in the content store and returns its Content, the digest of its bytes. */
  async putContent(body: string): Promise<string> {
    // Review C-F6, PS1.4a: a Content is the digest of the body's bytes. A string with a lone surrogate has no UTF-8
    // bytes of its own (each becomes U+FFFD), so two such bodies would share a digest; it is refused.
    if (typeof body !== 'string' || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(body)) throw new TypeError('putContent: a body is a well-formed string, with no lone surrogate (PS1.4a)');
    const d = `sha256:${createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex')}`;
    // S205: a body is erasable, and an erased one is not stored again. PS17.4: a body that enters this way carries ⊥, and a
    // program with memory keeps that record, so a body with no record is one the runtime never stored (fail closed).
    await this.store.txn(() => { this.store.keepErasable(d, body); if (this.memory.flows.size) this.memory.taint(d, BOTTOM); });
    return d;
  }

  /** Review B3: a body stored with its taint, and the source it was read from, in one transaction (PS17.4, PS17.7). */
  async #putTainted(body: string, taint: Taint, source: string | null): Promise<string> {
    if (typeof body !== 'string' || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(body)) throw new TypeError('a body is a well-formed string, with no lone surrogate (PS1.4a)');
    const d = `sha256:${createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex')}`;
    await this.store.txn(() => { this.store.keepErasable(d, body); this.memory.taint(d, taint); if (source) this.memory.fromSource(d, source); });
    return d;
  }

  /**
   * PS17.4a (S459): what content.read of one intent's handler is bound to: the Content values of the intent's own payload
   * (each payload value that is a body's digest, as the flow check reads them), how a body is read, and how a read is
   * recorded on runtime:content, by its digest and the intent, never the body. None when the payload holds no Content.
   */
  #contentFor(row: { intent_id: string; payload?: unknown }): ContentAccess | undefined {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const digests = [...new Set(Object.values(payload).filter((v): v is string => typeof v === 'string' && DIGEST.test(v)))];
    if (!digests.length) return undefined;
    return {
      digests,
      body: async (d) => (this.store.erased(d) ? null : this.contentBody(d)),
      recorded: async (d) => {
        this.store.ensureRun(CONTENT_RUN, 'runtime', 'content');
        await this.store.txn(() => { this.store.appendEvent(CONTENT_RUN, 'verdict', { stage: 'read', intent: row.intent_id, digest: d }, this.now()); });
      },
    };
  }

  /** S180: the body a Content names, or null when the store holds none. */
  async contentBody(d: string): Promise<string | null> {
    const r = this.store.db.prepare('SELECT body FROM poly_content WHERE digest = ?').get(d) as { body: string } | undefined;
    return r ? (JSON.parse(r.body) as string) : null;
  }

  /** PD5.2.2: a step's lineage, with its seq, or null. */
  lineageOf(run: string, seq: number): (Lineage & { seq: number }) | null {
    const l = this.store.lineage(run, seq);
    return l ? { seq, ...l } : null;
  }

  /** PD5.2.2b: whether a step's lineage chain is whole, and how many hops it has. */
  verifyLineage(run: string, seq: number): { ok: true; hops: number } | { ok: false; problem: string } {
    return this.store.verifyLineage(run, seq);
  }

  /** PD5.1.2: whether an action of a machine requires claims (its contract has the field $claims). */
  claimed(machineId: string, action: string): boolean {
    return this.verified.machines.find((x) => x.id === machineId)?.types.get(action)?.some(([p]) => p === '$claims') ?? false;
  }

  /** S140: why data is outside an action's type on an instance's machine, or null (a runtime model's actions take none). */
  outsideType(instanceId: string, action: string, data: unknown, machineId?: string): string | null {
    const id = machineId ?? (this.store.db.prepare('SELECT machine_id FROM pr_instance WHERE instance_id = ?').get(instanceId)?.machine_id as string | undefined);
    const m = this.verified.machines.find((x) => x.id === id);
    if (!m) return null;
    // Review C9: an address names a live instance of its machine, in the module of the machine that receives it.
    const module = m.id.slice(0, m.id.lastIndexOf('.'));
    // S176: a machine spelled m.M is a used module's, already its id.
    const exists = (machine: string, ref: string) => this.store.db.prepare('SELECT machine_id FROM pr_instance WHERE instance_id = ?').get(ref)?.machine_id === (machine.includes('.') ? machine : `${module}.${machine}`);
    return dataOutside(m.types, action, data, exists);
  }

  /** The manifest entry of an effect kind on an instance's machine, or null. */
  effectDeclaration(instanceId: string, kind: string): any {
    const id = this.store.db.prepare('SELECT machine_id FROM pr_instance WHERE instance_id = ?').get(instanceId)?.machine_id as string | undefined;
    return this.verified.machines.find((x) => x.id === id)?.manifest?.effects?.[kind] ?? null;
  }

  /** Review C5: audit the K10 refusals the store made inside transactions that rolled back. */
  async auditRefusals(): Promise<void> {
    for (const e of this.store.refused.splice(0)) await this.store.insertAudit({ at: this.now(), instanceId: e.instanceId, action: e.action, actionId: e.actionId, rule: 'K10', reason: e.message });
  }

  /** The decision whose ok completion an action is, on a machine, or null. */
  decisionOf(machineId: string, action: string): string | null {
    const m = this.verified.machines.find((x) => x.id === machineId);
    for (const [kind, e] of Object.entries(m?.manifest?.effects ?? {})) if (e.decision && e.onSuccess?.action === action) return kind.slice('decision.'.length);
    return null;
  }

  /** S162: the actions an effect's completions and the machine's timers start, as the certified manifest names them. */
  startedInside(machineId: string): Set<string> {
    const m = this.verified.machines.find((x) => x.id === machineId);
    const out = new Set<string>((m?.manifest as { timerTargets?: string[] } | null)?.timerTargets ?? []);
    for (const e of Object.values(m?.manifest?.effects ?? {})) {
      if (e.decision || e.outcome) continue;
      for (const h of ['onSuccess', 'onFailure', 'onExhausted']) if (e[h]?.action) out.add(e[h].action);
    }
    return out;
  }

  /** S173: the tool a workflow maps an instance's effect kind to, or null when the kind is not a work order. */
  orderToolOf(instanceId: string, kind: string): (WorkOrderTool & { workflow: string }) | null {
    const id = this.store.db.prepare('SELECT machine_id FROM pr_instance WHERE instance_id = ?').get(instanceId)?.machine_id as string | undefined;
    return (id && this.orderTools.get(id)?.get(kind)) || null;
  }

  /** S173: the actions a machine's work orders complete with, which only the runtime delivers (K9). */
  workOrderCompletions(machineId: string): Set<string> {
    const m = this.verified.machines.find((x) => x.id === machineId);
    const out = new Set<string>();
    for (const kind of this.orderTools.get(machineId)?.keys() ?? []) {
      const e = m?.manifest?.effects?.[kind];
      for (const h of ['onSuccess', 'onFailure', 'onExhausted']) if (e?.[h]?.action) out.add(e[h].action);
    }
    return out;
  }

  /** S173: the work orders open now, of one run or of all: each issued after the gate allowed it, and not yet reported. */
  async workOrders(instanceId?: string): Promise<WorkOrder[]> {
    return (await this.worker.openOrders(instanceId)).map(({ row, orderId, attempt, deadline }) => {
      const t = this.orderToolOf(row.instance_id, row.kind)!;
      return { orderId, intent: row.intent_id, idempotencyKey: row.intent_id, instanceId: row.instance_id, workflow: t.workflow, kind: row.kind, tool: t.tool, ...(t.target !== undefined ? { target: t.target } : {}), why: t.why, args: row.payload as Record<string, unknown>, attempt, deadline };
    });
  }

  /** S173: the agent's report of a work order, which settles its intent; any report but the open attempt's is refused and audited. */
  reportWorkOrder(orderId: string, report: { ok: boolean; result?: unknown; error?: string; permanent?: boolean }): Promise<ReportOutcome> {
    return this.worker.report(orderId, report);
  }

  /** S173: the run an order id belongs to, or null when no intent has that id. */
  orderRun(orderId: string): string | null {
    const p = parseOrderId(orderId);
    return p ? (this.store.db.prepare('SELECT instance_id FROM pr_outbox WHERE intent_id = ?').get(p.intent)?.instance_id as string | undefined) ?? null : null;
  }

  /** PT10: the certified workflows, as polyflow's catalogue lists them (S174). */
  workflowList(): { name: string; admitted: true; guarantees: string[]; tools: string[]; key: { template: string; derived_from: string[] } }[] {
    return this.verified.workflows.map((w) => ({
      name: w.name,
      admitted: true as const,
      guarantees: this.certificate.guarantees.filter((g) => g.startsWith(`${w.machine}:`) && g !== `${w.machine}:deadlock-free`).map((g) => g.slice(w.machine.length + 1)),
      tools: Object.entries(w.tools).map(([kind, t]) => `${kind} -> ${t.tool}`),
      key: { template: w.key.template, derived_from: keyFields(w) },
    }));
  }

  private workflowNamed(name: string): VerifiedWorkflow {
    const w = this.verified.workflows.find((x) => x.name === name);
    if (!w) throw new WorkflowError(`unknown workflow '${name}'`);
    return w;
  }

  /**
   * PT10, S174: starts a run, or attaches to the run its key already names. The key is derived from the input (a key
   * the caller passes is ignored, with a note), so starting is idempotent. The run is created with the input action.
   */
  async startWorkflow(name: string, input: Record<string, unknown> = {}, key?: string): Promise<{ instanceId: string; key: string; note?: string; attached: boolean }> {
    const w = this.workflowNamed(name);
    const derived = deriveKey(w, input);
    const note = key && key !== derived ? `key '${key}' ignored: this workflow's runs are identified by ${w.key.template} = '${derived}', derived from the input you gave.` : undefined;
    const instanceId = runIdOf(name, derived);
    if (await this.store.getInstance(instanceId)) return { instanceId, key: derived, attached: true, ...(note ? { note } : {}) };
    await this.create(w.machine, { id: instanceId, creation: { action: w.inputAction, data: input } });
    return { instanceId, key: derived, attached: false, ...(note ? { note } : {}) };
  }

  /** PT10: a run as polyflow's tools show it: its state, whether it is done, and its open work orders. */
  async workflowView(instanceId: string): Promise<{ instance: string; workflow: string; key: string; status: string; state: Record<string, unknown>; done: boolean; seq: number; orders: WorkOrder[] }> {
    const inst = await this.store.getInstance(instanceId);
    const w = inst ? this.verified.workflows.find((x) => x.machine === inst.machine_id && instanceId.startsWith(`${x.name}|`)) : undefined;
    if (!inst || !w) throw new WorkflowError(`no run '${instanceId}'`);
    return { instance: instanceId, workflow: w.name, key: keyOfRun(instanceId), status: inst.status, state: inst.state as Record<string, unknown>, done: inst.status !== 'active', seq: inst.seq, orders: await this.workOrders(instanceId) };
  }

  /**
   * Takes every step that is due now (effects, timers and messages), until a pass finds nothing to do, at most `passes`
   * times, so a view after a report shows the next order the gate allowed.
   */
  async advance(passes = 32): Promise<void> {
    for (let k = 0; k < passes; k++) {
      const r = await this.tick();
      if (!r.effects && !r.timers && !r.messages) return;
    }
  }

  /** The actions a machine's decisions and retrievals complete with, which only the worker dispatches (K10, PS17.4). */
  decisionCompletions(machineId: string): Set<string> {
    const m = this.verified.machines.find((x) => x.id === machineId);
    const out = new Set<string>();
    for (const e of Object.values(m?.manifest?.effects ?? {})) {
      if (!e.decision && !e.retrieve) continue;
      for (const h of ['onSuccess', 'onFailure', 'onExhausted']) if (e[h]?.action) out.add(e[h].action);
    }
    return out;
  }

  /** PD1.7, PD3: the provider of a decision, its model and its calibration map: runtime configuration, never certified. */
  provide(decision: string, config: ProviderConfig): void {
    const kind = `decision.${decision}`;
    const entry = this.verified.machines.map((m) => m.manifest?.effects?.[kind]).find(Boolean);
    if (!entry) throw new Error(`no decision ${decision} in the certified build`);
    // PS18.2: a routed decision's providers are its tiers', each registered by name.
    if (entry.decision?.route) throw new Error(`decision ${decision} is routed through ${entry.decision.route}: register its tiers' providers with rt.provideTier (PS18.2)`);
    if (config.calibration && config.calibration.decision !== decision) throw new Error(`the calibration map is for ${config.calibration.decision}, not ${decision}`);
    // Review B10, PD1.6: the decision event names the map by its digest, so the digest must be the map applied, and
    // the map must be the non-decreasing step function calibrate reads.
    if (config.calibration) {
      const c = config.calibration;
      if (c.digest !== mapDigest(c)) throw new Error(`the calibration map for ${decision} states digest ${c.digest}, and its points have ${mapDigest(c)}`);
      for (let i = 1; i < c.points.length; i++) {
        if (!(c.points[i][0] > c.points[i - 1][0])) throw new Error(`the calibration map for ${decision}: its raw values are not strictly ascending at point ${i}`);
        if (c.points[i][1] < c.points[i - 1][1]) throw new Error(`the calibration map for ${decision} is not non-decreasing at point ${i}: ${c.points[i - 1][1]} then ${c.points[i][1]}`);
      }
    }
    // PS17.2: the decision reads its materials, and a Content answer is kept with the decision's taint.
    const mem: DecisionMemory = {
      materials: (payload) => this.memory.materials(payload, (d) => this.contentBody(d), (b, t, s) => this.#putTainted(b, t, s)),
      answer: async (body, taint) => this.#putTainted(body, taint as Taint, null),
      cite: (given, ids, run, intent) => this.memory.cite(given, ids, run, intent, this.now()),
    };
    // PS18.4a (S454): a decision under a budget is priced from its certified table, and its record kept for settlement.
    const priced = entry.decision?.budget;
    const budget = priced ? {
      ...priced,
      scope: (instance: string) => { const id = this.store.db.prepare('SELECT machine_id FROM pr_instance WHERE instance_id = ?').get(instance)?.machine_id as string | undefined ?? ''; return id.slice(0, id.lastIndexOf('.')); },
      keep: (intent: string, record: DecisionRecord & Record<string, unknown>) => this.#routing.keep(intent, record),
    } : null;
    this.#handlers.set(kind, decisionHandler(decision, entry.decision?.provider ?? null, config, this.records, { content: entry.decision?.result === 'content', cites: entry.decision?.cites ?? null, mem }, budget));
  }

  /**
   * PD2.2d: every accepted completion of a decision links a decision event of the run, and its data are the
   * recorded answer, confidence and margin, through the manifest's own map. Each problem is PL9003.
   */
  /**
   * PD5-A11: each step event's claims digest is its journal row's claims, and its lineage digest is the step's lineage
   * record, which recomputes. Each problem is listed.
   */
  async verifyAttribution(run: string): Promise<string[]> {
    const problems: string[] = [];
    const journal = await this.store.getJournal(run);
    for (const e of await this.chain(run)) {
      if (e.kind !== 'step') continue;
      const b = e.body as { seq: number; claims?: string; lineage?: string };
      const row = journal.find((x) => x.seq === b.seq);
      if (!row) continue;
      if (b.claims !== undefined && b.claims !== digest((row.data as { $claims?: unknown } | null)?.$claims ?? null)) problems.push(`step ${b.seq}: the claims digest is not the journal row's claims`);
      const l = this.store.lineage(run, b.seq);
      if (b.lineage !== undefined) {
        if (!l) problems.push(`step ${b.seq}: no lineage record for its lineage digest`);
        else if (l.digest !== b.lineage) problems.push(`step ${b.seq}: the lineage record's digest is not the step event's`);
        else if (lineageDigest(run, b.seq, l.origin, l.intent, l.prev) !== l.digest) problems.push(`step ${b.seq}: the lineage record does not recompute to its digest`);
      }
    }
    return problems;
  }

  async verifyProvenance(instanceId: string): Promise<string[]> {
    const inst = await this.store.getInstance(instanceId);
    const events = await this.chain(instanceId);
    const wf = events[0]?.run.wf ?? inst?.machine_id;
    const m = this.verified.machines.find((x) => x.id === wf);
    const problems: string[] = [];
    const byHash = new Map(events.map((e) => [e.hash, e]));
    for (const [, entry] of Object.entries(m?.manifest?.effects ?? {})) {
      if (!entry.decision || !entry.onSuccess?.action) continue;
      for (const e of events) {
        const b = e.body as Record<string, any>;
        if (e.kind !== 'step' || b.action !== entry.onSuccess.action || b.stepKind !== 'accepted') continue;
        const d = b.decision ? byHash.get(b.decision) : undefined;
        if (!d || d.kind !== 'decision') { problems.push(`step ${b.seq} (${b.action}) completes a decision and links no decision event`); continue; }
        const data = await this.store.body(b.data) as Record<string, unknown> | undefined;
        const result = d.body as Record<string, unknown>;
        for (const [field, path] of Object.entries(entry.onSuccess.map ?? {})) {
          const want = String(path).replace(/^\$\.result\.?/, '').split('.').filter(Boolean).reduce<any>((v, k) => (v == null ? v : v[k]), result);
          // Compared canonically: a record's key order is not its value's (an Items' { ref, count }, PS17.6).
          if (digest(data?.[field] ?? null) !== digest(want ?? null)) problems.push(`step ${b.seq} (${b.action}): ${field} is ${JSON.stringify(data?.[field])}, and the decision event records ${JSON.stringify(want)}`);
        }
      }
    }
    return problems;
  }


  getState(instanceId: string) { return this.kernel.getState(instanceId); }
  getStateAt(instanceId: string, seq: number) { return this.kernel.getStateAt(instanceId, seq); }
  getJournal(instanceId: string): Promise<JournalRow[]> { return this.kernel.getJournal(instanceId); }
  list(machineId: string, status?: string) { return this.kernel.list(machineId, status); }
  audit(instanceId?: string) { return this.store.listAudit(instanceId); }

  /** Every instance the store holds, with its snapshot: the fold's cache (PS11.4). */
  async instances(): Promise<{ id: string; machineId: string; status: string; state: Record<string, unknown> }[]> {
    return this.store.txn(() => this.store.db.prepare('SELECT instance_id, machine_id, status, state FROM pr_instance ORDER BY instance_id').all()
      .map((r) => ({ id: r.instance_id as string, machineId: r.machine_id as string, status: r.status as string, state: JSON.parse(r.state) as Record<string, unknown> })));
  }

  /** Every run with a chain, archived ones included (PT16). */
  runs() { return this.store.runs(); }

  /** A run's chain (PT16). */
  chain(instanceId: string): Promise<LedgerEvent[]> { return this.store.chain(instanceId); }
  async verifyChain(instanceId: string): Promise<ChainResult> { return verifyRunChain(await this.chain(instanceId)); }

  /** PT16: an `advice` event (a Polyx verdict) on a run; it has no write path into the program. */
  async advise(instanceId: string, verdict: unknown): Promise<LedgerEvent> {
    return this.store.txn(() => this.store.appendEvent(instanceId, 'advice', verdict, this.now()));
  }

  /** S123: signs the latest head of each run that moved; off the step path. */
  async signHeads(only?: string): Promise<SignedHead[]> {
    if (!this.ledger) return [];
    return signHeads(this.store, this.ledger, only);
  }

  heads(instanceId: string): Promise<SignedHead[]> { return headsOf(this.store, instanceId); }

  /** S123: an anchor over the latest signed head of every run, for the period it names. */
  /** PD5.4b, S108: countersigns the latest signed head of each run through the host's adapter. */
  async countersignHeads(adapter: CountersignAdapter): Promise<Countersignature[]> {
    return countersignHeads(this.store, adapter);
  }

  async publishAnchor(period: { from: number; to: number }): Promise<{ anchor: Anchor; heads: SignedHead[] }> {
    if (!this.ledger) throw new Error('no ledger signer: an anchor is signed (S123)');
    return publishAnchor(this.store, this.ledger, period);
  }

  /** The chain, the signed heads, the closure and the binding to the journal while it exists (PT16). */
  async verifyRun(instanceId: string, trust: Record<string, string>): Promise<RunVerification> {
    const exists = await this.store.getInstance(instanceId);
    // PD5-A11, review B4: with the run's lineage records, so the lineage digest is bound here as in poly journal verify.
    const lineage = new Map((this.store.db.prepare('SELECT seq, origin, intent, prev, digest FROM poly_lineage WHERE run = ?').all(instanceId) as { seq: number; origin: string; intent: string; prev: string | null; digest: string }[]).map((r) => [r.seq, { origin: JSON.parse(r.origin), intent: r.intent, prev: r.prev, digest: r.digest }]));
    return verifyRun(await this.chain(instanceId), await this.heads(instanceId), trust, exists ? await this.getJournal(instanceId) : null, lineage, evidenceOf(this.store, instanceId));
  }

  /**
   * Archives a terminal instance: its `closure` event, then polyrun's purge, in one transaction, then its head is
   * signed (S122, S123). The chain outlives the purge; polyrun 8.4.0 drops the dedupe keys with the journal, which
   * K4 forbids, until E1 (S124).
   */
  async archive(instanceId: string): Promise<LedgerEvent> {
    const inst = await this.store.getInstance(instanceId);
    if (!inst) throw new Error(`unknown instance '${instanceId}'`);
    const closure = await this.store.txn(async () => {
      const e = this.store.appendEvent(instanceId, 'closure', { outcome: 'archived', seq: inst.seq, status: inst.status }, this.now());
      await this.store.purgeInstance(instanceId, inst.seq);
      return e;
    });
    await this.signHeads(instanceId);
    return closure;
  }

  /** A run's chain, signed heads and the bodies its step events name, for an auditor (PT16 trace export). */
  async exportRun(instanceId: string): Promise<{ events: LedgerEvent[]; heads: SignedHead[]; bodies: Record<string, unknown> }> {
    const events = await this.chain(instanceId);
    const bodies: Record<string, unknown> = {};
    for (const e of events) {
      if (e.kind !== 'step') continue;
      for (const k of ['data', 'pre', 'post']) { const d = (e.body as Record<string, string>)[k]; bodies[d] = await this.store.body(d); }
    }
    return { events, heads: await this.heads(instanceId), bodies };
  }

  /** PT15 streams: every intent of a kind, after the gate allowed it. Handlers remain the only way to execute an effect. */
  intents(kind: string): { subscribe(f: (intent: any) => void): () => void } {
    return {
      subscribe: (f) => {
        if (!this.intentSubscribers.has(kind)) this.intentSubscribers.set(kind, new Set());
        this.intentSubscribers.get(kind)!.add(f);
        return () => this.intentSubscribers.get(kind)?.delete(f);
      },
    };
  }

  /** PT15 streams: every labelled step of an instance, after its transaction commits. */
  inputs(instanceId: string): { subscribe(f: (step: any) => void): () => void } {
    return {
      subscribe: (f) => {
        if (!this.inputSubscribers.has(instanceId)) this.inputSubscribers.set(instanceId, new Set());
        this.inputSubscribers.get(instanceId)!.add(f);
        return () => this.inputSubscribers.get(instanceId)?.delete(f);
      },
    };
  }

  /** Timers and messages run on polyrun's own workers; effects never do (S119). */
  async tick(now = this.now()): Promise<{ effects: number; timers: number; messages: number }> {
    // Review C6: each pass runs whatever another one threw; the first error is reported after all three.
    const errors: unknown[] = [];
    const pass = async (f: () => Promise<number>) => { try { return await f(); } catch (e) { errors.push(e); return 0; } };
    await pass(() => this.recoverMessages(now));
    const effects = await pass(() => this.worker.tick(now));
    const timers = await pass(() => this.kernel.workers.tickTimers(now));
    const messages = await pass(() => this.tickMessages(now));
    await this.auditRefusals();
    if (errors.length) throw errors[0];
    return { effects, timers, messages };
  }

  /**
   * A message whose delivery lease expired (the worker crashed after claiming it, or after the receiver's step and
   * before the mark) goes back to pending and is sent again; the receiver dedupes it (K4, PT9.8). polyrun does this
   * in its effect tick, which poly-runtime does not run (S119), so the runtime does it here.
   */
  /**
   * PS8.7, PT9.9: delivers the messages in transit. A message between two trust scopes is first proposed to the
   * policy gate in the sender's session: allowed, it is delivered; denied, it is not, and SendDenied(to, action,
   * reason) is dispatched to the sender with its own action id. An escalation of a send has no approval path in M5a,
   * so it is denied, and says so. A gate that cannot decide leaves the message pending (PT9.5). Within one scope,
   * and without policies, messages are delivered as polyrun delivers them.
   */
  async tickMessages(now = this.now()): Promise<number> {
    let n = 0;
    for (const m of await this.kernel.workers.pendingMessages()) {
      const fromMachine = (this.store.db.prepare('SELECT machine_id FROM pr_instance WHERE instance_id = ?').get(m.from) as { machine_id: string } | undefined)?.machine_id;
      const toMachine = (this.store.db.prepare('SELECT machine_id FROM pr_instance WHERE instance_id = ?').get(m.to) as { machine_id: string } | undefined)?.machine_id;
      await this.#bindClaims(m, fromMachine, toMachine);
      const scope = (x: string | undefined) => (x ? x.slice(0, x.lastIndexOf('.')) : null);
      if (!this.policyGate || !fromMachine || !toMachine || scope(fromMachine) === scope(toMachine)) {
        if (await this.kernel.workers.deliverMessage(m.id, now)) n++;
        continue;
      }
      // Review D1, D2: a message has one gate decision. A delivery retried after an allow (the receiver's step committed
      // and the mark did not) is delivered under the recorded allow; a recorded deny is finished, not proposed again.
      const recorded = this.sendDecision(m.from, m.id);
      if (recorded?.outcome === 'allowed') { if (await this.kernel.workers.deliverMessage(m.id, now)) n++; continue; }
      if (recorded?.outcome === 'denied') { await this.sendDenied(m, recorded.reason ?? 'denied'); n++; continue; }
      // PD5.2.2b: the sender's step's lineage must be whole; a missing or broken chain is a deny with reason lineage.
      const outRow = this.store.db.prepare('SELECT seq FROM pr_outbox WHERE intent_id = ?').get(m.id) as { seq: number } | undefined;
      const chain = outRow ? this.store.verifyLineage(m.from, outRow.seq) : { ok: false as const, problem: 'the message has no sending step' };
      if (!chain.ok) {
        await this.store.txn(() => { this.store.appendEvent(m.from, 'verdict', { stage: 'gate', kind: 'send', intent: m.id, to: m.to, message: m.action, outcome: 'denied', reason: 'lineage', problem: chain.problem, gateDecision: 'lineage' }, this.now()); });
        await this.sendDenied(m, 'lineage');
        n++;
        continue;
      }
      const sender = await this.store.getInstance(m.from);
      let g;
      try {
        const l = outRow ? this.store.lineage(m.from, outRow.seq) : null;
        g = await this.policyGate.proposeSend({ id: m.id, from: m.from, to: m.to, fromMachine, toMachine, action: m.action, data: m.data, senderState: sender?.state ?? {}, lineage: l ? { origin: l.origin, intent: l.intent } : null });
      } catch (e) {
        const held = (e as { record?: Record<string, unknown> }).record;
        if (held) await this.store.txn(() => { const { action, ...rest } = held; this.store.appendEvent(m.from, 'verdict', { stage: 'gate', kind: 'send', intent: m.id, outcome: 'held', reason: String((e as Error).message), ...rest, gateDecision: 'held', action: this.store.keep(action) }, this.now()); });
        continue; // PT9.5: held, still pending
      }
      const { action, ...rest } = (g.record ?? {}) as Record<string, unknown>;
      const outcome = g.decision === 'allow' ? 'allowed' : 'denied';
      const reason = g.decision === 'allow' ? null : g.decision === 'escalate' ? `escalate:${g.reason ?? ''}: a send has no approval path in M5a, so it is denied` : g.reason;
      await this.store.txn(() => { this.store.appendEvent(m.from, 'verdict', { stage: 'gate', kind: 'send', intent: m.id, to: m.to, message: m.action, outcome, reason, ...rest, gateDecision: g.decision, action: this.store.keep(action) }, this.now()); });
      if (g.decision === 'allow') { if (await this.kernel.workers.deliverMessage(m.id, now)) n++; continue; }
      await this.sendDenied(m, reason ?? 'denied');
      n++;
    }
    return n;
  }

  /**
   * PS15.4 (S450): a message from a channel's conversation to an action of its application that declares claims carries,
   * under $claims, the origin claims of the sending step's lineage, restricted to the action's claims fields; none when
   * the chain started with none, and PS3.2's claims row then rejects the step. Written once, before the kernel delivers it.
   */
  async #bindClaims(m: { id: string; from: string; action: string; data: unknown }, fromMachine: string | undefined, toMachine: string | undefined): Promise<void> {
    if (!fromMachine || !toMachine) return;
    if (!this.verified.channels.some((c) => c.conversation === fromMachine && c.application === toMachine)) return;
    const t = this.verified.machines.find((x) => x.id === toMachine)?.types.get(m.action)?.find(([p]) => p === '$claims')?.[1];
    const rec = t?.k === 'record' ? t : t?.k === 'union' ? t.alts.find((a) => a.k === 'record') : undefined;
    if (!rec || rec.k !== 'record') return;
    const data = (m.data ?? {}) as Record<string, unknown>;
    if ('$claims' in data) return;
    const row = this.store.db.prepare('SELECT seq, payload FROM pr_outbox WHERE intent_id = ?').get(m.id) as { seq: number; payload: string } | undefined;
    if (!row) return;
    const origin = this.store.lineage(m.from, row.seq)?.origin as Record<string, unknown> | null | undefined;
    const claims = origin && typeof origin === 'object' && rec.fields.every(([f]) => f in origin) ? Object.fromEntries(rec.fields.map(([f]) => [f, origin[f]])) : null;
    const payload = JSON.parse(row.payload) as { data?: Record<string, unknown> };
    payload.data = { ...(payload.data ?? {}), $claims: claims };
    await this.store.txn(() => { this.store.db.prepare('UPDATE pr_outbox SET payload = ? WHERE intent_id = ?').run(JSON.stringify(payload), m.id); });
  }

  /** The gate's recorded decision on a message, from the sender's verdict events, or null (a held answer is none). */
  private sendDecision(from: string, id: string): { outcome: 'allowed' | 'denied'; reason: string | null } | null {
    for (const r of this.store.db.prepare(`SELECT event FROM poly_ledger WHERE run = ? AND kind = 'verdict' ORDER BY seq DESC`).all(from) as { event: string }[]) {
      const b = JSON.parse(r.event).body as { kind?: string; intent?: string; outcome?: string; reason?: string | null };
      if (b?.kind === 'send' && b.intent === id && (b.outcome === 'allowed' || b.outcome === 'denied')) return { outcome: b.outcome, reason: b.reason ?? null };
    }
    return null;
  }

  /**
   * PT9.9: SendDenied to the sender, with its own action id (so a second dispatch is deduped), then the message is
   * dead. The message is pending and unclaimed, so it is marked here, not through polyrun's mark for a claimed row.
   */
  private async sendDenied(m: { id: string; from: string; to: string; action: string }, reason: string): Promise<void> {
    try { await this.kernel.dispatch(m.from, 'SendDenied', { to: m.to, action: m.action, reason }, `${m.id}:send-denied`); } catch (e) {
      await this.store.insertAudit({ at: this.now(), instanceId: m.from, action: 'SendDenied', actionId: `${m.id}:send-denied`, rule: 'PT9.9', reason: String((e as Error).message) });
    }
    await this.store.txn(() => { this.store.db.prepare("UPDATE pr_outbox SET status = 'dead', claimed_until = NULL, attempts = attempts + 1, last_error = ? WHERE intent_id = ? AND status = 'pending'").run(`send denied: ${reason}`, m.id); });
  }

  async recoverMessages(now = this.now()): Promise<number> {
    return this.store.txn(() => this.store.db.prepare("UPDATE pr_outbox SET status = 'pending', claimed_until = NULL WHERE kind = 'sendTo' AND status = 'inflight' AND claimed_until < ?").run(now).changes);
  }

  startWorkers({ effectPollMs = 200, timerPollMs = 200, messagePollMs = 200 }: { effectPollMs?: number; timerPollMs?: number; messagePollMs?: number } = {}): void {
    const report = (e: unknown) => console.error('[poly-runtime]', (e as Error)?.message ?? e);
    const w = setInterval(() => { this.worker.tick().catch(report); }, effectPollMs);
    w.unref?.();
    this.timers.push(w);
    const t = setInterval(() => { this.kernel.workers.tickTimers().catch(report); }, timerPollMs);
    // Review C6, as in tick: each pass runs whatever the one before it threw, so a failing recovery starves neither
    // the message pass nor the audit of its K10 refusals.
    const m = setInterval(() => {
      void (async () => {
        for (const pass of [() => this.recoverMessages(), () => this.tickMessages(), () => this.auditRefusals()]) await pass().catch(report);
      })();
    }, messagePollMs);
    t.unref?.(); m.unref?.();
    this.timers.push(t, m);
    if (this.ledger?.headMs) { const h = setInterval(() => { this.signHeads().catch(report); }, this.ledger.headMs); h.unref?.(); this.timers.push(h); }
    if (this.ledger?.anchorMs) {
      let from = this.now();
      const a = setInterval(() => { const to = this.now(); this.publishAnchor({ from, to }).then(() => { from = to; }).catch(report); }, this.ledger.anchorMs);
      a.unref?.(); this.timers.push(a);
    }
  }

  stopWorkers(): void { for (const t of this.timers) clearInterval(t); this.timers = []; }

  async close(): Promise<void> { this.stopWorkers(); await this.kernel.close(); }
}

export async function load(buildDir: string, opts: LoadOptions): Promise<PolyRuntime> {
  const verified = verifyBuild(buildDir, resolve(opts.certificate), opts.trust, { allowWitness: opts.allowWitness, ...(opts.std ? { std: opts.std } : {}) });
  // S210, as ruled: no test hook is reachable in a project whose anchor says it is production.
  if (opts.fault !== undefined && verified.production) throw new LoadError(`refused at load: LoadOptions.fault (${String(opts.fault)}) is a test hook, and this project's anchor says it is production (S210)`);
  const dbPath = opts.store?.sqlite ?? ':memory:';
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  // S143: runtime.* and runtime<m>.* are the runtime's own ids, whatever this build or store needs. The checker refuses
  // them (PL1208); load refuses them again, so a certificate from an older toolchain cannot bring one in.
  const reserved = verified.machines.find((m) => RESERVED_MODULE.test(m.id.slice(0, m.id.lastIndexOf('.'))));
  if (reserved) throw new LoadError(`refused at load: the program's machine ${reserved.id} is in a module reserved for the runtime's own OutboxIntent model (PL1208, S143)`);
  const store = openLedgerStore(dbPath);
  // S119, S120: the OutboxIntent instance for every retry bound the build declares. Review C8: and every bound an
  // intent in the store started under, so it keeps its own machine after a redeploy changes the bound.
  const bounds = new Set<number>(verified.machines.flatMap((m) => Object.values(m.manifest?.effects ?? {}).map((e) => e.retry.maxAttempts as number)));
  for (const r of store.db.prepare("SELECT DISTINCT machine_id FROM pr_instance WHERE machine_id LIKE 'runtime%.OutboxIntent'").all() as { machine_id: string }[]) {
    const m = /^runtime(\d*)\.OutboxIntent$/.exec(r.machine_id);
    if (m) bounds.add(m[1] ? Number(m[1]) : 3);
  }
  const models = verifiedModels([...bounds].filter((b) => BOUNDS.includes(b as 1)).sort((x, y) => x - y));
  let kernel: Runtime;
  const certified = new Map<string, Readonly<Record<string, unknown>>>();
  try {
    kernel = await createRuntime({
      store,
      machines: [
        ...verified.machines.map((m) => ({ machineId: m.id, module: m.module, ...(m.contract ? { contract: m.contract } : {}), ...(m.effects ? { effects: m.effects } : {}) })),
        ...models.map((x) => ({ machineId: x.machineId, module: x.module, contract: x.contract })),
      ],
      ...(opts.now ? { now: opts.now } : {}),
    });
    recheckCopy(verified);
    // S142: the handlers, imported from their verified copies, after the copies are checked again.
    for (const [path, copy] of verified.handlers) {
      let ns: Record<string, unknown>;
      try { ns = await import(pathToFileURL(copy).href) as Record<string, unknown>; } catch (e) { throw new LoadError(`refused at load: the certified handler file ${path} does not import: ${(e as Error).message} (S142)`); }
      certified.set(path, Object.freeze({ ...ns }));
    }
    // S119: polyrun's own effect worker must never run beside the one that hosts OutboxIntent.
    (kernel as unknown as { startWorkers: () => never }).startWorkers = () => { throw new Error('polyrun\'s workers do not run under poly-runtime; use rt.startWorkers (S119)'); };
  } catch (e) {
    await store.close();
    if (e instanceof LoadError) throw e;
    throw new LoadError(`refused at load: polyrun did not register the certified machines: ${(e as Error).message}`);
  }
  // PT9: a build with policies runs behind the policy gate, and only behind it.
  let policyGate: PolicyGate | null = null;
  if (verified.policies.length) {
    if (opts.gate?.gate) { await kernel.close(); throw new LoadError('refused at load: the build has policies, so its gate is the policy gate, and no other gate is taken (PT9)'); }
    // Ruled on step 9: the checkout as it is now, never a status cached before it changed.
    const peer = polyaxionPeer({ fresh: true, ...(opts.policyEngine ? { dir: opts.policyEngine } : {}) });
    if (!peer.ok) { await kernel.close(); throw new LoadError(`refused at load: the build has policies, and the gate engine is not available: ${peer.reason}`); }
    // Plan step 9: the engine that decides is the one the build was admitted with.
    const pinned = verified.certificate.poly.policyEngine;
    if (!pinned || pinned.commit !== peer.commit) { await kernel.close(); throw new LoadError(`refused at load: the build was ${pinned ? `admitted with Polyaxion ${pinned.commit}` : 'admitted with no pinned gate engine'}; this runtime has Polyaxion ${peer.commit}`); }
    const modules = [...new Set(verified.machines.map((m) => m.id.slice(0, m.id.lastIndexOf('.'))))];
    const view: ProgramView = {
      singleton: (machineId) => {
        const rows = store.db.prepare("SELECT instance_id, seq, state FROM pr_instance WHERE machine_id = ? AND status != 'poisoned'").all(machineId) as { instance_id: string; seq: number; state: string }[];
        return rows.length === 1 ? { instance: rows[0].instance_id, seq: rows[0].seq, state: JSON.parse(rows[0].state) } : null;
      },
      decisions: (run) => {
        const out: Record<string, unknown> = {};
        for (const r of store.db.prepare("SELECT event FROM poly_ledger WHERE run = ? AND kind = 'decision' ORDER BY seq").all(run) as { event: string }[]) {
          const b = JSON.parse(r.event).body as { decision: string };
          out[b.decision] = b;
        }
        return out;
      },
      lineage: (run, seq) => { const l = store.lineage(run, seq); return l ? { origin: l.origin, intent: l.intent } : null; },
      // PS8.8, PS8.9: the evidence kept with a step, and the clock the gate decides by.
      stepEvidence: (run, seq) => { const r = store.db.prepare('SELECT body FROM poly_evidence WHERE run = ? AND seq = ?').get(run, seq) as { body: string } | undefined; return r ? JSON.parse(r.body) : null; },
      now: () => (opts.now ? opts.now() : Date.now()),
      stepClaims: (run, seq) => { const r = store.db.prepare('SELECT data FROM pr_journal WHERE instance_id = ? AND seq = ?').get(run, seq) as { data: string } | undefined; const c = r ? JSON.parse(r.data)?.$claims : null; return c && typeof c === 'object' ? c : null; },
      nextSseq: (session) => (store.db.prepare('INSERT INTO poly_gate_session (session, sseq) VALUES (?, 1) ON CONFLICT(session) DO UPDATE SET sseq = sseq + 1 RETURNING sseq').get(session) as { sseq: number }).sseq,
      recordLate: (run, record) => {
        const { action, ...rest } = record;
        return store.txn(() => { store.appendEvent(run, 'verdict', { ...rest, action: store.keep(action) }, opts.now ? opts.now() : Date.now()); });
      },
    };
    const gateStore = opts.gate?.policy?.store ?? (opts.store?.sqlite ? `${resolve(opts.store.sqlite)}.gate.db` : ':memory:');
    try { policyGate = await PolicyGate.open(await loadPolyaxion(), verified.policies, modules, view, { ...opts.gate?.policy, store: gateStore }); } catch (e) {
      await kernel.close();
      throw new LoadError(`refused at load: the policy gate did not open: ${(e as Error).message}`);
    }
  }
  // S182, plan step 10: the adapters are the ones admitted. The installed package is pinned again and compared.
  let ioPackage: IoPackage | null = null;
  // PT10f: a credential's vault is pinned the same way.
  // S308: and each source's adapter.
  const adapters = [...(verified.certificate.poly.adapters ?? []), ...(verified.certificate.poly.vaults ?? []), ...(verified.certificate.poly.memory?.sources ?? []).filter((s): s is typeof s & { package: string; version: string; digest: string } => s.adapter !== null)];
  if (adapters.length) {
    const now = adapterPackagePin();
    const other = adapters.find((x) => x.package !== now.package || x.version !== now.version || x.digest !== now.digest);
    if (other) { await kernel.close(); throw new LoadError(`refused at load: the build was admitted with ${other.package} ${other.version} ${other.digest}; this runtime has ${now.package} ${now.version} ${now.digest} (S182)`); }
    ioPackage = (await import(pathToFileURL(realpathSync(createRequire(import.meta.url).resolve('@poly/io'))).href)) as IoPackage;
  }
  return new PolyRuntime(kernel, store, verified, opts.ledger, { gate: opts.gate, worker: opts.worker, certified, policyGate, transports: opts.transports, verifier: opts.verifier, fault: opts.fault, ioPackage });
}

/** PS16.1: whether a Grant's state holds a scope, whose field is the scope with each . written _ (flat or nested). */
function scopeHeld(state: Record<string, unknown>, scope: string): boolean {
  const f = scope.split('.').join('_');
  const nested = state.scopes as Record<string, unknown> | undefined;
  return (nested && typeof nested === 'object' ? nested[f] : state[`scopes.${f}`]) === true;
}
