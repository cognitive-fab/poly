// Assembles the replay directory of one committed tree (docs/demo/step10-replay.md): the scaffold of the arm (its .harness toolchain), the tree laid over it, an offline npm install, and a check that the tree files are byte for byte the committed ones. Usage: node assemble.mjs ts|poly pilot-2|pilot-3|kept
import { cpSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeWorkspace, treeDigest } from 'file:///C:/Users/jjdub/code/poly-demo/demo/baseline/arms.mjs';
const [arm, run] = process.argv.slice(2);
const ROOT = 'C:/Users/jjdub/code/poly-demo';
const dest = join(process.env.USERPROFILE, '.poly-demo', 'replay', `${arm}-${run}`);
rmSync(dest, { recursive: true, force: true });
makeWorkspace(arm, dest, ROOT);
const tree = join(ROOT, 'demo/baseline/runs', `${arm}-${run}`, 'tree');
cpSync(tree, dest, { recursive: true, force: true });
const env = { ...process.env, npm_config_offline: 'true', npm_config_registry: 'http://127.0.0.1:9/', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
delete env.NODE_TEST_CONTEXT;
const r = spawnSync('npm install --no-package-lock', { cwd: dest, env, shell: true, encoding: 'utf8' });
console.log('npm install exit', r.status, (r.stdout + r.stderr).trim().split('\n').slice(-2).join(' | '));
const rec = JSON.parse(readFileSync(join(ROOT, 'demo/baseline/runs', `${arm}-${run}`, 'RECORD.json'), 'utf8'));
const now = treeDigest(dest, { skip: ['node_modules', '.git', '.harness'] });
console.log(dest, '\nrecorded', rec.treeDigest, '\nnow     ', now, now === rec.treeDigest ? 'IDENTICAL' : 'DIFFERENT');
