// plan-ex.md E2, "Run it yourself": the inbox host.
//
//   node examples/inbox/host/run.mjs run  --project <dir> [--drafts] [--once] [--interval <seconds>] [--fixtures <file>]
//   node examples/inbox/host/run.mjs link --project <dir> --account <label> [--drafts] [--by <keyId> --key <file>]
//   node examples/inbox/host/run.mjs ask  --project <dir> --todo <id> --do draft|propose|finish|dismiss
//
// `run` is the host: it loads the admitted project (poly.json's run field), connects the Google vaults, the Gmail source
// and the model providers, serves Google's redirect on loopback, and each pass takes the signed requests dropped in the
// approvals folder, syncs each account, lets the machines work, opens to-dos, retries what was held, and prints the digest.
// It holds no rule of the program (IT7): the gate, the policy and the machines decide, and the host forwards what they record.
//
// It starts READ-ONLY. Without --drafts it never dispatches WriteDraft, Edit or Propose, never connects the compose
// credential's vault, never registers the handler that creates a draft, and refuses a command to draft; so the effect
// gmail.createDraft cannot be reached (guard.mjs). `link` writes the owner's signed grant requests; `ask` leaves the host a
// command in <project>/commands, which a read-only host refuses.
//
// Keys: the Google client id and secret and the model key are read from the environment variables the config names, once,
// and are in no file, message or log. An expired model key makes decisions fail and be asked again later (providers.mjs);
// restart the host with a fresh key.
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commandNamed } from '@poly/check';
import { devKeychain, oauthVault, credentialIngress, gmailSource, fileMailStore, httpsTransport } from '@poly/io';
import { loadRun } from '@poly/runtime';
import { syncAccount, openTodos } from './inbox.mjs';
import { guarded, COMPOSE, ReadOnlyRefusal } from './guard.mjs';
import { readDigest, formatDigest } from './digest.mjs';
import { anthropicProvider, countFailures } from './providers.mjs';
import { loadFixtures, fakeGoogle, recordedModel } from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');
const READ = 'gmail_read';
/** Held messages are asked again this many times in a run of the host; a restart asks again. */
const RETRIES = 3;

class HostError extends Error {}

const option = (args, name) => { const at = args.indexOf(name); return at >= 0 && args[at + 1] !== undefined && !args[at + 1].startsWith('--') ? args[at + 1] : undefined; };

/** The host's config: names and paths, never a secret. */
export function readConfig(project, file) {
  const path = file ?? join(project, 'inbox.host.json');
  if (!existsSync(path)) throw new HostError(`no ${path}: run setup.mjs first (README.md)`);
  const c = JSON.parse(readFileSync(path, 'utf8'));
  if (c.v !== 1 || !Array.isArray(c.accounts) || !c.accounts.length) throw new HostError(`${path} is not the host's config`);
  return c;
}

/** The decisions' results, from the certified build's manifests: the allowed answers, or 'content'. */
export function decisionResults(buildDir) {
  const out = {};
  for (const e of readdirSync(buildDir, { withFileTypes: true })) {
    const f = join(buildDir, e.name, 'effects.manifest.json');
    if (!e.isDirectory() || !existsSync(f)) continue;
    for (const [kind, v] of Object.entries(JSON.parse(readFileSync(f, 'utf8')).effects ?? {})) if (kind.startsWith('decision.') && v.decision) out[kind.slice('decision.'.length)] = v.decision.result;
  }
  return out;
}

/**
 * The program's limits are for all n asks of a decision with a few answers (providers.mjs), so they must leave each ask room:
 * a share of the input for the email, and enough output for an answer. A program set up for fewer asks than the config says
 * is refused here, with the fix, rather than failing every decision at run time.
 */
