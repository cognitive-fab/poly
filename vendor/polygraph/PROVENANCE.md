# polygraph, vendored

The files of `@cognitive-fab/polygraph` 8.3.1 that poly imports, and nothing else, copied unchanged. poly relies on the Poly stack conceptually, not physically: the engines are read here, and a change an engine needs is made in its own repository and then copied in again.

- Source: `C:/Users/jjdub/code/polygraph`, commit `583b82c` ("8.3.1: vendor sam-pattern 2.3.0, and pin the two shapes it changed"), not published.
- Selection: the relative-import closure of the five entry points poly uses (`scripts/check.mjs`, `scripts/replay.mjs`, `polyrun/src/check-effects.mjs`, `polyrun/src/check-product.mjs`, `polyrun/src/index.mjs`), with `scripts/sam-tv.mjs`, which `replay.mjs` runs as a child process. `store-pg.mjs` requires `pg` only when a Postgres store is asked for; poly never asks.
- Each file is taken from the commit with `git show 583b82c:<path>`, so uncommitted work in that checkout is not included.
- Licence: Apache-2.0, in `LICENSE`.
- `package.json` is written for poly (name, version, module type) and is not a copy.

`test/vendor.test.mjs` re-hashes every file against this table, and, where the source checkout exists, compares each file with the commit.

| File | sha256 |
|---|---|
| `LICENSE` | `71436dfeb742f9358c98a81da67d39d6c64a02964bfeeafdd399ed52c2583634` |
| `polyrun/src/check-effects.mjs` | `19e40a5c3940df591f3f60a34bb95b87d9ad80a00365d9ef4122fe3586d158f9` |
| `polyrun/src/check-product.mjs` | `76d92abca245cf9e4864fe81146bb5f9980a25e950e3a357bee32a0dc5610d0f` |
| `polyrun/src/constants.mjs` | `ef60f4ae71f6889fa6c0012acfa1784f46604e59987d4b6bbc107ce8b3c3b6c8` |
| `polyrun/src/duration.mjs` | `60a50c1dd2353ad6a96ef2bbf30ee93f751f604ffe509d505b178a00869757c4` |
| `polyrun/src/index.mjs` | `777ede8ff136dd347c5447c6c808bb7bb65d8483667b7ae40ed4d22eca0cd78c` |
| `polyrun/src/kernel.mjs` | `c364d169f081da2926f040dc0368035d39cb97283d475b5544bfa53bc89f4912` |
| `polyrun/src/store-pg.mjs` | `cf54daae7d8e5e2a6d1147db2a61c68351313491423ed12a87f656e471bd69d3` |
| `polyrun/src/store.mjs` | `efbb3624db53703dc7a145c4e1d4217adfeb9be8e2f732f7ec0577d1cc9687b6` |
| `polyrun/src/workers.mjs` | `5b59b88891dec01241c880335b57849e8b7b323b0a5ddb41b2bc8cd33981aec0` |
| `scripts/check.mjs` | `9792aad60f7c4608678b86fc0031a223c8f40f43b3de8ba8d7ac054ebf99fcdd` |
| `scripts/load-spec.mjs` | `6775799e3b810ba10f1aba7493ed97e217eb6bf28d3fc445033deeb3ec91b5e7` |
| `scripts/replay.mjs` | `193bda2a9c164f7578de58d9d0794208a9c0322919e605832798539194381923` |
| `scripts/sam-adapter.cjs` | `64645a3f4e64c709e359e4abfaf397a7de095df45d3b46cca880a09d9f7e8943` |
| `scripts/sam-tv.mjs` | `fc15a3ad28bdb474685f840d0493ea97216e0b67a2f16621fc1f213b03cb5452` |
| `scripts/sam-lib.mjs` | `127136dfce2c5a29a6e00e40d94d8116628f4435dfbdad58d18fddb23af38ce4` |
| `scripts/vendor/sam-pattern.cjs` | `11b7ee8680bd850f649bff4e5abef6498dc3e02e1f932a18366ee00618541973` |

## Conclusion

These files are polygraph at 583b82c, byte for byte. To take a newer polygraph, copy the same closure from the new commit and update this table in the same commit.
