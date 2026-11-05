// Run by a person, never by a test: node examples/pii-guard/host/record.mjs
// Writes recorded/answers.json from the live adapter with the rules preset (docs/examples/pii-guard.md, "Recorded
// answers"): for each sample, one locate with SCAN_TYPES and one redact per target's types. So the recorded adapter the
// tests use answers what the real one answered, and the live test compares the two (PG12).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultPython, loadPin, startAdapter } from './edgepii.mjs';
import { SCAN_TYPES, redactTypes } from './providers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = resolve(HERE, '..');

const pin = loadPin(join(EXAMPLE, 'adapter', 'PIN.json'));
const client = await startAdapter({ python: defaultPython(), pin, preset: 'rules' });
try {
  const files = readdirSync(join(EXAMPLE, 'samples')).filter((f) => f.endsWith('.txt')).sort();
  const documents = [];
  for (const file of files) {
    const text = readFileSync(join(EXAMPLE, 'samples', file), 'utf8');
    const locate = await client.locate(text, [...SCAN_TYPES]);
    const redact = [];
    for (const target of ['Mail', 'Model']) {
      const types = redactTypes(target);
      redact.push({ types, answer: await client.redact(text, types) });
    }
    documents.push({ file, locate, redact });
  }
  const out = join(EXAMPLE, 'recorded', 'answers.json');
  writeFileSync(out, `${JSON.stringify({ hello: client.hello, documents }, null, 2)}\n`);
  console.log(`wrote ${out}: ${documents.length} samples`);
} finally {
  client.close();
}
