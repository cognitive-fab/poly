// plan-ex.md E2, "Run it yourself", step 1: scaffolds the owner's project from examples/inbox, outside the repository.
//
//   node examples/inbox/host/setup.mjs --project <dir> --keys <dir> --account <label>:<owner> ... \
//     --small-model <id> --small-price <usd per million in>,<out> --large-model <id> --large-price <in>,<out> \
//     --prices-source <https url> --prices-read-on <YYYY-MM-DD> [--samples 5] [--threshold 0.9] [--cap 20] [--port 8765]
//
// It writes the program tailored to the owner's choices, the policy as it is, the price tables and identity calibration
// maps for the owner's models (uncalibrated until they are refitted), the certified handler for a draft, poly.json, and
// the host's config; and it generates the owner's keys into --keys, a directory outside the project and outside this
// repository. It prints paths and the commands that come next, and never a key. It overwrites nothing: a project
// directory that has files, or a key that exists, is left as it is.
//
// The program is tailored in exactly the places README.md names, each found exactly once or the script stops:
// the confidence thresholds, the token limits (an nth of them is each ask's share, so they are n times the example's), the
// timeouts (a live model is slower than a recording), and the monthly cap. The example's own verdict, CLEAN with its
// instance, is for the example; the tailored program is checked again by `poly admit`.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = resolve(HERE, '..');
const ROOT = resolve(EXAMPLE, '..', '..');

class SetupError extends Error {}

