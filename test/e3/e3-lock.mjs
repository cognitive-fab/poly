// plan-e3.md, owner's ruling of 2026-10-12: two admissions or two checks of the harness must never overlap. An admission of the
// module is the heaviest thing the E3 tests do (a check of every machine, up to 2.8 GB when the pay-gate had two numbers of
// 0..12), and `node --test` runs files at once. The batch script runs them one at a time (package.json: test:e3), and this lock
// holds the same line when a file is run on its own while another is running, or by a plain `node --test test/e3/e3-*.test.mjs`.
//
// One lock file for the repository's checkout. A process that finds it waits; a lock whose process is gone is taken over.
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ROOT } from '../helpers.mjs';

const LOCK = join(ROOT, '.poly', 'e3-heavy.lock');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

let held = 0;

/** Runs `fn` while holding the lock; a nested call in the same process is let through. */
export async function heavy(fn) {
  if (held > 0) return fn();
  mkdirSync(dirname(LOCK), { recursive: true });
  const deadline = Date.now() + 4 * 3600_000;
  for (;;) {
    try {
      const fd = openSync(LOCK, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner = NaN;
      try {
        owner = Number(readFileSync(LOCK, 'utf8'));
      } catch {
        continue;
      }
      if (!Number.isInteger(owner) || owner === process.pid || !alive(owner)) {
        try {
          unlinkSync(LOCK);
        } catch {
          /* another process took it over first */
        }
        continue;
      }
      if (Date.now() > deadline) throw new Error(`the heavy-work lock is held by process ${owner} for over four hours`);
      await sleep(2000);
    }
  }
  held += 1;
  try {
    return await fn();
  } finally {
    held -= 1;
    try {
      unlinkSync(LOCK);
    } catch {
      /* already gone */
    }
  }
}
