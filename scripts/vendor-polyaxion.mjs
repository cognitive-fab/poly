// Polyaxion, polyman and polysec-core, vendored at their pin (the owner's instruction of 2026-10-06, replacing S145's
// sibling checkout). This script copies every file poly runs of the three packages, unchanged, out of the
// repository's history at the pinned commit (`git show <commit>:<file>`), so neither the checkout nor its
// uncommitted edits are read or touched, into vendor/polyaxion, and writes vendor/polyaxion/PROVENANCE.md with the
// SHA-256 of each. test/vendor.test.mjs checks the hashes and compares each file with the commit. Run it only to move
// the pin to another commit.
//
//   node scripts/vendor-polyaxion.mjs <polyaxion repository> <commit>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNotExperimentTree } from './tree-guard.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
assertNotExperimentTree(ROOT);
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
const dest = join(ROOT, 'vendor', 'polyaxion');
rmSync(join(dest, 'packages'), { recursive: true, force: true });
const rows = files.map((f) => {
  const bytes = git('show', `${commit}:${f}`);
  mkdirSync(dirname(join(dest, f)), { recursive: true });
  writeFileSync(join(dest, f), bytes);
  return `| \`${f}\` | \`${createHash('sha256').update(bytes).digest('hex')}\` |`;
});
const text = `# Polyaxion, polyman and polysec-core, vendored

The gate engine poly-runtime hosts in process (PT9, S146), and the admission engine poly-check runs over policies (PT8.4). Until 2026-10-06 they were an optional peer resolved from a sibling checkout (S145); by the owner's instruction that day they are vendored here, the files poly runs copied unchanged out of the repository's history at the pinned commit, so a checkout that moves on, or holds uncommitted edits, no longer changes what poly runs.

- Source: \`${source}\`, commit \`${commit}\` (\`${full}\`, "${subject.replace(/\|/g, '/')}").
- Taken with \`git show ${commit}:<file>\` for each file (\`scripts/vendor-polyaxion.mjs\`): neither the checkout nor its working tree was read.
- Selection: the runtime files of the three packages: \`src\`, \`package.json\` and \`LICENSE\` of each, with polysec-core's \`labels\` and polyman's \`vendor\` (its copy of sam-pattern). polyman is loaded from its TypeScript source, as Polyaxion's own resolver prefers in a checkout.
- Licence: BUSL-1.1, in each \`LICENSE\`, unchanged. Vendoring BUSL-1.1 files is the owner's decision of 2026-10-06; poly's own licence remains the owner's open decision (S145).
- Not pinned: polysec-core's \`harden\` imports \`@cognitive-fab/polygraph\`, which now resolves to poly's vendored polygraph (\`vendor/polygraph\`, 8.3.2) where the checkout's own install held 8.3.0. It runs at policy admission only, never on the step path.
- Polyaxion loads polysec-core package first (\`runtime/deps.mjs\`). The engine is refused unless the first \`node_modules/@cognitive-fab/polysec-core\` Node finds from it is the pinned \`packages/polysec-core\` itself, or there is none (review A2).

\`test/vendor.test.mjs\` re-hashes every file against this table, checks that no file in this folder is outside it, and compares each with the commit where the source repository exists.

| File | sha256 |
|---|---|
${rows.join('\n')}

## Conclusion

These are the files of the three packages at ${commit}, byte for byte. To move the pin, run \`node scripts/vendor-polyaxion.mjs <repository> <commit>\` and commit the new copy and table with the change that needs it.
`;
writeFileSync(join(dest, 'PROVENANCE.md'), text);
console.log(`${files.length} files vendored at ${commit}`);
