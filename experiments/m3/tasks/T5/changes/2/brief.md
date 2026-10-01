# Change 2: cancel one task

A single task can now be cancelled without cancelling the run.

- `cancelTask(run, task)`: a task in flight becomes cancelled, and the run's status is derived again. Refused for a task that is final.

Everything else is as before.
