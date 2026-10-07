// Channels (PS15, PT21): the compiler's expansion of `channel c: k { … }`. A channel adds no step of its own; it means
// the program this file writes: the conversation of `std.channels.k` instantiated as the module `m.c` with the
// application as its peer (PS15.1), a detached spawn of it in the `starts` handler (PS15.2), `emit c.reply` and
// `emit c.template` rewritten into sends (PS15.3), and the configuration `c` (PS15.5). poly-ref expands a channel
// from the same text on its own, and is never given this expansion.
import type * as A from './ast.js';
import { diag, type Diagnostic } from './diagnostics.js';

/** What a channel expanded into, for the lowering's descriptor and the report. */
export interface ChannelPlan {
  name: string;
  kind: string;
  library: string;
  adapter: string | null;
  thread: { template: string; fields: string[] };
  application: string;
  starts: { action: string; onInbound: boolean };
  /** The synthetic module `m.c` that holds the conversation. */
  module: string;
  /** Peer action to application action (PS15.1). */
  peer: Record<string, string>;
  effectKind: string;
  pending: number;
}

export interface ChannelExpansion {
  /** The module with each channel expanded: the spawn, the sends, the configuration and the use of `m.c`. */
  module: A.Module;
  /** One module `m.c` per channel, holding the instantiated conversation and the library's types. */
  extra: A.Module[];
  plans: ChannelPlan[];
  diagnostics: Diagnostic[];
}

const at = (module: A.Module, n: A.NodeBase) => ({ module: module.name, node: n.id, line: n.span?.line, col: n.span?.col });

/** A parameter type as text, with a type of a module named m.T, so two modules' parameters compare (PL6815). */
function typeKey(t: A.TypeExpr, mod: A.Module): string {
  switch (t.kind) {
    case 'TName': {
      const local = mod.decls.some((d) => (d.kind === 'EnumDecl' || d.kind === 'TypeDecl' || d.kind === 'RecordDecl') && d.name === t.name);
      return local ? `${mod.name}.${t.name}` : t.name;
    }
    case 'TMap': return `map<${typeKey(t.key, mod)},${typeKey(t.value, mod)}>`;
    case 'TRef': return `Ref<${t.machine.join('.')}>`;
    case 'TRange': return `${t.lo}..${t.hi}`;
    case 'TBool': return 'bool';
    case 'TInt': return 'int';
    case 'TString': return 'string';
    case 'TConf': return 'Conf';
  }
}
/** A check domain as its values, with no node ids. Review A-F4 (M8b): a set of values, so their order is not compared. */
const domainKey = (c: A.CheckClause): string => (c.domain.kind === 'DomainRange' ? `${c.domain.lo}..${c.domain.hi}` : JSON.stringify(c.domain.values.map((v) => JSON.stringify(v.kind === 'Name' ? v.name : v.value)).sort())) + (c.mode ? `:${c.mode}` : '');
const paramKey = (p: A.Param, mod: A.Module) => `${p.name}:${typeKey(p.type, mod)}${p.check ? `:${domainKey(p.check)}` : ''}`;

/** Each statement of a body, nested blocks included, for a visit that may rewrite it in place. */
function eachStmt(body: A.Stmt[], visit: (s: A.Stmt) => void): void {
  for (const s of body) {
    visit(s);
    if (s.kind === 'If') { eachStmt(s.then, visit); eachStmt(s.else ?? [], visit); }
    if (s.kind === 'Match') for (const a of s.arms) eachStmt(a.body, visit);
    if (s.kind === 'For') eachStmt(s.body, visit);
  }
}

/** PS15.0: the Peer actions that are the conversation's receipts, each acknowledged by the application (PS15.3). */
export const RECEIPTS = ['Delivered', 'Rejected', 'Failed'];

/** PS15: expands every channel of a module, or reports why one cannot be. A module with none is returned as it is. */
/**
 * PS15.5 (S207): whether the application answers a message from one of these channels on another: a handler of an action
 * the binding of channel c maps a Peer action to emits c'.reply or c'.template, c' another of them.
 */
