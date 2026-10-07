# polygraph, vendored

The files of `@cognitive-fab/polygraph` 8.4.0 that poly imports, and nothing else, copied unchanged. poly relies on the Poly stack conceptually, not physically: the engines are read here, and a change an engine needs is made in its own repository and then copied in again.

- Source: `C:/Users/jjdub/code/polygraph`, branch `e13-create-instance` (cut from `4949de4` on `m3-sendto`), commit `755ac09` ("package-lock.json: 8.4.0"), accepted by the owner on 2026-10-07, not published and not yet merged into polygraph's main. The branch carries E13 (8ad0bc2, 98caeb7): polyrun's `createInstance` intent, a detached instance created atomically with the parent's step, refused as a journaled `$uncreatable` row and never poisoned (`plan-m8.md`, "E13 in detail"). Under it, `m3-sendto`'s change of M3-2: `sendTo` and the K9 refusal (S87). Re-vendored from 4949de4: five files changed (`polyrun/src/check-effects.mjs`, `check-product.mjs`, `constants.mjs`, `index.mjs`, `kernel.mjs`); the closure is the same.
- Selection: the relative-import closure of the five entry points poly uses (`scripts/check.mjs`, `scripts/replay.mjs`, `polyrun/src/check-effects.mjs`, `polyrun/src/check-product.mjs`, `polyrun/src/index.mjs`), with `scripts/sam-tv.mjs`, which `replay.mjs` runs as a child process. `store-pg.mjs` requires `pg` only when a Postgres store is asked for; poly never asks.
- Each file is taken from the commit with `git show 755ac09:<path>`, read from the main checkout's object store, so neither that checkout's working tree nor its uncommitted work is touched or included.
- Licence: Apache-2.0, in `LICENSE`.
- `package.json` is written for poly (name, version, module type) and is not a copy.

`test/vendor.test.mjs` re-hashes every file against this table, and, where the source checkout exists, compares each file with the commit.

| File | sha256 |
|---|---|
| `LICENSE` | `71436dfeb742f9358c98a81da67d39d6c64a02964bfeeafdd399ed52c2583634` |
| `polyrun/src/check-effects.mjs` | `37ac2b21f7ade230529d679ce21569526e9701217fb7a8269cda8694259bd6ed` |
| `polyrun/src/check-product.mjs` | `1f780622c9f3597c020e7b2234217faf5e64a55651ec3dc278af8db2aca44f9b` |
| `polyrun/src/constants.mjs` | `a5a6c4cdb0a1fff6d022e726cae2ae6cd266be61baf69a368ce6bd744b870969` |
| `polyrun/src/duration.mjs` | `60a50c1dd2353ad6a96ef2bbf30ee93f751f604ffe509d505b178a00869757c4` |
| `polyrun/src/index.mjs` | `c6320fbe67ae30cb1ef68b099e31aa7286de1fcc7e8b82ba00422d9d5b9351ed` |
| `polyrun/src/kernel.mjs` | `429437e82f19ff0218d75796b11dd250fe1117b861281e425aae2f73b58c5cd9` |
| `polyrun/src/store-pg.mjs` | `e75f229537735415b710833d493d84cd9acff42a6f12403ca8ee96dd1f97fc07` |
| `polyrun/src/store.mjs` | `4b9ee537505d120ea3dc81328d93c4f978f6767c90a93527120a34a77be75613` |
| `polyrun/src/workers.mjs` | `742f2644eed061bc9531479a786a00ab708c52a8068e3ee6e9cdd17051179638` |
| `scripts/check.mjs` | `9792aad60f7c4608678b86fc0031a223c8f40f43b3de8ba8d7ac054ebf99fcdd` |
| `scripts/load-spec.mjs` | `6775799e3b810ba10f1aba7493ed97e217eb6bf28d3fc445033deeb3ec91b5e7` |
| `scripts/replay.mjs` | `193bda2a9c164f7578de58d9d0794208a9c0322919e605832798539194381923` |
| `scripts/sam-adapter.cjs` | `64645a3f4e64c709e359e4abfaf397a7de095df45d3b46cca880a09d9f7e8943` |
| `scripts/sam-tv.mjs` | `fc15a3ad28bdb474685f840d0493ea97216e0b67a2f16621fc1f213b03cb5452` |
| `scripts/sam-lib.mjs` | `127136dfce2c5a29a6e00e40d94d8116628f4435dfbdad58d18fddb23af38ce4` |
| `scripts/vendor/sam-pattern.cjs` | `11b7ee8680bd850f649bff4e5abef6498dc3e02e1f932a18366ee00618541973` |

## Written for poly

This file is poly's, not the engine's, and is pinned by hash all the same: an unpinned `package.json` could point the engine's name at any file (review D-F5). `test/vendor.test.mjs` checks each hash, and that no file in this folder is outside the two tables.

| File | sha256 | Origin |
|---|---|---|
| `package.json` | `8b7547c0a8332e6f3bac56a186eca008bdbe40d232dff8588ba3a0dd4e63bf0f` | written for poly |

## Conclusion

These files are polygraph at 755ac09, byte for byte. To take a newer polygraph, copy the same closure from the new commit and update this table in the same commit.
