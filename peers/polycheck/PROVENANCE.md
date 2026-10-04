# polycheck, an optional peer dependency

The region checker poly-check runs as stage 5a (PT8.4, S161): its model checker over accumulated effect flags, and its default regions. It is resolved from a sibling checkout, `../polycheck` beside the repository or the directory `POLY_POLYCHECK_DIR` names, and pinned here file by file, as Polyaxion is (S145). A checkout may hold CRLF where the commit holds LF, so a pin reads CRLF as LF (`pinDigest` in `poly-runtime/src/peers.ts`).

- Source: `C:/Users/jjdub/code/polycheck`, commit `678b120` (`678b120e7e286a6bee2f0b6cfea5c09104881bdd`, "survey: stage 2 — normalize the harvested candidates into one polycheck-readable directory per repository").
- Selection: `src/check.mjs` (`modelCheck`, which imports nothing), `data/regions.json` (the default regions), `package.json` and `LICENSE`.
- Licence: Apache-2.0.
- Where the checkout is absent, or a file differs from its pin, stage 5a is listed as not run.

| File | sha256 |
|---|---|
| `src/check.mjs` | `dcd97a872321626de15b6b788e8babf5b95d3d903979a258bd302a9c66adbef0` |
| `data/regions.json` | `6e941a6d4b05e9d8e1309ae27285bbf91098348e834bb1895aae68248c1cd657` |
| `package.json` | `fb67f0a406cc3c19f62ae17f9166085edf82b3d4e6876e66ec15f5d245b5232a` |
| `LICENSE` | `aa42a9c262d65260f700d4c08312657f8a9cc3356e9eb08d5916059cbb5f6595` |

## Conclusion

These are the files of polycheck at 678b120, by hash. To move the pin, run `node scripts/pin-polycheck.mjs <checkout> <commit>` and commit the new table with the change that needs it.
