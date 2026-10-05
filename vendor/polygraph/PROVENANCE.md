# polygraph, vendored

The files of `@cognitive-fab/polygraph` 8.3.2 that poly imports, and nothing else, copied unchanged. poly relies on the Poly stack conceptually, not physically: the engines are read here, and a change an engine needs is made in its own repository and then copied in again.

- Source: `C:/Users/jjdub/code/polygraph`, branch `m3-sendto` (cut from `583b82c`), commit `4949de4` ("polyrun: messages between instances, and the K9 refusal"), not published and not yet merged into polygraph's main (S87). The branch carries the polyrun change of M3-2: `sendTo` messages between instances and the K9 refusal.
- Selection: the relative-import closure of the five entry points poly uses (`scripts/check.mjs`, `scripts/replay.mjs`, `polyrun/src/check-effects.mjs`, `polyrun/src/check-product.mjs`, `polyrun/src/index.mjs`), with `scripts/sam-tv.mjs`, which `replay.mjs` runs as a child process. `store-pg.mjs` requires `pg` only when a Postgres store is asked for; poly never asks.
- Each file is taken from the commit with `git show 4949de4:<path>`, so uncommitted work in that checkout is not included.
- Licence: Apache-2.0, in `LICENSE`.
- `package.json` is written for poly (name, version, module type) and is not a copy.

`test/vendor.test.mjs` re-hashes every file against this table, and, where the source checkout exists, compares each file with the commit.

| File | sha256 |
|---|---|
| `LICENSE` | `71436dfeb742f9358c98a81da67d39d6c64a02964bfeeafdd399ed52c2583634` |
| `polyrun/src/check-effects.mjs` | `ebe42031d565284af684c34a4a549256149f6d774aec1416eb5c1b2e55b7dfa8` |
| `polyrun/src/check-product.mjs` | `1352acea9bf5691c4bb94cebe8a881623d225086a3c8e052803bea355ab10e8e` |
| `polyrun/src/constants.mjs` | `d28bbd5ace3438d39663245f53b7d58764c237a353cc9ef0cea71f419393325b` |
| `polyrun/src/duration.mjs` | `60a50c1dd2353ad6a96ef2bbf30ee93f751f604ffe509d505b178a00869757c4` |
| `polyrun/src/index.mjs` | `ca610be9d4dc2ee619eda90bb0a5ba01474e3f977bdd29da68b5baa8275473cd` |
| `polyrun/src/kernel.mjs` | `dc92916249a7e72616b29ca648bd5a78cd62d2cb9995352df1afc8f7e6e878ad` |
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
| `package.json` | `8fc4b5d29e6e0d3a61c0aaf689cbe99bd62ed3ed7d36bccfe9499f51b508db71` | written for poly |

## Conclusion

These files are polygraph at 4949de4, byte for byte. To take a newer polygraph, copy the same closure from the new commit and update this table in the same commit.
