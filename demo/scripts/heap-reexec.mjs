// DF26: starts a script again with a larger heap and gives its exit code back. The launcher's own process is where the check of the
// Desk runs (5762 states), and Node's default heap (about 4.3 GB) is not enough for it. A process is started only by the scripts, the
// replay driver and the baseline (scripts/check-boundaries.mjs, DAC13), so the launcher calls this file and starts nothing itself.
import { spawn } from 'node:child_process';

/** Runs `script` with `args` in a new process that has the Node arguments `heapArgs`; POLY_DEMO_HEAP_REEXEC=1 says that it is the second. */
export function runAgainWithHeap(script, args, heapArgs, env = process.env) {
  const child = spawn(process.execPath, [...heapArgs, script, ...args], { stdio: 'inherit', env: { ...env, POLY_DEMO_HEAP_REEXEC: '1' } });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  return child;
}
