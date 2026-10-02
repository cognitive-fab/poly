// S145: Polyaxion, polyman and polysec-core are an optional peer dependency, not vendored. This script writes
// peers/polyaxion/PROVENANCE.md: every file poly runs of the three packages, as the file stands at the pinned commit
// of the sibling checkout, with its SHA-256. test/vendor.test.mjs checks the pins as it checks a vendored engine, and
// poly-runtime refuses a peer whose files differ. Run it only to move the pin to another commit.
//
//   node scripts/pin-peers.mjs <polyaxion checkout> <commit>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [source = 'C:/Users/jjdub/code/polyaxion', commit = 'c37c60e'] = process.argv.slice(2);
const PATHS = [
  'packages/polyaxion/src', 'packages/polyaxion/package.json', 'packages/polyaxion/LICENSE',
  'packages/polysec-core/src', 'packages/polysec-core/labels', 'packages/polysec-core/package.json', 'packages/polysec-core/LICENSE',
  'packages/polysec/polyman/src', 'packages/polysec/polyman/vendor', 'packages/polysec/polyman/package.json', 'packages/polysec/polyman/LICENSE',
];
const git = (...a) => execFileSync('git', ['-C', source, ...a], { maxBuffer: 1 << 28 });
const full = git('rev-parse', commit).toString().trim();
const subject = git('log', '-1', '--format=%s', commit).toString().trim();
const files = git('ls-tree', '-r', '--name-only', commit, '--', ...PATHS).toString().split('\n').filter(Boolean).sort();
const rows = files.map((f) => `| \`${f}\` | \`${createHash('sha256').update(git('show', `${commit}:${f}`)).digest('hex')}\` |`);
const text = `# Polyaxion, polyman and polysec-core, an optional peer dependency

The gate engine poly-runtime hosts in process (PT9, S146), and the admission engine poly-check runs over policies (PT8.4). The three packages are BUSL-1.1, so they are **not vendored** into this repository (S145): they are resolved from a sibling checkout, \`../polyaxion\` beside the repository or the directory \`POLY_POLYAXION_DIR\` names. Each file poly runs is pinned here by the SHA-256 of its bytes at the pinned commit, exactly as a vendored engine is pinned. A checkout may hold CRLF where the commit holds LF, so a pin reads CRLF as LF (\`pinDigest\` in \`poly-runtime/src/peers.ts\`).

- Source: \`${source}\`, commit \`${commit}\` (\`${full}\`, "${subject.replace(/\|/g, '/')}").
- Selection: the runtime files of the three packages: \`src\`, \`package.json\` and \`LICENSE\` of each, with polysec-core's \`labels\` and polyman's \`vendor\` (its copy of sam-pattern). polyman is loaded from its TypeScript source, as Polyaxion's own resolver prefers in a checkout.
- Licence: BUSL-1.1, in each \`LICENSE\`. poly's own licence is the owner's open decision (S145).
- Not pinned: polysec-core's \`harden\` imports \`@cognitive-fab/polygraph\` from the checkout's own install (8.3.0). It runs at policy admission only, never on the step path.
- Where the checkout is absent, or a file differs from its pin, every check that needs the engine is listed as not run, and \`load\` refuses a build with policies (no gate is assumed).

\`test/vendor.test.mjs\` re-hashes every file against this table, and compares each with the commit.

| File | sha256 |
|---|---|
${rows.join('\n')}

## Conclusion

These are the files of the three packages at ${commit}, by hash. To move the pin, run \`node scripts/pin-peers.mjs <checkout> <commit>\` and commit the new table with the change that needs it.
`;
mkdirSync(join(ROOT, 'peers', 'polyaxion'), { recursive: true });
writeFileSync(join(ROOT, 'peers', 'polyaxion', 'PROVENANCE.md'), text);
console.log(`${files.length} files pinned at ${commit}`);
