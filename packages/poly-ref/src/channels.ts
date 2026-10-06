// PS15, read by poly-ref on its own: what a channel means. poly-ref is given the source as written and never the
// compiler's expansion; it writes the expanded program from PS15's text, and translation validation compares the
// lowering with it. Only what PS15 says is written here; a channel the checker refuses never reaches poly-ref.
import type * as A from '@poly/core';

/** PS15: the module as a channel means it, the modules m.c of its conversations, and the program they are read in. */
export interface ChannelReading {
  module: A.Module;
  conversations: A.Module[];
  program: A.Module[];
  /** Per channel, what the runtime's descriptor must say (PS15.4): read back against the lowered one. */
  descriptors: Map<string, { application: string; conversation: string; starts: { action: string; onInbound: boolean }; inbound: { to: string; action: string }; peer: Record<string, string>; effectKind: string; pending: number; library: string }>;
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
    for (const d of decls) {
      if (d.kind !== 'Configuration') continue;
      const ofA = d.instances.filter((i) => [appName, `${module.name}.${appName}`].includes(i.machine.join('.')));
      if (!ofA.length) continue;
      for (const a of inputsOfConv) if (!d.inputs.some((r) => r.instance === convName && r.action === a)) d.inputs.push({ kind: 'InputRef', id: `ref:${d.id}:${ch.name}:${a}`, instance: convName, index: '*', action: a } as A.InputRef);
      if (d.bounds) d.bounds = { ...d.bounds, instances: (d.bounds.instances ?? d.instances.reduce((k, i) => k + (i.count ?? 1), 0)) + ofA.reduce((k, i) => k + (i.count ?? 1), 0) };
    }
    decls.push({
      kind: 'Configuration', id: `ref:${ch.id}:configuration`, name: ch.name,
      instances: [{ kind: 'ConfigInstance', id: `ref:${ch.id}:app`, name: 'app', count: null, machine: [appName], init: [] } as A.ConfigInstance],
      inputs: [{ kind: 'InputRef', id: `ref:${ch.id}:in`, instance: 'app', index: null, action: ch.starts!.action } as A.InputRef, ...inputsOfConv.map((a) => ({ kind: 'InputRef', id: `ref:${ch.id}:in:${a}`, instance: convName, index: '*', action: a } as A.InputRef))],
      bounds: { kind: 'ConfigBounds', id: `ref:${ch.id}:bounds`, transit: pending.hi, instances: 2 } as A.ConfigBounds,
      properties: [],
    } as A.Configuration);
    descriptors.set(ch.name, { application: `${module.name}.${appName}`, conversation: convName, starts: { action: ch.starts!.action, onInbound: ch.starts!.onInbound }, inbound: { to: 'conversation', action: 'Inbound' }, peer, effectKind: `channel.${ch.name}.send`, pending: pending.hi, library: library.name });
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
