// PS15, read by poly-ref on its own: what a channel means. poly-ref is given the source as written and never the
// compiler's expansion; it writes the expanded program from PS15's text, and translation validation compares the
// lowering with it. Only what PS15 says is written here; a channel the checker refuses never reaches poly-ref.
import { createHash } from 'node:crypto';
import type * as A from '@poly/core';

/**
 * PT1.4, written here from its text: a module's digest is the SHA-256 of the RFC 8785 canonical JSON of its AST with
 * each node's id and span left out. RFC 8785 serialises strings and numbers as ECMAScript does and sorts an object's
 * keys by UTF-16 code units; a key whose value is undefined is not a member.
 */
function canonical(x: unknown): string {
  if (x === null) return 'null';
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
  if (typeof x === 'object') {
    const o = x as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => k !== 'id' && k !== 'span' && o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  if (typeof x === 'number' && !Number.isFinite(x)) throw new TypeError('RFC 8785 has no non-finite number');
  return JSON.stringify(x);
}
const moduleDigest = (m: A.Module): string => `sha256:${createHash('sha256').update(canonical(m), 'utf8').digest('hex')}`;

/** PS15: the module as a channel means it, the modules m.c of its conversations, and the program they are read in. */
export interface ChannelReading {
  module: A.Module;
  conversations: A.Module[];
  program: A.Module[];
  /** Per channel, what the runtime's descriptor must say (PS15.4): read back against the lowered one. */
  descriptors: Map<string, { application: string; conversation: string; starts: { action: string; onInbound: boolean }; inbound: { to: string; action: string }; peer: Record<string, string>; effectKind: string; pending: number; library: string; libraryDigest: string; kind: string; adapter: string | null; thread: { template: string; fields: string[] } }>;
}

const readings = new WeakMap<A.Module, { libraries: A.Module[]; reading: ChannelReading }>();

/** PS15.0: a module with no channel means itself. */
export function readChannels(module: A.Module, program: A.Module[]): ChannelReading {
  const channels = module.decls.filter((d): d is A.Channel => d.kind === 'Channel');
  if (!channels.length) return { module, conversations: [], program, descriptors: new Map() };
  // Polywatch: a reading is the module's with the libraries it was read against; another program is read again.
  const libraries = channels.map((ch) => program.find((x) => x.name === `std.channels.${ch.channelKind}`)!);
  const known = readings.get(module);
  if (known && known.libraries.every((l, i) => l === libraries[i])) return known.reading;
  const decls: A.Decl[] = structuredClone(module.decls.filter((d) => d.kind !== 'Channel'));
  const conversations: A.Module[] = [];
  const descriptors: ChannelReading['descriptors'] = new Map();
  for (const ch of channels) {
    const library = program.find((x) => x.name === `std.channels.${ch.channelKind}`)!;
    const conv = library.decls.find((d): d is A.Machine => d.kind === 'Machine' && d.name === 'Conversation')!;
    const appName = ch.maps[0]?.machine ?? ch.starts!.machine;
    const app = decls.find((d): d is A.Machine => d.kind === 'Machine' && d.name === appName)!;
    const peer: Record<string, string> = Object.fromEntries(ch.maps.map((m) => [m.peer, m.action]));
    const home = `${module.name}.${ch.name}`;
    const convName = `${home}.Conversation`;
    // PS15.2: the last statement of starts spawns the conversation under the key c, its creation Open(app: self).
    const starts = app.items.find((i): i is A.Handler => i.kind === 'Handler' && i.action === ch.starts!.action)!;
    starts.body = [...starts.body, { kind: 'Intent', id: `ref:${ch.id}:spawn`, op: 'spawn', target: convName, modifier: 'detached', as: ch.name, index: null, to: null, extra: ['create', 'Open'], args: [{ name: 'app', value: { kind: 'Name', id: `ref:${ch.id}:self`, name: 'self' } }] } as A.IntentStmt];
    // PS15.3: emit c.reply and emit c.template are sends to the child c.
    const rewrite = (body: A.Stmt[]): A.Stmt[] => body.map((s): A.Stmt => {
      if (s.kind === 'If') return { ...s, then: rewrite(s.then), else: s.else ? rewrite(s.else) : s.else };
      if (s.kind === 'Match') return { ...s, arms: s.arms.map((a) => ({ ...a, body: rewrite(a.body) })) };
      if (s.kind === 'For') return { ...s, body: rewrite(s.body) };
      if (s.kind === 'Intent' && s.op === 'emit' && (s.target === `${ch.name}.reply` || s.target === `${ch.name}.template`)) {
        return { ...s, op: 'send', target: s.target.endsWith('.reply') ? 'Reply' : 'Template', to: { kind: 'Name', id: `ref:${s.id}:to`, name: ch.name } };
      }
      return s;
    });
    for (const h of app.items) if (h.kind === 'Handler') h.body = rewrite(h.body);
    // PS15.3: a handler bound to a receipt (Delivered, Rejected or Failed, PS15.0) gains send c <- Ack() last.
    for (const receipt of ['Delivered', 'Rejected', 'Failed']) {
      const h = peer[receipt] && app.items.find((i): i is A.Handler => i.kind === 'Handler' && i.action === peer[receipt]);
      if (h) h.body = [...h.body, { kind: 'Intent', id: `ref:${h.id}:ack`, op: 'send', target: 'Ack', args: [], to: { kind: 'Name', id: `ref:${h.id}:ack:to`, name: ch.name }, modifier: null, as: null, index: null } as unknown as A.IntentStmt];
    }
    // PS15.3: in A's handlers, c is the address p/c of the child spawned under the key c.
    app.channelKeys = [...(app.channelKeys ?? []), { key: ch.name, machine: convName }];
    decls.unshift({ kind: 'Use', id: `ref:${ch.id}:use`, path: convName.split('.') } as A.UseDecl);
    // PS15.1: Conversation with Ref<Peer> read as Ref<m.A>, each send to a Peer action renamed, and its effect send of
    // the kind channel.c.send; the library's types beside it.
    const appPath = [...module.name.split('.'), appName];
    const asApp = (x: unknown): unknown => {
      if (Array.isArray(x)) return x.map(asApp);
      if (!x || typeof x !== 'object') return x;
      const n = x as Record<string, unknown>;
      if (n.kind === 'TRef' && Array.isArray(n.machine) && n.machine.length === 1 && n.machine[0] === 'Peer') return { ...n, machine: appPath };
      if (n.kind === 'Intent' && n.op === 'send' && typeof n.target === 'string' && peer[n.target]) return { ...Object.fromEntries(Object.entries(n).map(([k, v]) => [k, asApp(v)])), target: peer[n.target] };
      if (n.kind === 'EffectDecl' && n.name === 'send') return { ...n, items: (n.items as A.EffectItem[]).map((it) => (it.kind === 'EffKind' ? { ...it, value: `channel.${ch.name}.send` } : it)) };
      return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, asApp(v)]));
    };
    const instance = asApp(conv) as A.Machine;
    conversations.push({ kind: 'Module', id: `ref:${ch.id}:module`, name: home, decls: [{ kind: 'Use', id: `ref:${ch.id}:module:use`, path: appPath } as A.UseDecl, ...library.decls.filter((d) => d.kind === 'EnumDecl' || d.kind === 'TypeDecl' || d.kind === 'RecordDecl'), instance] } as A.Module);
    // PS15.5: the configuration c, and the conversation in every declared one that includes A.
    const effect = conv.items.find((i): i is A.EffectDecl => i.kind === 'EffectDecl' && i.name === 'send');
    const receipts = (effect?.items ?? []).filter((i): i is A.EffOutcomeItem => i.kind === 'EffOutcome').map((i) => i.action);
    const inputsOfConv = ['Inbound', ...receipts.filter((r, i) => r !== 'Inbound' && receipts.indexOf(r) === i)];
    const pending = conv.fields.find((f) => f.name === 'pending')!.type as A.TRange;
    // Review A-F2 (M8b): only the declared configurations; another channel's generated one holds its own conversation.
    for (const d of decls) {
      if (d.kind !== 'Configuration' || d.generated) continue;
      const ofA = d.instances.filter((i) => [appName, `${module.name}.${appName}`].includes(i.machine.join('.')));
      if (!ofA.length) continue;
      for (const a of inputsOfConv) if (!d.inputs.some((r) => r.instance === convName && r.action === a)) d.inputs.push({ kind: 'InputRef', id: `ref:${d.id}:${ch.name}:${a}`, instance: convName, index: '*', action: a } as A.InputRef);
      if (d.bounds) d.bounds = { ...d.bounds, instances: (d.bounds.instances ?? d.instances.reduce((k, i) => k + (i.count ?? 1), 0)) + ofA.reduce((k, i) => k + (i.count ?? 1), 0) };
    }
    // PS15.5, ruled on the review of M8b (A-F2): the application and every conversation its starts handler spawns,
    // one per channel bound to it, counted here from the source as written.
    const bound = channels.filter((x) => (x.maps[0]?.machine ?? x.starts!.machine) === appName).length;
    decls.push({
      kind: 'Configuration', id: `ref:${ch.id}:configuration`, name: ch.name, generated: 'channel',
      instances: [{ kind: 'ConfigInstance', id: `ref:${ch.id}:app`, name: 'app', count: null, machine: [appName], init: [] } as A.ConfigInstance],
      inputs: [{ kind: 'InputRef', id: `ref:${ch.id}:in`, instance: 'app', index: null, action: ch.starts!.action } as A.InputRef, ...inputsOfConv.map((a) => ({ kind: 'InputRef', id: `ref:${ch.id}:in:${a}`, instance: convName, index: '*', action: a } as A.InputRef))],
      // Each other conversation gets no inputs, so it holds at most its creation Open(app) in transit (A-F2, as ruled).
      bounds: { kind: 'ConfigBounds', id: `ref:${ch.id}:bounds`, transit: pending.hi + bound - 1, instances: 1 + bound } as A.ConfigBounds,
      properties: [],
    } as A.Configuration);
    descriptors.set(ch.name, { application: `${module.name}.${appName}`, conversation: convName, starts: { action: ch.starts!.action, onInbound: ch.starts!.onInbound }, inbound: { to: 'conversation', action: 'Inbound' }, peer, effectKind: `channel.${ch.name}.send`, pending: pending.hi, library: library.name, libraryDigest: moduleDigest(library), kind: ch.channelKind, adapter: ch.adapter, thread: { template: ch.thread, fields: [...ch.thread.matchAll(/\{([^}]*)\}/g)].map((x) => x[1]) } });
  }
  // PS15.5 (S207), read from its text: an application bound to n > 1 channels whose handler of a message from one of
  // them emits a reply or a template on another gets one more configuration, named after it, every conversation live,
  // instances 1 + n, transit the sum of the pending bounds.
  for (const appName of new Set(channels.map((ch) => ch.maps[0]?.machine ?? ch.starts!.machine))) {
    const mine = channels.filter((ch) => (ch.maps[0]?.machine ?? ch.starts!.machine) === appName);
    if (mine.length < 2) continue;
    const source = module.decls.find((d): d is A.Machine => d.kind === 'Machine' && d.name === appName)!;
    const emits = (body: A.Stmt[], targets: Set<string>): boolean => body.some((s) => (s.kind === 'Intent' && s.op === 'emit' && targets.has(s.target)) || (s.kind === 'If' && (emits(s.then, targets) || emits(s.else ?? [], targets))) || (s.kind === 'Match' && s.arms.some((a) => emits(a.body, targets))) || (s.kind === 'For' && emits(s.body, targets)));
    const across = mine.some((ch) => {
      const others = new Set(mine.filter((x) => x !== ch).flatMap((x) => [`${x.name}.reply`, `${x.name}.template`]));
      return ch.maps.some((m) => source.items.some((i) => i.kind === 'Handler' && i.action === m.action && emits(i.body, others)));
    });
    if (!across) continue;
    const per = mine.map((ch) => decls.find((d): d is A.Configuration => d.kind === 'Configuration' && d.generated === 'channel' && d.name === ch.name)!);
    decls.push({
      kind: 'Configuration', id: `ref:${per[0].id}:joint`, name: appName, generated: 'channel', joint: mine.map((ch) => ch.name),
      instances: per[0].instances,
      inputs: [per[0].inputs[0], ...per.flatMap((c) => c.inputs.slice(1))],
      bounds: { kind: 'ConfigBounds', id: `ref:${per[0].id}:joint:bounds`, transit: mine.reduce((k, ch) => k + descriptors.get(ch.name)!.pending, 0), instances: 1 + mine.length } as A.ConfigBounds,
      properties: [],
    } as A.Configuration);
  }
  const expanded: A.Module = { ...module, decls };
  const reading: ChannelReading = { module: expanded, conversations, program: [...program.filter((x) => x.name !== module.name), expanded, ...conversations], descriptors };
  readings.set(module, { libraries, reading });
  return reading;
}

/** The module that holds a machine as poly-ref names it: `M` of the module, or `c.Conversation` of the channel c. */
export function machineHome(module: A.Module, program: A.Module[], machineName: string): { module: A.Module; machine: string; program: A.Module[]; reading: ChannelReading } {
  const r = readChannels(module, program);
  const dot = machineName.indexOf('.');
  if (dot > 0) {
    const home = r.conversations.find((x) => x.name === `${module.name}.${machineName.slice(0, dot)}`);
    if (home) return { module: home, machine: machineName.slice(dot + 1), program: r.program, reading: r };
  }
  return { module: r.module, machine: machineName, program: r.program, reading: r };
}
