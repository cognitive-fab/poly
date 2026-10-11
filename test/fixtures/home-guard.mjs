// No test writes under the owner's real home (ruled 2026-10-11, after a test ran `poly anchor keyrings` on a build that
// ignored POLY_ANCHORS_CONFIG and wrote ~/.poly/anchors.json). Preloaded into every test process: `npm test` passes it to
// `node --test`, which hands it to each test file's process, and runtime-helpers and the test-anchors preload import it
// for a process started another way. It records what is under the owner's `.poly` folder when the process starts and
// compares at exit; a difference sets a failing exit code and says which file. POLY_HOME_GUARD_DIR names another folder to
// watch, for the guard's own test; no other process should set it.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';

const watched = process.env.POLY_HOME_GUARD_DIR || join(userInfo().homedir, '.poly');

/** Every file under a folder with its size and modification time, one per line, sorted; "absent" for no folder. */
function snapshot(dir) {
  if (!existsSync(dir)) return new Map([['', 'absent']]);
  const out = new Map();
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { const s = statSync(p); out.set(p, `${s.size}:${s.mtimeMs}`); }
    }
  };
  walk(dir);
  return out;
}

const guardKey = Symbol.for('poly.home-guard');
if (!globalThis[guardKey]) {
  globalThis[guardKey] = true;
  const before = snapshot(watched);
  process.on('exit', () => {
    const after = snapshot(watched);
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k));
    if (!changed.length) return;
    process.stderr.write(`HOME GUARD: this process wrote under ${watched}: ${changed.map((c) => c || '(the folder)').join(', ')}. A test must never touch the owner's real home (ruled 2026-10-11).\n`);
    process.exitCode = 1;
  });
}
