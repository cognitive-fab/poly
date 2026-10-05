// PF9.2: writes each command's input and output schema from the registry to schemas/<command>.input.json and
// schemas/<command>.output.json, and removes any schema of a command the registry no longer has.
// test/agent-registry.test.mjs requires the files to equal the registry.
//
// Usage: node scripts/publish-schemas.mjs
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentCommands } from '@poly/agent';
import { assertNotExperimentTree } from './tree-guard.mjs';

const dir = join(fileURLToPath(import.meta.url), '..', '..', 'schemas');
assertNotExperimentTree(join(dir, '..'));
mkdirSync(dir, { recursive: true });
const want = new Map(agentCommands().flatMap((c) => [[`${c.name}.input.json`, c.input], [`${c.name}.output.json`, c.output]]));
for (const f of readdirSync(dir)) if (f.endsWith('.json') && !want.has(f)) rmSync(join(dir, f));
for (const [f, s] of want) writeFileSync(join(dir, f), JSON.stringify(s, null, 2) + '\n');
console.log(`${want.size} schemas in ${dir}`);
