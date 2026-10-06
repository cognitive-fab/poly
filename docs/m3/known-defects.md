# M3: known defects of the frozen evidence

The M3 experiment's files are frozen (`experiments/m3/FROZEN`, added in 1c8d155): a change to them is a deviation, so a defect found in them later is recorded here and the file is left as it is.

| File | Defect | Found | Effect on the frozen results |
|---|---|---|---|
| `experiments/m3/runner-mutant-assign/agent.mjs` | `runTurn` spawns the agent with no `error` listener, so a spawn failure (ENOENT, EACCES) throws out of the runner instead of ending the turn as stopped. | Polywatch review `muw7859c`, during M8 plan step 9 (`decisions-m8.md`); disposition ruled in `decisions-m9.md` | None recorded: no frozen run reports a spawn failure. A spawn failure would have ended its run with an error, never a scored turn. |

## Conclusion

The frozen M3 files are not edited after the freeze. Each defect found in them since is listed here with where it was found and whether any frozen result depends on it.
