# git-push-checked

Proposed by polyness from **16 instances** of `git push` in `project`, mined 2026-10-12.

## Steps

`npm test → git add → git commit → git push`

## Rules, and what each is made of

### `git-push-implies-a-prior-git-add`

- never violated (16/16)
- measured over one run

### `git-push-implies-a-prior-git-commit`

- never violated (16/16)
- measured over one run

### `exactly-one-git-add-per-git-push-run`

- never violated (15/15)
- measured over one run

### `exactly-one-git-commit-per-git-push-run`

- never violated (15/15)
- measured over one run

### `at-most-one-git-push-per-run`

- you did this 14 of 15 times, and it would have stopped the other 1
- measured over one run

It would have stopped:

- `sess-secret-14:call-14-3` — episode 14, 2026-08-01T09:23:00.000Z

### `no-git-push-without-a-passing-verify`

- you did this 14 of 16 times, and it would have stopped the other 2 — measured across the session; 14 of 16 runs already did it inside one run
- measured over the session
- inside a single run: 14 of 16 — the gap is the change this proposal asks for

It would have stopped:

- `sess-secret-12:call-12-2` — episode 12, 2026-08-01T09:14:00.000Z
- `sess-secret-13:call-13-2` — episode 13, 2026-08-01T09:18:00.000Z

## What is not here

The machine itself. polyness proposes the contract, the effect surface and
the rules; **polygen** authors the SAM module and **polyflow's gate** decides
whether it may run. A proposal that fails the gate is refused, not flagged.
