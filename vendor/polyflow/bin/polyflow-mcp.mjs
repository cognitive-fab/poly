#!/usr/bin/env node
// polyflow as an MCP server. Works with any MCP-capable agent — OpenWorker,
// Claude Code, Cursor — with no changes to that agent's core.
//
//   POLYFLOW_WORKFLOWS  workflow library directory   (default ./workflows)
//   POLYFLOW_DB         sqlite path                  (default .polyflow/polyflow.sqlite)
//   POLYFLOW_AGENT      agent-class area             (default 'default')
//   POLYFLOW_INSTANCE   instance area (workspace)    (default cwd basename)
//   POLYFLOW_POLYRUN    polygraph checkout           (default ../polygraph)

import { basename } from 'node:path';
import { Polyflow } from '../src/daemon.mjs';
import { makeTools } from '../src/tools.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serve } from '../src/mcp.mjs';

const pf = new Polyflow({
  workflowsDir: process.env.POLYFLOW_WORKFLOWS ?? 'workflows',
  dbPath: process.env.POLYFLOW_DB ?? '.polyflow/polyflow.sqlite',
  agent: process.env.POLYFLOW_AGENT ?? 'default',
  instance: process.env.POLYFLOW_INSTANCE ?? basename(process.cwd()),
});

await pf.start();

for (const [name, cert] of pf.certificates) {
  const head = cert.ok ? 'admitted' : 'REFUSED';
  console.error(`[polyflow] ${head}: ${name} — ${cert.report.split('\n')[0]}`);
  if (!cert.ok) for (const v of cert.violations) console.error(`[polyflow]   ${v.name ?? v}`);
}

// Read, not repeated: the installer pins what package.json says, so a
// hardcoded string here means the server announces one version while the host
// was configured for another - misleading in exactly the moment someone is
// diagnosing a version mismatch.
const VERSION = JSON.parse(readFileSync(
  join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'package.json'), 'utf-8',
)).version;

serve({ name: 'polyflow', version: VERSION, tools: makeTools(pf) });

const bye = async () => { await pf.close(); process.exit(0); };
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
