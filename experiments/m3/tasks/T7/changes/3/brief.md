# Change 3: count the items processed

A worker that finishes now says how many items it processed, 1 or 2, and the run keeps the total.

- `workDone(worker, items)`: as before, and the report carries `items`. Refused if `items` is not 1 or 2.
- `Report` now has data `{ task, outcome, items }`. `items` is the number processed for `completed`, and 0 for `failed` and `cancelled`.
- When the run records a `completed` report, it adds `items` to its total. Reports it ignores add nothing.

`run()` now also returns `processed`, the total, 0 at the start. Everything else is as before.
