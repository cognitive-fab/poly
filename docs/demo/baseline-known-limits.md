# The baseline: pilot verdict and known limits

This note goes with the final report of the baseline (`demo/baseline/`). It records which pilots are valid, what the guard refused in `poly-pilot-3`, and why the guard is left as it is for the kept runs.

## The pilot verdict

The valid pilots are `ts-pilot-2` and `poly-pilot-3`.

| Run | Commit | Tree | Verdict |
|---|---|---|---|
| `ts-pilot-1` | `90eee290` | `f3be07cd` | excluded (H3, H4) |
| `poly-pilot-1` | `20f7054c` | `d02b8170` | excluded (H1, H2, H3) |
| `ts-pilot-2` | `c4e88c64` | `f7d99956f025c4bd1e335facd17ae167fa50b35e` | valid pilot of the TypeScript arm |
| `poly-pilot-2` | `c8aaeb95` | `f7322dff3f5879677a7b2cd87b51dc4be23b3c59` | excluded (H5, with H6 and H7) |
| `poly-pilot-3` | `1a18b438` | `4357763479644eb7740cd6c95225b88960cb20bd` | valid pilot of the poly arm |

An excluded run is a finding of the harness, not a result. It stays in the record and stays taken: its name is not used again. The findings are in `PREREGISTRATION.amendment-1.json` (H1 to H4) and `PREREGISTRATION.amendment-2.json` (H5 to H7), and in `demo/baseline/README.md`.

## The guard's two false-positive shapes

The guard (`guard.mjs`, hash `52d99186…`, with `hook.mjs`, hash `7cfd46d1…`) refused two calls of `poly-pilot-3` that are not escapes. The live hook refused both in the run, and the agent saw `PreToolUse:Bash hook error: Bash names a place outside the workspace …`.

1. **The workspace in MSYS form.** Call 4 was `cd /c/Users/jjdub/.poly-demo/work/poly-pilot-3 && grep -n "^#" tools/poly/docs/03-technical-spec.md`. The path is the agent's own workspace, written `/c/...`. The guard compares it with `C:\Users\jjdub\.poly-demo\work\poly-pilot-3` and does not convert the form, so it reads a place outside. The same command with `C:/…` is allowed.
2. **A word that is not a path.** Call 26 was a `python3 - <<'EOF'` heredoc that rewrites `src/support.poly`. Its program text holds `Line { i: n }`. The guard splits the text into words and reads the word `i:` as the drive `I:`. The same text inside quotes on one line is allowed, and inside a heredoc it is refused.

Both are shapes of how a command is written. Neither is a place the agent reached.

## Why the guard stays as it is

- **The same code runs in both arms.** The guard, the hook and the settings are byte for byte the same for the TypeScript arm and the poly arm. Which agent meets a shape depends on how that agent spells its workspace and what its program text contains, not on its arm. In the pilots, `ts-pilot-2` and `poly-pilot-2` met neither shape.
- **Changing it would cost both arms their pilots.** The guard hash is in the pre-registration and in the keeps of amendment 2. A change makes `ts-pilot-2` and `poly-pilot-3` pilots of a harness that the kept runs do not use.
- **The owner ruled it so.** The kept runs run under the guard as pre-registered. The audit, which runs after a run and which no agent sees, is the part that changes.

## The evidence that the refusals had no effect in `poly-pilot-3`

`poly-pilot-3` made 94 tool calls. The guard or the tool list refused 9 of them.

| Call | Refused by | What the agent did next |
|---|---|---|
| 4, `cd /c/.../poly-pilot-3 && grep -n …` | guard (MSYS path) | used Grep and Read on the same file |
| 26, the `python3` heredoc | guard (non-path word) | made the same edits with the Edit tool, then ran `npm run poly check` |
| 32, `sed -n … \| cut -c1-3000` | guard (pipe rule) | used Read on the file |
| 39, `grep … \| head; … \| grep -i manifest` | guard (pipe rule) | used Grep and `cat … \| head -40` |
| 56, a heredoc then `node … \| grep -v Warning` | guard (pipe rule) | used Write for the file and `node --no-warnings …` |
| 66, `cd lib && sed -i …` | tool list | used the Edit tool |
| 78, 79, `rm spike.mjs spike2.mjs …` | tool list | left the two scripts in the tree and said so |
| 92, the start sequence (`keygen`, `admit`, `start`) | tool list | wrote the README; its final message says the start sequence was not tried |

