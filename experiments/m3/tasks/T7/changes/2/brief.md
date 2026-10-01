# Change 2: time out a task

The run can now give up on a task whose worker takes too long.

- `taskTimeout(task)`: for task 0 or 1, while the run is running or cancelling and the task is still assigned, the run records the task as **failed**, as if its worker had reported `failed` for the last time (it is not retried), and sends the worker `Abort`. Refused otherwise.
- A report that arrives later for a task that is no longer assigned is ignored.

Everything else is as before.
