# Change 3: pause a run

An operator can now pause a run, so that no queued task starts until the run is resumed.

- `pause(run)`: a run that is not paused becomes paused. Refused when it is paused.
- `resume(run)`: a paused run is no longer paused. Refused when it is not paused.
- `taskStarted(run, task)` is refused while the run is paused. Every other command works as before on a paused run.

`run(run)` now also returns `paused`, a boolean, false for a run that was never paused. Pausing does not change the run's status. Everything else is as before.
