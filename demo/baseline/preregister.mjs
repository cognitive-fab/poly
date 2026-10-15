#!/usr/bin/env node
// Writes the pre-registration record (demo/baseline/PREREGISTRATION.json) for the owner to read, and prints the commit command.
// It runs nothing against a model, costs nothing, and does not commit: the owner approves PROMPT.md first (DB2), reads the record, and
// makes the pre-registration commit in the owner's own terminal. If the prompt, the agent's version, the pilots or a cap are
// changed afterwards, the record is written again and the commit is a new one, before any run.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './arms.mjs';
import { RECORD, buildRecord } from './procedure.mjs';

const pilot = (name) => { const i = process.argv.indexOf(`--pilots-${name}`); return i < 0 ? 1 : Number(process.argv[i + 1]); };
const record = buildRecord({ pilots: { ts: pilot('ts'), poly: pilot('poly') } });
writeFileSync(join(ROOT, RECORD), `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify(record, (k, v) => (k === 'allowedTools' ? '(see arms.mjs)' : v), 2));
console.log('\nWritten to demo/baseline/PREREGISTRATION.json. Read PROMPT.md and this record, then commit both:\n');
console.log('  git add demo/baseline/PROMPT.md demo/baseline/PREREGISTRATION.json');
console.log(`  git commit -m "Baseline pre-registration: prompt ${record.prompt.sha256.slice(0, 19)}, ${record.model}, Claude Code ${record.claudeCode.version}, ${record.pilots.ts}+${record.pilots.poly} pilot(s)"`);
