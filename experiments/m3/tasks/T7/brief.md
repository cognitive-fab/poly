# A run and its workers

A workflow run has two tasks, 0 and 1, each done by its own worker: task 0 by worker `"worker0"` and task 1 by worker `"worker1"`. The run and the workers are separate parts of the system that talk by messages. The system holds one run, `"run"`, and the two workers.

## Commands

Each command returns `{ ok: true }` when it takes effect, and `{ ok: false, reason }` when it is refused. A refused command changes nothing.

- `start()`: the run becomes **running**, both its tasks **assigned**, and it sends each worker `Assign`. Refused once the run has started.
- `workDone(worker)`: a busy worker finished its task. It becomes **idle** and reports `completed` to the run. Refused unless the worker is busy.
- `workFailed(worker)`: a busy worker's task failed. It becomes **idle** and reports `failed` to the run. Refused unless the worker is busy.
- `cancel()`: a running run becomes **cancelling** and sends `Abort` to the worker of each task that is still assigned. Refused otherwise.

A worker that receives `Assign` while idle becomes **busy**. A worker that receives `Abort` while busy stops, becomes **idle**, and reports `cancelled` to the run; an `Abort` that reaches an idle worker is ignored.

## The run's status

The run records each report as its task's status: **completed**, **failed** or **cancelled**. A task that has not reported is **assigned**. After each report, the run's status is:

- **completed** if both tasks completed;
- **failed** if any task failed and both tasks have reported;
- **cancelled** if both tasks have reported, none failed, and not both completed;
- unchanged otherwise (**running** or **cancelling**).

A run that is completed, failed or cancelled ignores further reports. Before `start()`, the run is **idle** with both tasks **idle**.

## Queries

- `run()` returns `{ status, task0, task1 }`.
- `worker(worker)` returns `{ status }` for `"worker0"` or `"worker1"`, `"idle"` or `"busy"`, and `null` for any other id.

## Messages

The run's id is `"run"`; the workers' ids are `"worker0"` and `"worker1"`. The messages are:

- from the run to a worker, `Assign` and `Abort`, with data `{}`;
- from a worker to the run, `Report` with data `{ task, outcome }`, where `task` is the worker's task (0 for `"worker0"`, 1 for `"worker1"`) and `outcome` is `"completed"`, `"failed"` or `"cancelled"`.

## The interface

Implement `host.ts`. Its default export creates a fresh system: the run and the two workers, all idle. A message is not delivered until `deliver(id)` or `deliverAll()` is called, and messages may arrive in any order. `inFlight()` lists the messages in transit with the sender, the receiver, the message name as `action`, and its data.

## Conclusion

The run's status never runs ahead of its workers: it is completed only when both workers reported completion, it ends only when both have reported, and a cancel stops only the work still in progress, whatever order the messages arrive in.
