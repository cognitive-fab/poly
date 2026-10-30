# agentapp, as a benchmark fixture

`agentapp.poly` and `defects.json` are copied unchanged from agentapp (`agent-mesh/agentapp`, commit 5842383): the program and its seeded defects. `goals.json` is agentapp's `scripts/witness.mjs` `PROBES`, each written as a goal (`conf` becomes `configuration`, the rest is kept). It is the largest poly program written so far: nine machines and ten configurations.

`scripts/bench-check-speed.mjs` checks it to measure the result cache (PT14a). No test checks it: a check of it without the cache takes tens of minutes.

## Conclusion

The fixture is agentapp's program as agentapp checks it, so the benchmark measures the case the cache was built for. When agentapp changes, copy the three files again and record the commit here.
