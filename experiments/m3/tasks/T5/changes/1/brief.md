# Change 1: retry a failed task

A failed task can now be queued again, so a failed run is no longer the end of it.

- `taskRetried(run, task)`: a failed task becomes queued. Refused otherwise.
- A run whose status is failed now accepts commands. Only a run whose status is completed or cancelled refuses every command.

The run's status is derived as before, after every command that takes effect. Everything else is as before.
