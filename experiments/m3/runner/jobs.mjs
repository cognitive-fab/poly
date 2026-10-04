// The processes of one run, held in one Windows job object (37beede): a deviation from the frozen runner, applied
// from block 40. Blocks 1 to 39 ran without it: arm 2's commands that the CLI moved to the background, and the
// processes under claude.exe when a cap killed it, outlived their runs, loaded the machine into later blocks, and
// twice kept the runner from deleting the workspace.
//
// Each turn's CLI is started by launch.mjs, which waits until this run's job holds it before it starts claude.exe, so
// every process the CLI starts is in the job from its first instant, whatever becomes of its parent (Git Bash's
// shells have parents that exit at once). At the end of the run, and only then, the processes still in the job are
// listed as leftovers and ended. Nothing is ended between turns, so what an arm sees within a run is unchanged.
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HOST = fileURLToPath(new URL('jobhost.ps1', import.meta.url));

/** A job for one run; on a platform without Windows jobs, a stand-in that tracks nothing. */
export async function openJob({ host: script = HOST } = {}) {
  if (process.platform !== 'win32') return { windows: false, assign: async () => true, leftovers: async () => [], end: async () => [], close: () => {} };
  const host = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = createInterface({ input: host.stdout });
  const queue = [];
  let gone = null;
  // A host that fails or exits answers nothing more: every question waiting on it, and any later one, fails at once.
  const fail = (why) => { gone ??= why; while (queue.length) queue.shift()(null); };
  host.on('error', (e) => fail(`the job host could not start: ${e.message}`));
  host.on('exit', (code) => fail(`the job host exited (${code})`));
  // A line that is not JSON is the host failing in its own words (a missing script, a compile error): it is an end.
  lines.on('line', (l) => { try { JSON.parse(l); } catch { fail(`the job host said: ${l.slice(0, 200)}`); host.kill(); return; } queue.shift()?.(l); });
  const ask = (cmd) => new Promise((resolve, reject) => {
    if (gone) { reject(new Error(gone)); return; }
    queue.push((l) => (l === null ? reject(new Error(gone)) : resolve(JSON.parse(l))));
    host.stdin.write(cmd + '\n');
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { fail('the job host did not start within 60 s'); host.kill(); }, 60_000);
    queue.push((l) => { clearTimeout(timer); l === null ? reject(new Error(gone)) : resolve(JSON.parse(l)); });
  });
  if (!ready.ready) throw new Error('the job host could not create a job object');
  let ending = null;
  return {
    windows: true,
    /** Puts a process, and so everything it starts from then on, in the job. */
    assign: async (pid) => (await ask(`assign ${pid}`)).ok === true,
    /** The processes still in the job: { pid, command }. */
    leftovers: async () => (await ask('list')).processes ?? [],
    /**
     * Lists the processes still in the job, then ends them all, once; a later call waits for the same ending. If the
     * job cannot be ended, each listed process is ended with its tree instead. Returns the list.
     */
    end: () => (ending ??= (async () => {
      let list;
      try { list = (await ask('list')).processes ?? []; } catch (e) { return [{ pid: null, command: `the job could not be listed: ${e.message}` }]; }
      const killed = await ask('kill').then((r) => r.killed === true, () => false);
      if (!killed) for (const p of list) spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return list;
    })()),
    close: () => { try { host.stdin.write('exit\n'); } catch { /* the host has exited */ } },
  };
}
