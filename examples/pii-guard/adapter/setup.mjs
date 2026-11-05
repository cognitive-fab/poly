// Run by a person, never by a test: node examples/pii-guard/adapter/setup.mjs [--model]
// Creates the shared venv of the edgepii adapter outside the repository (docs/examples/pii-guard.md, Q7) and installs
// requirements.txt with every hash required (Q8). With --model it also installs requirements-model.txt and fetches the
// multi-open model's weights at the pinned revision into the Hugging Face cache, whose place it prints.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultPython } from '../host/edgepii.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const model = process.argv.includes('--model');

const run = (cmd, args) => {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

/** Python 3.11 or later: py -3.12, py -3.11, then python3 (the spec's order). */
function findPython() {
  const candidates = [['py', ['-3.12']], ['py', ['-3.11']], ['python3', []]];
  for (const [cmd, pre] of candidates) {
    const r = spawnSync(cmd, [...pre, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' });
    if (r.status !== 0) continue;
    const [major, minor] = r.stdout.trim().split('.').map(Number);
    if (major === 3 && minor >= 11) return [cmd, pre];
  }
  console.error('no Python 3.11 or later found (tried py -3.12, py -3.11, python3)');
  process.exit(1);
}

const python = defaultPython();
// The venv is the directory two levels above its python (Scripts\python.exe, bin/python).
const venv = dirname(dirname(python));
if (!existsSync(python)) {
  const [cmd, pre] = findPython();
  mkdirSync(dirname(venv), { recursive: true });
  run(cmd, [...pre, '-m', 'venv', venv]);
}
run(python, ['-m', 'pip', 'install', '--require-hashes', '--no-deps', '-r', join(HERE, 'requirements.txt')]);
if (model) {
  // The model lane's hashed closure (torch and its dependencies) is not packaged yet (A2): only the rules lane installs.
  if (!existsSync(join(HERE, 'requirements-model.txt'))) {
    console.error('the multi-open lane is not packaged yet: examples/pii-guard/adapter/requirements-model.txt does not exist (docs/examples/pii-guard.md, A2)');
    process.exit(1);
  }
  run(python, ['-m', 'pip', 'install', '--require-hashes', '--no-deps', '-r', join(HERE, 'requirements-model.txt')]);
  const pin = JSON.parse(readFileSync(join(HERE, 'PIN.json'), 'utf8')).presets['multi-open'];
  run(python, ['-c', `from huggingface_hub import snapshot_download; print(snapshot_download(${JSON.stringify(pin.repo)}, revision=${JSON.stringify(pin.revision)}))`]);
}
console.log(`edgepii 0.3.1 is installed at ${python}`);
