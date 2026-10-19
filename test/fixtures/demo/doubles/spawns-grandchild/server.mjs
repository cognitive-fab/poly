// A double that starts a parent process which spawns a child process.
// Parent writes its pid to pidFile1, child writes its pid to pidFile2.
// Tests process group cleanup on exit.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const childPath = fileURLToPath(new URL('./child.mjs', import.meta.url));
const pidFile1 = process.argv[2];
const pidFile2 = process.argv[3];

// Write parent pid
writeFileSync(pidFile1, String(process.pid));

// Spawn child process with stdio ignored so it runs independent of parent
spawn(process.execPath, [childPath, pidFile2], {
  stdio: 'ignore',
  detached: false,
});

// Keep parent process alive
setInterval(() => {}, 1 << 30);
