# Start times of the builds in the replay container

The rehearsal found that the poly builds did not listen within the driver's 15 seconds in the container. This note measures it. The driver now reports `startedMs` (DB6 item 11), and the start command stamped the copy and the empty node boot, so each start splits into its parts. The raw rows are `rehearsal-dry-run/start-times.jsonl`. The runs were made in Windows PowerShell 5.1 on the owner's machine, with the image `poly-demo-replay:step12`.

## What a start is made of

The replay starts a build with a command that does three things in the container:

1. **copy**: `cp -r /build/. $D`. The tree is mounted read-only from Windows, and the build writes its state beside itself, so the container copies the tree, `node_modules` included, into its own temporary space first. `poly-kept` is 1240 files (30 MB of `node_modules`) and `ts-kept` is 516 files (26 MB).
2. **node boot**: the start of a node process (measured with an empty one).
3. **admit and listen**: what is left of `startedMs`: the build admits its program (the check runs at every start) and opens its port.

`startedMs` is the time from the spawn of that command to the first connection to the build's port. A replay makes two starts, the control and the fault run, and each has its own `startedMs`.

## Cold starts: the first start after Docker Desktop was restarted (poly-kept, 5 runs)

| Run | Start (control) | copy | node boot | admit and listen | Start (fault run) | copy | admit and listen | Whole replay |
|---|---|---|---|---|---|---|---|---|
| 1 | 75.4 s | 63.8 s | 0.2 s | 11.4 s | 53.9 s | 46.8 s | 7.0 s | 155.4 s |
| 2 | 91.6 s | 79.9 s | 0.3 s | 11.4 s | 86.7 s | 71.5 s | 15.0 s | 205.2 s |
| 3 | 62.5 s | 56.9 s | 0.2 s | 5.5 s | 70.2 s | 58.1 s | 11.9 s | 162.4 s |
| 4 | 27.4 s | 24.4 s | 0.1 s | 2.9 s | 30.0 s | 28.0 s | 1.9 s | 79.0 s |
| 5 | 22.5 s | 20.6 s | 0.1 s | 1.9 s | 21.9 s | 19.9 s | 1.9 s | 61.8 s |

Starts: min 21.9 s, median 62.5 s, max 91.6 s. Copy: min 19.9 s, median 56.9 s, max 79.9 s.

## Warm starts: five replays in a row (poly-kept)

| Run | Start (control) | copy | node boot | admit and listen | Start (fault run) | copy | admit and listen | Whole replay |
|---|---|---|---|---|---|---|---|---|
| 1 | 24.6 s | 22.6 s | 0.0 s | 1.9 s | 23.6 s | 21.7 s | 1.9 s | 64.0 s |
| 2 | 28.4 s | 26.5 s | 0.0 s | 1.8 s | 22.4 s | 20.5 s | 1.9 s | 66.7 s |
| 3 | 18.0 s | 16.1 s | 0.0 s | 1.8 s | 17.0 s | 15.0 s | 1.9 s | 50.7 s |
| 4 | 17.9 s | 16.0 s | 0.0 s | 1.8 s | 16.9 s | 14.9 s | 1.9 s | 50.7 s |
| 5 | 18.9 s | 17.1 s | 0.0 s | 1.8 s | 18.6 s | 16.6 s | 1.9 s | 53.6 s |

Starts: min 16.9 s, median 18.9 s, max 28.4 s. Copy: min 14.9 s, median 17.1 s, max 26.5 s. Admit and listen: min 1.8 s, median 1.9 s, max 1.9 s.

## For contrast: ts-kept, warm (3 runs)

| Run | Start (control) | copy | node boot | admit and listen | Start (fault run) | copy | admit and listen | Whole replay |
|---|---|---|---|---|---|---|---|---|
| 1 | 8.6 s | 7.3 s | 0.0 s | 1.2 s | 7.8 s | 7.3 s | 0.5 s | 30.8 s |
| 2 | 8.2 s | 7.4 s | 0.0 s | 0.7 s | 7.2 s | 6.7 s | 0.5 s | 29.8 s |
| 3 | 7.8 s | 6.9 s | 0.0 s | 0.8 s | 6.8 s | 6.3 s | 0.5 s | 29.1 s |

Starts: min 6.8 s, median 7.8 s, max 8.6 s.

## The overhead of `docker run` itself

Three runs of an empty command: 1.5 s, 1.5 s, 1.6 s.

## What the numbers say

- The copy is almost all of the start. In every poly run it is 82 percent or more of `startedMs`. Node boots in under a third of a second. Admitting the program and listening take about two seconds when warm, and 2 to 15 seconds in the cold runs.
- The copy is slow because it reads 1240 small files through the Windows mount. It takes 15 to 27 seconds warm, and 20 to 80 seconds in the cold runs.
- Warm-up helps only a little. The warm runs are the fastest, but a warm start still takes 17 to 28 seconds, over the 15 seconds the driver allowed. The cold runs ranged from 22 to 92 seconds with no clear order, so the Docker virtual machine's state matters more than a restart does.
- `ts-kept` has 516 files and starts in about 7 to 9 seconds, which is why it fitted.
- The slowest start measured is 91.6 seconds. The runbook sets `--listen-timeout 180000` for the poly builds, twice that, and the default of 15000 stays so that the records do not change.

A change that would remove the cost, not hide it, is to stop copying `node_modules`: mount the tree read-only and give the build a writable overlay for its state only. It is not made here.

## Conclusion

The poly builds are slow to start in the container because the start copies 1240 files across the Windows mount, not because admission is slow. A listen timeout of 180 seconds covers the slowest start measured with room to spare. The default stays 15 seconds, and the replay reports `startedMs` so that the next change can be judged on a number.

## Glossary

- **Cold start:** the first start after Docker Desktop was restarted.
- **Warm start:** a start after others have run in the same Docker session.
- **`startedMs`:** milliseconds from the spawn of the build's command to the first connection to its port.
- **Copy:** the `cp -r` of the tree into the container's temporary space.
- **Admit:** the runtime's check of the program at start; a build with an unaccepted finding is not admitted.