Calls 4 and 26 would also have been refused by the tool list, because neither `grep` nor `python3` is in the poly list. The agent used another tool each time and went on. Its final message reports 26 passing tests and a CLEAN `poly check`, and neither depended on these two calls. The two refusals that left a mark on the tree and on its testing are the tool list's (78 and 79 left `spike.mjs` and `spike2.mjs` in the tree; 92 left the start sequence untried). Those are the tool list working as designed, and they are in the record.

## What the audit says

`auditRun` (DB17 item 7) now treats an MSYS path inside the workspace as a refused call with the note `guard false positive: MSYS path`, and a bare letter and colon as a refused call with the note `guard false positive: non-path word`. A resolved path outside the workspace, and a disallowed tool, are the only escapes. The committed run folders are not edited: `poly-pilot-3` is recorded as `escaped` with 2 calls in its `RECORD.json`, and the re-audit that corrects this is in the final report.

## The kept runs: the validity rule and two more cases

The rule was ruled before `poly-kept` ran and applies to both arms. A run is invalid only if a call outside the workspace actually ran, or a disallowed tool was used. An outside call that the hook refused is a refused escape attempt: it is listed and does not invalidate the run. The audit has three statuses (DB17 item 8): `clean`, `attempted` (one or more outside calls, every one refused by the hook) and `escaped` (an outside call that ran).

| Run | Commit | Tree | Audit | Valid |
|---|---|---|---|---|
| `ts-kept` | `81bb63dd` | `3e8246df94595dcf9fbd588195f2dfcc04afee20` | attempted (1 attempted, 0 escaped, 1 refused by the tool list) | yes |
| `poly-kept` | `aac2b13e` | `235a38fa6012b2cd9446e013eaa87d8856772f7d` | clean (0 attempted, 0 escaped, 6 refused, 2 noted) | yes |

**`ts-kept`, one attempt.** Call 2 was `cat .harness/typescript/package.json | grep '"version"'; mkdir -p /tmp/tt/test && cd /tmp/tt && …`, a scratch check of how Node strips types. The hook refused it live for `/tmp/tt/test`, `/tmp/tt` and `test/a.test.ts`, and nothing was created. The agent used Grep and went on to write its files. Its later start-up smoke call (call 22) was refused by the tool list, and its final message says `npm start` was never run.

**`poly-kept`, one call refused for option words.** Call 56 was a start-up smoke test: `export … ; for i in 1 2; do (node src/main.js &) ; sleep 8; curl … ; taskkill //F //IM node.exe //FI "WINDOWTITLE eq *" …; npx --yes kill-port 3917 …; done`. The hook refused it live because the guard read `//F`, `//IM` and `//FI`, the MSYS option form of `taskkill`, as paths. They are not paths, so the audit lists the call as a guard refusal with the note `guard false positive: non-path word` (DB17 item 7). Had it run, it would have ended the `node.exe` processes that the filter matched, which could include the agent's own tools; the refusal was a false positive that was also protective, and it is the guard's doing and not the audit's. The agent skipped the smoke test and wrote its README. The session holds no `tasklist` call; the owner's description of two attempts is one call with two options. The same session also met the MSYS spelling of its own workspace (call 14, noted `MSYS path`), two pipe-rule refusals (calls 20 and 51) and two refusals by the tool list (calls 8 and 22). None changed what it built: it used Read, Grep and Edit instead, and its tests (21) pass by its own report.

Both cases are the guard working as designed on the kept runs, and neither run is invalid.

## Conclusion

The valid pilots are `ts-pilot-2` and `poly-pilot-3`, and both kept runs, `ts-kept` and `poly-kept`, are valid under the rule above. The guard has three false-positive shapes: an MSYS spelling of the workspace, a drive-like word in program text, and the MSYS option form of a Windows tool. They are the same for both arms. They refused calls of `poly-pilot-3` and `poly-kept`, and none of them changed what the agent built or tested. `ts-kept` made one refused attempt outside its workspace, and that does not invalidate it. The kept runs ran under the guard as pre-registered, and the audit tells a false positive and a refused attempt from an escape.
