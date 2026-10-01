# Change 3: resubmit a failed job

An operator can now give a failed job a fresh start.

- `resubmit(job)`: a failed job becomes **queued** with its tries back to 0 and the same limit. Refused otherwise.

Everything else is as before.
