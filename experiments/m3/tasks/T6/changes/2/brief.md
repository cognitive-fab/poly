# Change 2: failures that are not worth retrying

A worker can now report that a try failed in a way no retry will fix.

- `failPermanently(job)`: a running job becomes **failed** at once, whatever tries it has left. A cancelling job becomes **cancelled**, as with `fail`. Refused for any other job.

A job can therefore now be failed with tries left, but never without a try. Everything else is as before.