const inside = (dir, path) => {
  const real = (p) => { try { return realpathSync.native(p); } catch { return resolve(p); } };
  const rel = relative(real(dir), real(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

function option(args, name) {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] !== undefined && !args[at + 1].startsWith('--') ? args[at + 1] : undefined;
}
const options = (args, name) => args.flatMap((a, i) => (a === name && args[i + 1] !== undefined ? [args[i + 1]] : []));

/** The program for n asks, a threshold, a cap and the timeouts of a live model, each change found exactly once or the stated times. */
export function tailor(text, { samples, threshold, cap }) {
  let s = text.replace(/\r\n/g, '\n');
  const sub = (re, to, times) => {
    const n = [...s.matchAll(re)].length;
    if (n !== times) throw new SetupError(`the example has changed: ${re} is found ${n} time(s), and setup expects ${times}`);
    s = s.replace(re, to);
  };
  sub(/^\/\/ expected: CLEAN\n/gm, `// Tailored by examples/inbox/host/setup.mjs from examples/inbox/inbox.poly: ${samples} asks per decision, confidence threshold ${threshold}, monthly cap ${cap} usd.\n// The example's expected verdict is for the example; this program is checked again when you admit it.\n`, 1);
  sub(/escalate when conf < 0\.8 or failed/g, `escalate when conf < ${threshold} or failed`, 2);
  sub(/if conf >= 0\.8 \{/g, `if conf >= ${threshold} {`, 1);
  sub(/max input tokens 4000 max tokens 20(?!\d)/g, `max input tokens ${4000 * samples} max tokens ${20 * samples}`, 5);
  sub(/timeout 2s/g, 'timeout 30s', 2);
  sub(/timeout 5s/g, 'timeout 30s', 2);
  sub(/timeout 20s/g, 'timeout 60s', 1);
  sub(/cap usd 20 per month/g, `cap usd ${cap} per month`, 1);
  return s;
}

/** The reservation of a call, in micro-usd, as poly computes it: ceil((I x P_in + N x P_out) / 10^6) (PS18.3, S360). */
export const reservationOf = (inTokens, outTokens, price) => Math.ceil((inTokens * price.input + outTokens * price.output) / 1e6);

/** USD per million tokens, as typed, in micro-usd per million as the tables hold them. */
function microPrice(text, what) {
  const m = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(text ?? '');
  if (!m) throw new SetupError(`${what} is "<usd per million input tokens>,<usd per million output tokens>", for example 1,5; read it from the provider's pricing page`);
  return { input: Math.round(Number(m[1]) * 1e6), output: Math.round(Number(m[2]) * 1e6) };
}

/** The reservations of the tailored program's decisions and tiers, and the largest, in micro-usd. */
export function reservations({ samples, small, large }) {
  const n = samples;
  const rows = [
    ['triage, small tier', reservationOf(4000 * n, 20 * n, small)],
    ['triage, large tier', reservationOf(4000 * n, 20 * n, large)],
    ['kinds, small tier', reservationOf(4000 * n, 20 * n, small)],
    ['kinds, large tier', reservationOf(4000 * n, 20 * n, large)],
    ['when', reservationOf(4000 * n, 20 * n, small)],
    ['summary', reservationOf(4000, 200, small)],
    ['write (a draft)', reservationOf(8000, 1000, large)],
  ];
  return { rows, largest: Math.max(...rows.map((r) => r[1])) };
}

/** An Ed25519 key pair as PEM files: the private key written exclusively with owner-only permissions, never overwritten. */
function writeKey(dir, name) {
  const priv = join(dir, `${name}.pem`);
  const pub = join(dir, `${name}.pub.pem`);
  if (existsSync(priv)) return { priv, pub, kept: true, publicPem: readFileSync(pub, 'utf8') };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
  writeFileSync(pub, publicPem, { flag: 'wx' });
  return { priv, pub, kept: false, publicPem };
}

export async function main(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  try {
    const project = option(argv, '--project');
    const keys = option(argv, '--keys');
    if (!project || !keys) throw new SetupError('setup needs --project <dir> and --keys <dir>');
    const projectDir = resolve(project);
    const keysDir = resolve(keys);
    if (inside(projectDir, keysDir) || inside(keysDir, projectDir)) throw new SetupError('the key directory is inside the project (or the project inside it): a key in the project is one git add from being committed; choose a directory elsewhere');
    if (inside(ROOT, keysDir) || inside(ROOT, projectDir)) throw new SetupError(`the project and the key directory belong outside this repository (${ROOT}), so that nothing of yours is ever committed with it`);
    if (existsSync(projectDir) && readdirSync(projectDir).length) throw new SetupError(`${projectDir} already has files; setup writes a new project and overwrites nothing`);

    const accounts = options(argv, '--account').map((a) => {
      const m = /^([a-z][a-z0-9-]{0,31}):([A-Za-z][A-Za-z0-9._-]{0,63})$/.exec(a);
      if (!m) throw new SetupError(`--account is <label>:<owner>, a lower-case label and the principal you name this account's owner, for example work:me-work; got ${JSON.stringify(a)}`);
      return { label: m[1], owner: m[2] };
    });
    if (!accounts.length) throw new SetupError('name at least one --account <label>:<owner>');
    if (new Set(accounts.map((a) => a.label)).size !== accounts.length || new Set(accounts.map((a) => a.owner)).size !== accounts.length) throw new SetupError('a label or an owner is named twice');
    const models = { small: option(argv, '--small-model'), large: option(argv, '--large-model') };
    if (!models.small || !models.large) throw new SetupError('name the models: --small-model <id> and --large-model <id>, ids from your model provider');
    const small = microPrice(option(argv, '--small-price'), '--small-price');
    const large = microPrice(option(argv, '--large-price'), '--large-price');
    const source = option(argv, '--prices-source');
    const readOn = option(argv, '--prices-read-on');
    if (!source || !/^https:\/\//.test(source) || !readOn || !/^\d{4}-\d{2}-\d{2}$/.test(readOn)) throw new SetupError('--prices-source is the https page you read the prices on, and --prices-read-on the date you read them (YYYY-MM-DD)');
    const samples = Number(option(argv, '--samples') ?? 5);
    const threshold = option(argv, '--threshold') ?? '0.9';
    const cap = Number(option(argv, '--cap') ?? 20);
    const port = Number(option(argv, '--port') ?? 8765);
    if (!Number.isInteger(samples) || samples < 3 || samples > 9) throw new SetupError('--samples is a whole number from 3 to 9');
    if (!/^0\.\d{1,2}$/.test(threshold) || Number(threshold) <= 0) throw new SetupError('--threshold is a decimal in (0, 1), for example 0.9');
    if (!Number.isFinite(cap) || cap <= 0 || cap > 99) throw new SetupError('--cap is the monthly limit in usd, more than 0 and under 100');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new SetupError('--port is a port from 1024 to 65535');

    // The cap must hold the largest reservation (PL6845); say so here rather than at the check.
    const { rows, largest } = reservations({ samples, small, large });
    if (cap * 1e6 < largest) throw new SetupError(`--cap ${cap} usd is below the largest reservation, ${largest / 1e6} usd (${rows.find((r) => r[1] === largest)[0]}); raise the cap or lower --samples`);

    // The project.
    mkdirSync(join(projectDir, 'src', 'maps'), { recursive: true });
    mkdirSync(join(projectDir, 'src', 'prices'), { recursive: true });
    mkdirSync(join(projectDir, 'approvals'), { recursive: true });
    mkdirSync(keysDir, { recursive: true });
    writeFileSync(join(projectDir, 'src', 'inbox.poly'), tailor(readFileSync(join(EXAMPLE, 'inbox.poly'), 'utf8'), { samples, threshold, cap }));
    cpSync(join(EXAMPLE, 'inbox.policy.poly'), join(projectDir, 'src', 'inbox.policy.poly'));
    // The handler that creates a draft is the host's drafts.mjs, which is plain JavaScript and so a valid handler file; it is
    // certified by its digest when the project is admitted, so nothing else can run under its name.
    cpSync(join(HERE, 'drafts.mjs'), join(projectDir, 'src', 'handlers.ts'));
    for (const [name, model, price] of [['small', models.small, small], ['large', models.large, large]]) {
      writeFileSync(join(projectDir, 'src', 'prices', `${name}.json`), JSON.stringify({ v: 1, provider: name, model, currency: 'usd', perMillionTokens: price, source, readOn }, null, 2) + '\n');
    }
    // Identity maps: the raw probability is the calibrated one, until `poly journal fit` writes a map fitted on your own mail.
    const { mapDigest } = await import(pathToFileURL(join(ROOT, 'packages', 'poly-runtime', 'dist', 'src', 'index.js')).href);
    for (const [file, decision, model] of [['triage-small', 'triage', models.small], ['triage-large', 'triage', models.large], ['kind-small', 'kind', models.small], ['kind-large', 'kind', models.large]]) {
      const body = { decision, version: 1, fittedFor: model, points: [[0, 0], [1000, 1000]] };
      writeFileSync(join(projectDir, 'src', 'maps', `${file}.json`), JSON.stringify({ ...body, digest: mapDigest(body) }, null, 2) + '\n');
    }

    // The keys, outside the project. Nothing printed holds key material.
    const admission = writeKey(keysDir, 'admission');
    const person = writeKey(keysDir, 'person');
    const ledger = writeKey(keysDir, 'ledger');
    const vaultKey = join(keysDir, 'vault.key');
    if (!existsSync(vaultKey)) writeFileSync(vaultKey, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
    const dirs = { vault: join(keysDir, 'vault'), mail: join(keysDir, 'mail') };
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

    const f = (p) => `file:${p}`;
    writeFileSync(join(projectDir, 'poly.json'), JSON.stringify({
      poly: '1',
      name: option(argv, '--name') ?? 'inbox',
      modules: ['src/*.poly'],
      handlers: ['src/handlers.ts'],
      keys: { admission: { id: 'inbox-admission', location: f(admission.priv) } },
      people: [{ name: 'owner', keyId: 'inbox-owner', publicKey: person.publicPem.trim() }],
      agents: [],
      credentials: { gmail_read: { store: 'dev-keychain' }, gmail_draft: { store: 'dev-keychain' } },
      run: { trust: { 'inbox-admission': f(admission.pub) }, ledger: { keyId: 'inbox-ledger', signer: f(ledger.priv) }, approvals: 'approvals' },
    }, null, 2) + '\n');
    // The host's config: names and paths, never a value that is secret. The three secrets are read from the environment.
    writeFileSync(join(projectDir, 'inbox.host.json'), JSON.stringify({
      v: 1,
      accounts,
      port,
      publicBase: `http://localhost:${port}`,
      vault: { key: f(vaultKey), dir: dirs.vault },
      mailDir: dirs.mail,
      personKey: { keyId: 'inbox-owner', file: person.priv },
      google: { clientIdEnv: 'INBOX_GOOGLE_CLIENT_ID', clientSecretEnv: 'INBOX_GOOGLE_CLIENT_SECRET' },
      model: { provider: 'anthropic', keyEnv: 'ANTHROPIC_API_KEY', samples, models },
      intervalSeconds: 300,
    }, null, 2) + '\n');

    io.out(`project ${projectDir}\nkeys    ${keysDir} (${admission.kept && person.kept && ledger.kept ? 'kept' : 'generated'}; no key is printed)\n`);
    io.out(`reservations at ${samples} asks, in usd (the cap is ${cap}):\n${rows.map((r) => `  ${r[0].padEnd(20)} ${(r[1] / 1e6).toFixed(4)}`).join('\n')}\n`);
    io.out(`next: anchor the keyrings, sign the policy, admit, link each account, then start the host (README.md, "Run it yourself").\n`);
    return 0;
  } catch (e) {
    if (e instanceof SetupError) { io.err(`setup: ${e.message}\n`); return 64; }
    throw e;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