export function checkSizing(buildDir, results, samples) {
  const small = [];
  const note = (name, input, output) => { if (Math.floor(input / samples) < 1000 || Math.floor(output / samples) < 8) small.push(`${name} (${input} input, ${output} output)`); };
  for (const e of readdirSync(buildDir, { withFileTypes: true })) {
    const f = join(buildDir, e.name, 'effects.manifest.json');
    if (!e.isDirectory() || !existsSync(f)) continue;
    for (const [kind, v] of Object.entries(JSON.parse(readFileSync(f, 'utf8')).effects ?? {})) {
      const name = kind.slice('decision.'.length);
      if (v.decision?.budget && Array.isArray(results[name])) note(name, v.decision.budget.maxInputTokens, v.decision.budget.maxTokens);
    }
  }
  const routes = join(buildDir, 'routes');
  for (const r of existsSync(routes) ? readdirSync(routes) : []) {
    for (const t of JSON.parse(readFileSync(join(routes, r), 'utf8')).tiers ?? []) note(`${r.replace(/.json$/, '')}, ${t.name} tier`, t.maxInputTokens, t.maxTokens);
  }
  if (small.length) throw new HostError(`the program's token limits are not sized for ${samples} asks: ${small.join('; ')}. Run setup.mjs with --samples ${samples}, or lower model.samples`);
}

/** The development keychain of one credential: its key is `file:PATH` and its blobs are in a directory of its own, `file:PATH` too (S200). */
export function keychainFor(config, credential) {
  const dir = join(config.vault.dir, credential);
  mkdirSync(dir, { recursive: true });
  return devKeychain({ key: config.vault.key, dir: `file:${dir}` });
}

/**
 * A callback server for Google's redirect, on loopback only: the code and state arrive in the query of a GET. The redirect
 * names `localhost`, which a browser may resolve to the IPv4 or the IPv6 loopback, so both are listened on (the IPv6 one
 * only where the machine has it). Returns a function that closes them.
 */
function serveCallback(handle, port) {
  const make = () => createServer((req, res) => {
    const m = /^\/credentials\/([A-Za-z_][A-Za-z0-9_]*)(?:[/?]|$)/.exec(req.url ?? '');
    if (!m || req.method !== 'GET') { res.writeHead(404).end(); return; }
    handle(m[1], { method: 'GET', url: `http://localhost:${port}${req.url}`, headers: {}, body: '' })
      .then((a) => res.writeHead(a.status, { 'content-type': a.contentType }).end(a.status === 200 ? 'Linked. You can close this tab and go back to the terminal.' : a.body))
      .catch(() => res.writeHead(500).end());
  });
  const servers = [['127.0.0.1', true], ['::1', false]].map(([host, required]) => {
    const server = make();
    server.on('error', (e) => { if (required) throw e; });
    server.listen(port, host);
    return server;
  });
  return () => Promise.all(servers.map((sv) => new Promise((res) => { if (sv.listening) sv.close(res); else res(); })));
}

const env = (name, what) => {
  const v = process.env[name];
  if (typeof v !== 'string' || v === '') throw new HostError(`set the environment variable ${name} (${what}); README.md says where to find it`);
  return v;
};

/** The providers: the recorded model of a dry run, the Anthropic provider, or the owner's own module (README.md, the contract). */
async function providersFor(config, { fixtures, results, onAuthFailure }) {
  if (fixtures) return recordedModel(fixtures.answers);
  const m = config.model;
  if (m.provider === 'anthropic') {
    if (typeof m.models?.small !== 'string' || typeof m.models?.large !== 'string' || m.models.small === '' || m.models.large === '') throw new HostError('set the model ids in inbox.host.json (model.models.small and model.models.large)');
    return anthropicProvider({ transport: httpsTransport, apiKey: env(m.keyEnv ?? 'ANTHROPIC_API_KEY', 'your model provider key'), models: m.models, results, samples: m.samples, onAuthFailure });
  }
  if (m.provider === 'module') {
    const made = await import(pathToFileURL(resolve(m.module)).href);
    if (typeof made.makeProviders !== 'function') throw new HostError(`${m.module} does not export makeProviders(deps) (README.md, the provider contract)`);
    return made.makeProviders({ results, config: m, env: process.env });
  }
  throw new HostError(`model.provider is "anthropic" or "module", not ${JSON.stringify(m.provider)}`);
}

