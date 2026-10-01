# Workflow run status

A workflow engine runs workflows of three tasks, numbered 0, 1 and 2. Runs are named by the caller with a string id. Workers report what happens to each task, and the run shows one status derived from its three tasks, so that a dashboard can show it.

## Tasks

A task is **queued**, **running**, **evicted** (its worker was lost, and it waits to be queued again), **completed**, **failed** or **cancelled**. The first three are *in flight*; the last three are *final*.

## Commands

Each command returns `{ ok: true }` when it takes effect, and `{ ok: false, reason }` when it is refused. A refused command changes nothing. A command on a run id that was never started is refused, and once a run's status is completed, failed or cancelled, every command on it is refused.

- `start(run)`: creates the run with its three tasks queued. Refused if a run with that id exists.
- `taskStarted(run, task)`: a queued task becomes running.
- `taskCompleted(run, task)`: a running task becomes completed.
- `taskFailed(run, task)`: a running task becomes failed.
- `taskEvicted(run, task)`: a running task becomes evicted.
- `taskRequeued(run, task)`: an evicted task becomes queued.
- `cancel(run)`: every task in flight becomes cancelled. Refused when no task is in flight.

A task report that does not follow these moves is refused.

## The run's status

After every command that takes effect, the run's status is derived from its tasks, in this order:

1. if the three tasks have the same status, the run has that status;
2. otherwise, if any task failed, the run is **failed**;
3. otherwise, if any task is in flight, the run is **running**;
4. otherwise the run is **cancelled**.

A run starts **queued**.

## Query

`run(run)` returns `{ status, task0, task1, task2 }` for a run that exists, and `null` otherwise. Each value is one of `"queued"`, `"running"`, `"evicted"`, `"completed"`, `"failed"`, `"cancelled"`.

## The interface

Implement `host.ts`. Its default export creates a fresh system, with no runs.

## Conclusion

The run's status never hides a task: it is completed only when every task completed, failed whenever a task failed, and never completed or cancelled while a task is still in flight, evicted tasks included.
