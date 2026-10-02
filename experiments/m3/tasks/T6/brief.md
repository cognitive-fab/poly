# Jobs with retries and cancellation

A job queue runs jobs on workers. Jobs are named by the caller with a string id. A job may be tried several times, up to a limit set when it is submitted, and it can be cancelled; a job that is running must be stopped by its worker, which may finish first.

## Commands

Each command returns `{ ok: true }` when it takes effect, and `{ ok: false, reason }` when it is refused. A refused command changes nothing. A command on a job id that was never submitted is refused.

- `submit(job, maxTries)`: creates the job, **queued**, allowed `maxTries` tries (1 to 3). Refused if `maxTries` is outside 1 to 3, or if a job with that id exists.
- `claim(job)`: a worker takes a queued job: it becomes **running**, and this counts as one try. Refused otherwise.
- `succeed(job)`: the worker finished a running job: it becomes **succeeded**. If the job was **cancelling**, the work was done before the worker could stop, and the job becomes **succeeded** too.
- `fail(job)`: the worker's try failed. A running job with tries left becomes **queued** again; a running job with no tries left becomes **failed**. A cancelling job becomes **cancelled**.
- `lost(job)`: the worker was lost. This is treated exactly as `fail`.
- `cancel(job)`: a queued job becomes **cancelled**. A running job becomes **cancelling**, and waits for its worker. Refused otherwise.

`succeed`, `fail` and `lost` are refused for a job that is neither running nor cancelling.

## Query

`job(job)` returns `{ status, tries, maxTries }` for a job that exists, and `null` otherwise. `status` is one of `"queued"`, `"running"`, `"cancelling"`, `"succeeded"`, `"failed"`, `"cancelled"`; `tries` is how many tries were made.

## The interface

Implement `host.ts`. Its default export creates a fresh system, with no jobs.

## Conclusion

A job is never tried more than its limit, it fails only when its last try failed, and a cancel never loses the outcome of work already done: a cancelled running job ends succeeded if its worker finished, and cancelled otherwise.
