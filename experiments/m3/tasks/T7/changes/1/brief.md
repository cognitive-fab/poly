# Change 1: retry a failed task once

A task that fails for the first time gets one more chance.

- When the run receives a `failed` report for a task while the run is running, and that task has not been retried yet, the run sends its worker `Assign` again, and the task stays **assigned**. The run's status does not change.
- A second failure of the same task, or a failure while the run is cancelling, is recorded as before.

`run()` now also returns `retried0` and `retried1`, booleans that say whether task 0 and task 1 have been retried. Everything else is as before.
