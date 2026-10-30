# agentapp, as a benchmark fixture

`agentapp.poly.txt` (agentapp's `agentapp.poly`) and `defects.json` are copied unchanged from agentapp (`agent-mesh/agentapp`, commit 5842383): the program and its seeded defects. `goals.json` is agentapp's `scripts/witness.mjs` `PROBES`, each written as a goal (`conf` becomes `configuration`, the rest is kept). It is the largest poly program written so far: nine machines and ten configurations.

`scripts/bench-check-speed.mjs` checks it to measure the result cache (PT14a). The program is kept as text, not as a `.poly` source: the suite checks every `.poly` source of the repository for toolchain faults (`test/standing.test.mjs`) and scans each for retry safety, with its default heap, and one check of agentapp needs more than that heap holds (agentapp runs it with 6 GB). The benchmark copies it to a `.poly` file in its scratch directory. Whether it should become a source, checked in the serial group with a larger heap, is the owner's call.

## Conclusion

The fixture is agentapp's program as agentapp checks it, so the benchmark measures the case the cache was built for. When agentapp changes, copy the three files again and record the commit here.