function answersAcross(module: A.Module, channels: A.Channel[], appName: string): boolean {
  const app = module.decls.find((d): d is A.Machine => d.kind === 'Machine' && d.name === appName);
  if (!app) return false;
  let across = false;
  for (const c of channels) {
    const others = new Set(channels.filter((x) => x !== c).flatMap((x) => [`${x.name}.reply`, `${x.name}.template`]));
    for (const m of c.maps) {
      const h = app.items.find((i): i is A.Handler => i.kind === 'Handler' && i.action === m.action);
      if (h) eachStmt(h.body, (s) => { if (s.kind === 'Intent' && s.op === 'emit' && others.has(s.target)) across = true; });
    }
  }
  return across;
}

export function expandChannels(module: A.Module, program: A.Module[]): ChannelExpansion {
  const channels = module.decls.filter((d): d is A.Channel => d.kind === 'Channel');
  if (!channels.length) return { module, extra: [], plans: [], diagnostics: [] };
  const diagnostics: Diagnostic[] = [];
  const err = (code: string, n: A.NodeBase, message: string) => diagnostics.push(diag(code, at(module, n), message));
  const out: A.Module = structuredClone(module);
  out.decls = out.decls.filter((d) => d.kind !== 'Channel');
  const extra: A.Module[] = [];
  const plans: ChannelPlan[] = [];
  const names = new Set<string>();
  for (const c of channels) {
    if (names.has(c.name)) { err('PL1002', c, `channel ${c.name} is declared twice`); continue; }
    names.add(c.name);
    const libName = `std.channels.${c.channelKind}`;
    const lib = program.find((m) => m.name === libName);
    const conv = lib?.decls.find((d): d is A.Machine => d.kind === 'Machine' && d.name === 'Conversation');
    const peer = lib?.decls.find((d): d is A.Machine => d.kind === 'Machine' && d.name === 'Peer');
    const pending = conv?.fields.find((f) => f.name === 'pending');
    if (!lib || !conv || !peer) { err('PL6811', c, `channel ${c.name}: no channel kind ${c.channelKind}; ${lib ? `${libName} declares no ${conv ? 'Peer' : 'Conversation'} machine` : `no module ${libName}`} (PT21.1a)`); continue; }
    if (pending?.type.kind !== 'TRange' || pending.type.lo !== 0) { err('PL6811', c, `channel ${c.name}: ${libName}.Conversation declares no field pending: 0..N, whose N bounds the messages in transit (PS15.5)`); continue; }
    // Review A-F5 (M8b): PS15.0's interface of a conversation, each part of which the expansion or the runtime uses:
    // Open(app) for the spawn, Inbound for ingress, Reply and Template for the rewritten emits, and the effect send.
    const lacks = ['Open', 'Inbound', 'Reply', 'Template'].filter((a) => !conv.items.some((i) => i.kind === 'Action' && i.name === a) || !conv.items.some((i) => i.kind === 'Handler' && i.action === a));
    if (!conv.items.some((i) => i.kind === 'EffectDecl' && i.name === 'send')) lacks.push('the effect send');
    if (lacks.length) { err('PL6811', c, `channel ${c.name}: ${libName}.Conversation declares no ${lacks.join(', ')} with a handler; a conversation has each (PS15.0)`); continue; }
    const ack = conv.items.find((i): i is A.Action => i.kind === 'Action' && i.name === 'Ack');
    if (!ack || ack.params.length || !conv.items.some((i) => i.kind === 'Handler' && i.action === 'Ack')) { err('PL6811', c, `channel ${c.name}: ${libName}.Conversation declares no action Ack() with a handler, with which the application acknowledges a receipt (PS15.0, PS15.3)`); continue; }
    // The application: the one machine every binding and starts names.
    const apps = new Set([...c.maps.map((m) => m.machine), ...(c.starts ? [c.starts.machine] : [])]);
    if (apps.size !== 1) { err('PL1201', c, `channel ${c.name} binds ${apps.size ? [...apps].join(' and ') : 'no machine'}; a channel binds one application machine (PS15.1)`); continue; }
    const appName = [...apps][0];
    const appIndex = out.decls.findIndex((d) => d.kind === 'Machine' && d.name === appName);
    if (appIndex < 0) { err('PL1001', c, `channel ${c.name}: no machine ${appName} in module ${module.name}`); continue; }
    const app = out.decls[appIndex] as A.Machine;
    const appActions = new Map(app.items.filter((i): i is A.Action => i.kind === 'Action').map((a) => [a.name, a]));
    const peerActions = new Map(peer.items.filter((i): i is A.Action => i.kind === 'Action').map((a) => [a.name, a]));
    // PS15.1: the binding is total, one-to-one and typed.
    let bad = false;
    const binding: Record<string, string> = {};
    const target = new Map<string, string>();
    for (const m of c.maps) {
      if (!peerActions.has(m.peer)) { err('PL1001', m, `channel ${c.name}: ${libName}.Peer has no action ${m.peer}`); bad = true; continue; }
      if (binding[m.peer]) { err('PL1002', m, `channel ${c.name}: ${m.peer} is bound twice`); bad = true; continue; }
      const a = appActions.get(m.action);
      if (!a) { err('PL1001', m, `channel ${c.name}: ${appName} has no action ${m.action}`); bad = true; continue; }
      if (target.has(m.action)) { err('PL6814', m, `channel ${c.name}: ${target.get(m.action)} and ${m.peer} are both bound to ${appName}.${m.action}; the binding is one-to-one, so the application can tell the conversation's messages apart (PS15.1)`); bad = true; continue; }
      target.set(m.action, m.peer);
      const want = peerActions.get(m.peer)!.params.map((p) => paramKey(p, lib)).sort();
      const got = a.params.map((p) => paramKey(p, module)).sort();
      if (JSON.stringify(want) !== JSON.stringify(got)) { err('PL6815', m, `channel ${c.name}: ${appName}.${m.action}(${a.params.map((p) => p.name).join(', ')}) does not take what ${libName}.Peer.${m.peer}(${peerActions.get(m.peer)!.params.map((p) => p.name).join(', ')}) carries; a bound action has the Peer action's parameters, by name and type (PS15.1)`); bad = true; continue; }
      binding[m.peer] = m.action;
    }
    const unbound = [...peerActions.keys()].filter((p) => !c.maps.some((m) => m.peer === p));
    if (unbound.length) { err('PL6813', c, `channel ${c.name}: ${unbound.join(', ')} of ${libName}.Peer ${unbound.length === 1 ? 'is' : 'are'} bound to no action of ${appName}; the binding is total, since the conversation may send each (PS15.1)`); bad = true; }
    // PT21.1b: the thread key reads the conversation's Inbound fields, each a checked string.
    const inbound = conv.items.find((i): i is A.Action => i.kind === 'Action' && i.name === 'Inbound');
    const fields = [...c.thread.matchAll(/\{([^}]*)\}/g)].map((x) => x[1]);
    const strings = new Set((inbound?.params ?? []).filter((p) => p.type.kind === 'TString' && p.check).map((p) => p.name));
    const wrong = fields.filter((f) => !strings.has(f));
    if (!fields.length || wrong.length) { err('PL6812', c, `channel ${c.name}: the thread key "${c.thread}" ${fields.length ? `reads ${wrong.join(', ')}, which ${libName}.Conversation's Inbound does not declare as a checked string` : 'reads no field'}; it may read ${[...strings].join(', ') || 'none'} (PT21.1b)`); bad = true; }
    // PS15.2: starts, with no parameters and a handler, gains the spawn; the key c is the channel's.
    if (!c.starts) { err('PL1201', c, `channel ${c.name} names no starts action, whose handler spawns the conversation (PS15.2)`); continue; }
    const startsAction = appActions.get(c.starts.action);
    const startsHandler = app.items.find((i): i is A.Handler => i.kind === 'Handler' && i.action === c.starts!.action);
    if (!startsAction) { err('PL1001', c, `channel ${c.name}: ${appName} has no action ${c.starts.action}`); continue; }
    if (startsAction.params.length) { err('PL1201', c, `channel ${c.name}: ${appName}.${c.starts.action} takes parameters; the action that starts a thread takes none (PS15.4)`); bad = true; }
    if (!startsHandler) { err('PL1201', c, `channel ${c.name}: ${appName}.${c.starts.action} has no handler to spawn the conversation from (PS15.2)`); continue; }
    const keyUsed: string[] = [];
    if (app.fields.some((f) => f.name === c.name)) keyUsed.push('a field');
    // Review A-F3 (M8b): in a handler, c names the conversation; a parameter or a let of that name would hide it.
    for (const a of app.items) if (a.kind === 'Action' && a.params.some((p) => p.name === c.name)) keyUsed.push(`a parameter of ${a.name}`);
    for (const h of app.items) if (h.kind === 'Handler') eachStmt(h.body, (s) => {
      if (s.kind === 'Intent' && s.as === c.name) keyUsed.push(`the key of ${s.op} in on ${h.action}`);
      if (s.kind === 'Let' && s.name === c.name) keyUsed.push(`a let in on ${h.action}`);
    });
    if (keyUsed.length) { err('PL1002', c, `channel ${c.name}: ${appName} already uses ${c.name} as ${keyUsed.join(' and ')}; the conversation's child key is the channel's name (PS15.2)`); continue; }
    if (bad) continue;

    const synth = `${module.name}.${c.name}`;
    const convId = `${synth}.Conversation`;
    // PS15.2: the spawn, the last statement of starts.
    startsHandler.body.push({ kind: 'Intent', id: `${startsHandler.id}:channel:${c.name}`, span: c.span, op: 'spawn', target: convId, args: [{ name: 'app', value: { kind: 'Name', name: 'self', id: `${startsHandler.id}:channel:${c.name}:self` } }], to: null, modifier: 'detached', as: c.name, index: null, extra: ['create', 'Open'], generated: 'channel' } as A.IntentStmt);
    // PS15.3: emit c.reply(…) and emit c.template(…) are sends to the conversation.
    for (const h of app.items) if (h.kind === 'Handler') eachStmt(h.body, (s) => {
      if (s.kind !== 'Intent' || s.op !== 'emit' || !s.target.startsWith(`${c.name}.`)) return;
      const what = s.target.slice(c.name.length + 1);
      if (what !== 'reply' && what !== 'template') return;
      Object.assign(s, { op: 'send', target: what === 'reply' ? 'Reply' : 'Template', to: { kind: 'Name', name: c.name, id: `${s.id}:to` } });
    });
    // PS15.3: each handler of A bound to a receipt ends by acknowledging it. Ack is the expansion's: never bound.
    for (const r of RECEIPTS) {
      const h = binding[r] && app.items.find((i): i is A.Handler => i.kind === 'Handler' && i.action === binding[r]);
      if (h) h.body.push({ kind: 'Intent', id: `${h.id}:channel:${c.name}:ack`, span: c.span, op: 'send', target: 'Ack', args: [], to: { kind: 'Name', name: c.name, id: `${h.id}:channel:${c.name}:ack:to` }, modifier: null, as: null, index: null, generated: 'channel' } as unknown as A.IntentStmt);
    }
    // PS15.3: c names the address p/c of the conversation in every handler of A.
    app.channelKeys = [...(app.channelKeys ?? []), { key: c.name, machine: convId }];
    // The module names m.c.Conversation.
    out.decls.unshift({ kind: 'Use', id: `${c.id}:use`, path: convId.split('.') } as A.UseDecl);
    // PS15.1: the module m.c, with the library's types and the conversation instantiated with A as its peer.
    const inst = structuredClone(conv);
    const appRef = [...module.name.split('.'), appName];
    const retype = (x: unknown): void => {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) { x.forEach(retype); return; }
      const n = x as { kind?: string; machine?: string[] };
      if (n.kind === 'TRef' && n.machine?.length === 1 && n.machine[0] === 'Peer') n.machine = appRef;
      for (const [k, v] of Object.entries(n)) if (k !== 'span') retype(v);
    };
    retype(inst);
    for (const h of inst.items) if (h.kind === 'Handler') eachStmt(h.body, (s) => {
      if (s.kind === 'Intent' && s.op === 'send' && binding[s.target]) Object.assign(s, { target: binding[s.target], renamedFrom: s.target });
    });
    const send = inst.items.find((i): i is A.EffectDecl => i.kind === 'EffectDecl' && i.name === 'send');
    const effectKind = `channel.${c.name}.send`;
    // Review D-F8 (M8b): marked as the expansion's, the one place the reserved kind channel.<c>.send may come from.
    for (const it of send?.items ?? []) if (it.kind === 'EffKind') Object.assign(it, { value: effectKind, generated: 'channel' });
    const types = lib.decls.filter((d) => d.kind === 'EnumDecl' || d.kind === 'TypeDecl' || d.kind === 'RecordDecl').map((d) => structuredClone(d));
    extra.push({ kind: 'Module', id: `${c.id}:module`, name: synth, decls: [{ kind: 'Use', id: `${c.id}:module:use`, path: appRef } as A.UseDecl, ...types, inst] } as A.Module);
    // PS15.5: the configuration c.
    const group = convId;
    const receipts = (send?.items ?? []).filter((i): i is A.EffOutcomeItem => i.kind === 'EffOutcome').map((i) => i.action);
    const convInputs = [...new Set(['Inbound', ...receipts])];
    const N = pending.type.hi;
    const input = (instance: string, index: '*' | null, action: string, id: string): A.InputRef => ({ kind: 'InputRef', id, instance, index, action } as A.InputRef);
    if (out.decls.some((d) => d.kind === 'Configuration' && d.name === c.name)) { err('PL1002', c, `configuration ${c.name} is declared, and channel ${c.name} generates one of that name (PS15.5)`); continue; }
    // Declared configurations that include A get its conversation. Review A-F2 (M8b): another channel's generated
    // configuration is not a declared one; it holds only its own conversation, as PS15.5 makes it.
    for (const d of out.decls) {
      if (d.kind !== 'Configuration' || d.generated) continue;
      const mine = d.instances.filter((i) => i.machine.join('.') === appName || i.machine.join('.') === `${module.name}.${appName}`);
      if (!mine.length) continue;
      const count = mine.reduce((k, i) => k + (i.count ?? 1), 0);
      for (const a of convInputs) if (!d.inputs.some((r) => r.instance === group && r.action === a)) d.inputs.push(input(group, '*', a, `${d.id}:channel:${c.name}:${a}`));
      if (d.bounds) d.bounds.instances = (d.bounds.instances ?? d.instances.reduce((k, i) => k + (i.count ?? 1), 0)) + count;
    }
    const bound = channels.filter((x) => new Set([...x.maps.map((m) => m.machine), ...(x.starts ? [x.starts.machine] : [])]).has(appName)).length;
    out.decls.push({
      kind: 'Configuration', id: `${c.id}:configuration`, span: c.span, name: c.name, generated: 'channel',
      instances: [{ kind: 'ConfigInstance', id: `${c.id}:configuration:app`, name: 'app', count: null, machine: [appName], init: [] } as A.ConfigInstance],
      inputs: [input('app', null, c.starts.action, `${c.id}:in:starts`), ...convInputs.map((a) => input(group, '*', a, `${c.id}:in:${a}`))],
      // PS15.5, ruled on the review of M8b (A-F2): the application and the conversation of each channel bound to it; each
      // other conversation gets no inputs, so it holds at most its creation Open(app) in transit beside this one's N.
      bounds: { kind: 'ConfigBounds', id: `${c.id}:bounds`, transit: N + bound - 1, instances: 1 + bound } as A.ConfigBounds,
      properties: [],
    } as A.Configuration);
    plans.push({ name: c.name, kind: c.channelKind, library: libName, adapter: c.adapter, thread: { template: c.thread, fields }, application: appName, starts: { action: c.starts.action, onInbound: c.starts.onInbound }, module: synth, peer: binding, effectKind, pending: N });
  }
  // PS15.5 (S207, as ruled): an application that answers a message from one channel on another gets, beside the
  // configuration of each channel, one more named after it: every conversation live, the instance bound 1 + n and the
  // transit bound the sum of the conversations' pending bounds. poly-ref caps its exploration (10,000 global states).
  for (const appName of new Set(plans.map((p) => p.application))) {
    const mine = plans.filter((p) => p.application === appName);
    if (mine.length < 2 || !answersAcross(module, channels.filter((c) => mine.some((p) => p.name === c.name)), appName)) continue;
    const generated = mine.map((p) => out.decls.find((d): d is A.Configuration => d.kind === 'Configuration' && d.generated === 'channel' && d.name === p.name)!);
    if (out.decls.some((d) => d.kind === 'Configuration' && d.name === appName)) { err('PL1002', channels.find((c) => c.name === mine[0].name)!, `configuration ${appName} is declared, and the channels of ${appName} generate one of that name (PS15.5, S207)`); continue; }
    const first = generated[0];
    out.decls.push({
      kind: 'Configuration', id: `${first.id}:joint`, span: first.span, name: appName, generated: 'channel', joint: mine.map((p) => p.name),
      instances: first.instances,
      inputs: [first.inputs[0], ...generated.flatMap((g) => g.inputs.slice(1))],
      bounds: { kind: 'ConfigBounds', id: `${first.id}:joint:bounds`, transit: mine.reduce((k, p) => k + p.pending, 0), instances: 1 + mine.length } as A.ConfigBounds,
      properties: [],
    } as A.Configuration);
  }
  return { module: out, extra, plans, diagnostics };
}
