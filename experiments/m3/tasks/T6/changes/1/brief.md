# Change 1: hold a queued job

An operator can now hold a queued job back, so that no worker takes it.

- `hold(job)`: a queued job becomes **held**. Refused otherwise.
- `release(job)`: a held job becomes **queued**. Refused otherwise.
- `claim(job)` is refused for a held job; `cancel(job)` on a held job makes it **cancelled**.

`status` in the view can now also be `"held"`. Everything else is as before.
