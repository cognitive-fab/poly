// A test's launcher for the workflow tools over poly-runtime (M8a step 2): it loads an admitted build with a store file
// and serves the six tools on stdio, as `poly run --mcp` will once its configuration in poly.json is ruled. The trust
// key is a public key file the test generated; nothing is read from the environment.
//
// Usage: node workflow-server.mjs <build> <certificate> <keyId> <public key file> <store file>
import { readFileSync } from 'node:fs';
import { load } from '@poly/runtime';
import { serveWorkflows } from '@poly/agent';

const [build, certificate, keyId, trustFile, store] = process.argv.slice(2);
const rt = await load(build, { certificate, trust: { [keyId]: readFileSync(trustFile, 'utf8') }, store: { sqlite: store } });
try {
  await serveWorkflows(rt);
} finally {
  await rt.close();
}
