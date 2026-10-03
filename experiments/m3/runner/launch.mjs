// Starts one turn's CLI once the runner has put this process in the run's job (jobs.mjs, 37beede): it waits for a
// line on stdin, then starts the command it was given with the same stdout and stderr, and exits with its code.
// Every process the CLI starts is then in the job from its first instant.
//
// Usage: node launch.mjs <command> [args...]
import { spawn } from 'node:child_process';

const [cmd, ...args] = process.argv.slice(2);
process.stdin.once('data', () => {
  process.stdin.pause();
  const child = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('error', (e) => { process.stderr.write(`launch: ${e.message}\n`); process.exit(127); });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 143 : 1)));
});
