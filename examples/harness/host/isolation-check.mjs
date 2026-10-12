// plan-e3.md E3.9 gate item (owner, 2026-10-12), assumption live-run-isolation: the check made from INSIDE the environment the
// live run executes in. The run is refused until this check passes there. It is a plain node program with no dependency, so it
// can be copied into the container (or distro) and run as the user the agent's commands run as:
//
//   node isolation-check.mjs --reachable <host:port> ... --unreachable <host:port> ...
//
// It proves four things, each as a finding:
//   1. the probe works at all (a positive control: it connects to a listener of its own on the loopback), so an "unreachable"
//      cannot come from a broken probe (no silent clean);
//   2. every address in --reachable can be connected to (the model API's route: the egress proxy, or the API host itself);
//   3. every address in --unreachable cannot (a list of public hosts, the package registries, a raw public IP, the cloud
//      metadata address and the host's gateway are always added);
//   4. the environment holds no credential-looking variable, and no mount of the Windows host (/mnt/c, drvfs, 9p, cifs).
// The exit status is 0 only when every finding passes. A probe that cannot run is a failed finding, never a pass.
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Addresses that must never be reachable from the run, whatever the route to the model API is. */
export const ALWAYS_UNREACHABLE = Object.freeze([
  '1.1.1.1:443', '8.8.8.8:53', 'example.com:443', 'github.com:443', 'registry.npmjs.org:443', 'proxy.golang.org:443', 'pypi.org:443',
  '169.254.169.254:80', // the cloud metadata address
]);

const CREDENTIAL_NAME = /(key|token|secret|passw|credential|auth|cookie|session|bearer|private|signature|anthropic|openai|aws_|azure_|github|gitlab)/i;
const HOST_MOUNT = /(^|\s)(\/mnt\/[a-z]|\/run\/desktop\/mnt\/host|\/host_mnt)(\s|\/)|\s(drvfs|9p|cifs|smb3|virtiofs)\s/i;

/** @returns {Promise<'open'|'refused'|'timeout'|'error:...'>} one TCP connection attempt. */
export function probe(host, port, timeoutMs = 3000) {
  return new Promise((done) => {
    const s = net.connect({ host, port });
    const finish = (r) => { s.destroy(); done(r); };
    s.setTimeout(timeoutMs, () => finish('timeout'));
    s.once('connect', () => finish('open'));
    s.once('error', (e) => finish(e.code === 'ECONNREFUSED' ? 'refused' : `error:${e.code ?? e.message}`));
  });
}

/** The names of variables that look like credentials and hold a value. */
export const credentialsIn = (env) => Object.keys(env).filter((k) => CREDENTIAL_NAME.test(k) && String(env[k]) !== '').sort();

/** The lines of a /proc/mounts text that reach the Windows host. */
export const hostMountsIn = (text) => text.split('\n').filter((l) => HOST_MOUNT.test(` ${l} `));

const split = (a) => {
  const i = a.lastIndexOf(':');
  return { host: a.slice(0, i), port: Number(a.slice(i + 1)), text: a };
};

/**
 * @param {{ reachable?: string[], unreachable?: string[], env?: object, mounts?: string | null, timeoutMs?: number, always?: string[] }} o   (`always` is for tests, which must not touch the network)
 * @returns {Promise<{ ok: boolean, findings: { check: string, ok: boolean, detail: string }[] }>}
 */
export async function checkIsolation({ reachable = [], unreachable = [], env = process.env, mounts = null, timeoutMs = 3000, always = ALWAYS_UNREACHABLE } = {}) {
  const findings = [];
  const add = (check, ok, detail) => findings.push({ check, ok, detail });

  // 1. the control
  const server = net.createServer((c) => c.end());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const control = await probe('127.0.0.1', server.address().port, timeoutMs);
  server.close();
  add('control: the probe connects to a listener of its own', control === 'open', control);

  // 2 and 3
  for (const a of reachable.map(split)) {
    const r = await probe(a.host, a.port, timeoutMs);
    add(`reachable: ${a.text}`, r === 'open', r);
  }
  for (const a of [...new Set([...always, ...unreachable])].map(split)) {
    const r = await probe(a.host, a.port, timeoutMs);
    // a connection that opened is the failure; a refusal, a timeout or a resolution error is a barrier. Only with a working control.
    add(`unreachable: ${a.text}`, control === 'open' && r !== 'open', r);
  }

  // 4
  const creds = credentialsIn(env);
  add('no credential-looking variable in the environment', creds.length === 0, creds.length ? creds.join(', ') : 'none');
  let text = mounts;
  if (text === null) {
    try {
      text = readFileSync('/proc/mounts', 'utf8');
    } catch {
      text = null;
    }
  }
  if (text === null) add('no mount of the Windows host', false, '/proc/mounts could not be read (run this inside the Linux environment)');
  else {
    const bad = hostMountsIn(text);
    add('no mount of the Windows host', bad.length === 0, bad.length ? bad.join(' | ') : 'none');
  }
  return { ok: findings.every((f) => f.ok), findings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const take = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
  const r = await checkIsolation({ reachable: take('--reachable'), unreachable: take('--unreachable') });
  for (const f of r.findings) console.log(`${f.ok ? 'ok     ' : 'FAILED '} ${f.check} (${f.detail})`);
  console.log(r.ok ? 'isolation check passed' : 'isolation check FAILED: the live run does not start');
  process.exit(r.ok ? 0 : 1);
}
