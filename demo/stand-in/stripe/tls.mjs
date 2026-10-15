// The throwaway authority of DB6 item 3. The stand-in answers for api.stripe.com and graph.facebook.com, so it needs a certificate
// for those names, and the build under test must trust whoever signed it without being edited: the authority is passed through the
// build's environment (NODE_EXTRA_CA_CERTS). It is made at the start of a run in a directory of the operating system's temporary
// space, valid for one day, and removed when the run ends. Neither the authority nor its key is ever written under the repository.
// openssl does the signing; the run refuses to start without it.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const NAMES = ['api.stripe.com', 'graph.facebook.com'];

export function createAuthority({ names = NAMES, dir } = {}) {
  const home = dir ?? mkdtempSync(join(tmpdir(), 'poly-demo-ca-'));
  const sh = (args) => execFileSync('openssl', args, { cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
  // A minimal configuration, so that the run does not depend on where this machine keeps openssl.cnf.
  writeFileSync(join(home, 'ca.cnf'), '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=poly demo throwaway CA\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  writeFileSync(join(home, 'leaf.cnf'), `[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=${names[0]}\n[ext]\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=${[...names.map((n) => `DNS:${n}`), 'IP:127.0.0.1'].join(',')}\n`);
  try {
    sh(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-config', 'ca.cnf', '-extensions', 'ext']);
    sh(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-config', 'leaf.cnf']);
    sh(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '1', '-extfile', 'leaf.cnf', '-extensions', 'ext']);
  } catch (e) {
    rmSync(home, { recursive: true, force: true });
    throw new Error(`the throwaway authority needs openssl on the path: ${(e.stderr ?? e.message).toString().trim().split('\n')[0]}`);
  }
  return {
    dir: home,
    caPath: join(home, 'ca.pem'),
    ca: readFileSync(join(home, 'ca.pem'), 'utf8'),
    cert: readFileSync(join(home, 'leaf.pem'), 'utf8'),
    key: readFileSync(join(home, 'leaf.key'), 'utf8'),
    remove: () => rmSync(home, { recursive: true, force: true }),
  };
}
