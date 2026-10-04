// S161: polycheck is an optional peer, pinned like Polyaxion (S145) and not vendored. This script writes
// peers/polycheck/PROVENANCE.md: the files stage 5a runs, as they stand at the pinned commit of the sibling checkout,
// with their SHA-256. test/vendor.test.mjs checks the pins, and poly-runtime refuses a peer whose files differ.
//
//   node scripts/pin-polycheck.mjs <polycheck checkout> <commit>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNotExperimentTree } from './tree-guard.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
assertNotExperimentTree(ROOT);
const [source = 'C:/Users/jjdub/code/polycheck', commit = '678b120'] = process.argv.slice(2);
const FILES = ['src/check.mjs', 'data/regions.json', 'package.json', 'LICENSE'];
const git = (...a) => execFileSync('git', ['-C', source, ...a], { maxBuffer: 1 << 28 });
const full = git('rev-parse', commit).toString().trim();
const subject = git('log', '-1', '--format=%s', commit).toString().trim();
const rows = FILES.map((f) => `| \`${f}\` | \`${createHash('sha256').update(git('show', `${commit}:${f}`)).digest('hex')}\` |`);
const text = `# polycheck, an optional peer dependency

The region checker poly-check runs as stage 5a (PT8.4, S161): its model checker over accumulated effect flags, and its default regions. It is resolved from a sibling checkout, \`../polycheck\` beside the repository or the directory \`POLY_POLYCHECK_DIR\` names, and pinned here file by file, as Polyaxion is (S145). A checkout may hold CRLF where the commit holds LF, so a pin reads CRLF as LF (\`pinDigest\` in \`poly-runtime/src/peers.ts\`).

- Source: \`${source}\`, commit \`${commit}\` (\`${full}\`, "${subject.replace(/\|/g, '/')}").
- Selection: \`src/check.mjs\` (\`modelCheck\`, which imports nothing), \`data/regions.json\` (the default regions), \`package.json\` and \`LICENSE\`.
- Licence: Apache-2.0.
- Where the checkout is absent, or a file differs from its pin, stage 5a is listed as not run.

| File | sha256 |
|---|---|
${rows.join('\n')}

## Conclusion

These are the files of polycheck at ${commit}, by hash. To move the pin, run \`node scripts/pin-polycheck.mjs <checkout> <commit>\` and commit the new table with the change that needs it.
`;
mkdirSync(join(ROOT, 'peers', 'polycheck'), { recursive: true });
writeFileSync(join(ROOT, 'peers', 'polycheck', 'PROVENANCE.md'), text);
console.log(`${FILES.length} files pinned at ${commit}`);