/** Runs the machines until nothing is due: the runtime's clock, its worker, and at most `max` rounds. */
async function settle(rt, max = 300) {
  const due = () => rt.store.db.prepare("SELECT COUNT(*) AS n FROM pr_outbox WHERE status = 'inflight' OR (status = 'pending' AND next_attempt_at <= ?)").get(rt.now()).n;
  for (let i = 0; i < max; i++) {
    await rt.advance();
    await rt.worker.tick();
    if (due() === 0) { await rt.advance(); await rt.worker.tick(); if (due() === 0) return; }
  }
}

/** The thread key of a message's item, from the source's keys, so a to-do can be opened after a restart. */
async function threadOf(source, owner, item) {
  const [found] = await source.retrieve({ owner, key: { name: 'message', value: item }, limit: 1 });
  return found?.keys?.thread ?? null;
}

/** The host: loads everything once and returns the pass and the close. */
export async function startHost(opts, io) {
  const project = resolve(opts.project);
  const config = readConfig(project, opts.config);
  const drafts = opts.drafts === true;
  const fixtures = opts.fixtures ? loadFixtures(opts.fixtures) : null;
  const run = await loadRun(project);
  const { rt } = run;
  let closeServer = null;
  try {
    const host = guarded(rt, { drafts });
    const profile = JSON.parse(readFileSync(join(ROOT, 'std', 'credentials', 'providers', 'google.json'), 'utf8'));
    const google = fixtures ? fakeGoogle(fixtures, profile) : null;
    const http = google ? google.http : httpsTransport;
    const clientId = fixtures ? 'dry-run-client' : env(config.google.clientIdEnv, 'your OAuth client id');
    const clientSecret = fixtures ? 'dry-run-secret' : env(config.google.clientSecretEnv, 'your OAuth client secret');
    const vaults = {};
    for (const credential of drafts ? [READ, COMPOSE] : [READ]) {
      vaults[credential] = oauthVault(profile, { clientId, redirectUri: `${config.publicBase}/credentials/${credential}`, clientSecret }, keychainFor(config, credential), { http });
      host.connectVault(credential, vaults[credential]);
    }
    const callback = credentialIngress(rt, vaults, () => rt.now());
    if (!fixtures) closeServer = serveCallback(callback, config.port);

    const accounts = config.accounts;
    const source = gmailSource({
      accounts: accounts.map((a) => ({ owner: a.owner, label: a.label, request: rt.credentialHandle(READ, a.owner).request })),
      transport: rt.credentialHandle(READ),
      store: fileMailStore(`file:${config.mailDir}`),
    });
    rt.connectSource('mail', source);

    const build = join(project, '.poly', 'build');
    const results = decisionResults(build);
    // failures: model calls that failed since held messages were last asked again; the host starts owing one such round, so a
    // restart asks again for what was held.
    const state = { authFailed: false, failures: 1 };
    if (!fixtures && config.model.provider === 'anthropic') checkSizing(build, results, config.model.samples);
    const providers = countFailures(await providersFor(config, { fixtures, results, onAuthFailure: () => { state.authFailed = true; } }), state);
    rt.provideTier('small', providers.tiers.small);
    rt.provideTier('large', providers.tiers.large);
    for (const d of drafts ? ['summary', 'when', 'write'] : ['summary', 'when']) rt.provide(d, providers.decisions[d]);
    host.registerDraftHandler('gmail.createDraft', drafts ? rt.handlerExports('src/handlers.ts').createDraft : null);

    const retries = new Map();
    const say = (s) => io.out(`${s}\n`);

    /** Commands the owner left in <project>/commands: draft, propose, finish, dismiss. */
    async function commands() {
      const dir = join(project, 'commands');
      let names = [];
      try { names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { return; }
      for (const name of names) {
        const file = join(dir, name);
        let outcome = 'done';
        try {
          const c = JSON.parse(readFileSync(file, 'utf8'));
          const action = { draft: 'WriteDraft', propose: 'Propose', finish: 'Finish', dismiss: 'Dismiss' }[c.do];
          if (!action || typeof c.todo !== 'string') throw new HostError('a command is { "do": "draft" | "propose" | "finish" | "dismiss", "todo": "<id>" }');
          const r = await host.dispatch(c.todo, action, {});
          say(`${c.do} ${c.todo}: ${r.stepKind ?? 'sent'}`);
          if (r.stepKind === 'rejected') outcome = 'refused';
        } catch (e) {
          outcome = 'refused';
          say(`command ${name}: ${e instanceof ReadOnlyRefusal || e instanceof HostError ? e.message : `failed (${e.message})`}`);
        }
        const to = join(dir, outcome);
        mkdirSync(to, { recursive: true });
        renameSync(file, join(to, name));
      }
    }

    /** One pass: approvals, sync, work, to-dos, retries, digest. */
    async function pass() {
      const taken = await rt.takeApprovals(run.approvals);
      const auths = rt.takeAuthorizations();
      for (const t of taken) if (t.outcome === 'refused') say(`approvals: ${t.file} refused (${t.reason})`);
      const linked = taken.filter((t) => t.outcome === 'applied' && /^link-/.test(t.file));
      for (const [k, a] of auths.entries()) {
        if (google) {
          // The dry run consents for the owner, through the same callback Google's redirect reaches.
          const label = /^link-([a-z][a-z0-9-]*)-/.exec(linked[k]?.file ?? '')?.[1] ?? null;
          google.state.consenting = label;
          const res = await callback(a.credential, { method: 'GET', url: `${config.publicBase}/credentials/${a.credential}?code=c-${k}&state=${new URL(a.url).searchParams.get('state')}`, headers: {}, body: '' });
          google.state.consenting = null;
          say(`dry run: consent for ${label} (${a.credential}): ${res.status === 200 ? 'granted' : 'refused'}`);
        } else say(`link ${a.credential}: open this address in your browser, sign in to the account and allow access:\n  ${a.url}`);
      }
      await commands();

      const created = [];
      for (const acct of accounts) {
        try {
          const r = await syncAccount(rt, source, acct);
          created.push(...r.created);
          if (r.fallback) say(`${acct.label}: the history cursor had expired; the newest mail was listed again`);
        } catch (e) {
          say(/credential-unavailable/.test(e.message) ? `${acct.label}: not linked yet; run: link --account ${acct.label}` : `${acct.label}: sync failed (${e.message})`);
        }
      }
      await settle(rt);

      // Actionable messages without a to-do (a restart, or a message settled after the pass that made it).
      const pending = [];
      for (const { instance_id: id } of rt.store.db.prepare("SELECT instance_id FROM pr_instance WHERE machine_id = 'inbox.Message'").all()) {
        const s = (await rt.getState(id)).state;
        if (s.seen !== 'Actionable') continue;
        const thread = await threadOf(source, s.account, s.id).catch(() => null);
        if (thread) pending.push({ id, thread });
      }
      const opened = await openTodos(rt, pending);
      if (opened.length) await settle(rt);

      // Held messages are asked again only after a pass in which the model failed (and at the start of a run), a few times a
      // message, and not while the key is known to be refused: a message held because the model was unsure is not asked again
      // just to pay for the same doubt.
      if (!state.authFailed && state.failures > 0) {
        state.failures = 0;
        for (const { instance_id: id } of rt.store.db.prepare("SELECT instance_id FROM pr_instance WHERE machine_id = 'inbox.Message'").all()) {
          if ((await rt.getState(id)).state.seen !== 'Held' || (retries.get(id) ?? 0) >= RETRIES) continue;
          retries.set(id, (retries.get(id) ?? 0) + 1);
          await host.dispatch(id, 'Retry', {});
        }
        await settle(rt);
      }
      // The dry run shows what the fake Gmail was asked to do, which a live run sees in Gmail's Drafts.
      if (google) for (const d of google.created.splice(0)) say(`dry run: Gmail was asked to create a draft in thread ${d.threadId}, to ${/^To: ([^\r\n]*)/m.exec(d.raw)?.[1] ?? '?'}`);
      say(formatDigest(await readDigest(rt, { accounts, source }), { drafts }));
      if (state.authFailed) say('The model provider refused the key (expired or revoked). Messages wait, and nothing is guessed. Set a fresh key and restart the host (README.md, "If the model key expires").');
      return { created, opened };
    }

    return {
      rt, host, source, google, state, pass, drafts,
      async close() {
        if (closeServer) await closeServer();
        await run.close();
      },
    };
  } catch (e) {
    if (closeServer) await closeServer();
    await run.close();
    throw e;
  }
}

/** `link`: the owner's signed grant requests, one for each credential, dropped in the approvals folder. */
async function link(args, io) {
  const project = resolve(option(args, '--project') ?? '');
  const config = readConfig(project);
  const label = option(args, '--account');
  const acct = config.accounts.find((a) => a.label === label);
  if (!acct) throw new HostError(`--account is one of: ${config.accounts.map((a) => a.label).join(', ')}`);
  const by = option(args, '--by') ?? config.personKey.keyId;
  const key = option(args, '--key') ?? config.personKey.file;
  const dir = join(project, 'approvals');
  mkdirSync(dir, { recursive: true });
  const credentials = args.includes('--drafts') ? [READ, COMPOSE] : [READ];
  for (const credential of credentials) {
    const out = join(dir, `link-${acct.label}-${credential}.json`);
    await commandNamed('grant-request').run({ credential, for: acct.owner, by, key, out });
    io.out(`${out}\n`);
  }
  io.out('the running host takes it on its next pass and prints the address to open\n');
}

/** `ask`: a command for the running host. */
async function ask(args, io) {
  const project = resolve(option(args, '--project') ?? '');
  const todo = option(args, '--todo');
  const what = option(args, '--do');
  if (!todo || !['draft', 'propose', 'finish', 'dismiss'].includes(what)) throw new HostError('ask needs --todo <id> and --do draft|propose|finish|dismiss');
  const dir = join(project, 'commands');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${Date.now()}-${what}.json`);
  writeFileSync(file, JSON.stringify({ do: what, todo }) + '\n');
  io.out(`${file}\n`);
}

export async function main(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  const [cmd, ...args] = argv;
  try {
    if (cmd === 'link') { await link(args, io); return 0; }
    if (cmd === 'ask') { await ask(args, io); return 0; }
    if (cmd !== 'run') throw new HostError('usage: run.mjs run|link|ask --project <dir> ... (README.md)');
    const project = option(args, '--project');
    if (!project) throw new HostError('run needs --project <dir>');
    const once = args.includes('--once');
    const interval = Number(option(args, '--interval') ?? readConfig(resolve(project)).intervalSeconds ?? 300);
    const h = await startHost({ project, drafts: args.includes('--drafts'), fixtures: option(args, '--fixtures') }, io);
    let stop = false;
    const onSignal = () => { stop = true; };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
      io.out(`inbox host started: ${h.drafts ? 'drafts are allowed' : 'read-only'}; ${once ? 'one pass' : `a pass every ${interval} s, Ctrl-C to stop`}\n`);
      do { await h.pass(); if (!once && !stop) await new Promise((r) => setTimeout(r, interval * 1000)); } while (!once && !stop);
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      await h.close();
    }
    return 0;
  } catch (e) {
    if (e instanceof HostError) { io.err(`inbox: ${e.message}\n`); return 64; }
    throw e;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
