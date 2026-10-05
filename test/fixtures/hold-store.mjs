// A test's stand-in for a running `poly run`: it loads the project's runtime, so it owns the store, says so on stdout,
// and holds the store until it is killed or its stdin closes.
//
// Usage: node hold-store.mjs <project dir>
import { loadRun } from '@poly/runtime';

const run = await loadRun(process.argv[2]);
process.stdout.write(`ready ${process.pid}\n`);
process.stdin.resume();
process.stdin.on('end', async () => { await run.close(); process.exit(0); });
