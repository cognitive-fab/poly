# The inbox assistant

The owner's daily tool. It reads the owner's Gmail accounts, files each message by how soon it needs the owner and what kind it is, keeps one to-do per thread, and prepares a reply as a Gmail draft that the owner approves and sends from Gmail. It never sends anything itself. This is the program, its policy and the host code that runs it; "Run it yourself" below starts it on your own mailboxes. Everything the tests run is recorded traffic over made-up mail: no real account is read and no model is called.

## What it does

- **Each account is a source owned by its principal.** You name the principal for each account (`me-work`, `me-home`). Every message a decision reads carries its account as a taint, so a draft for one account can carry no other account's mail (IAC3).
- **Two routed decisions file each message.** One gives the triage (act now and reply, act now, reply this week, this week, for your information, ignore) and one the kind (request, question, meeting, invoice, personal, notification, newsletter, other). The small model answers first and the large one when the calibrated answer is below the threshold. A message the assistant cannot decide is held for you.
- **A thread has one to-do.** A message that needs you opens it. A decision gives its title and one gives when it is due; both read only the thread.
- **A reply is a draft you approve.** You ask for one. The assistant retrieves the thread, a decision on the large model writes the reply and cites the messages it relied on, and a draft without a citation is refused. The recipient, subject and threading headers come from the mailbox, never from the model or the mail. Every draft waits for your signed approval before it is created in Gmail, and only the compose scope is used, which cannot send.
- **Mail is data.** A message that tells the assistant to forward mail, give a password or pay produces only its triage and kind (IAC4).
- **A monthly budget** is reserved before each model call. A call that does not fit is denied, and its message waits (IAC6).

## What the check proves

The program, with its policy beside it, is `CLEAN` (expected line `// expected: CLEAN`). Its instance, as printed with the verdict:

| Machine | States |
|---|---|
| `Message` | 200 |
| `Todo` | 7,294 |
| the read grant, the compose grant (one per account each) | 13 each |
| the triage route, the kind route | 6 each |
| the monthly budget | 96 |

The check takes about two minutes and at most 8 GB. The policy has two rules, both stages `CLEAN`: a Gmail draft is created only after the owner approves it, and a model is asked only about mail no older than thirty days. polycheck finds every path from mail to the outside crossing a gate.

The acceptance criteria, each on recorded traffic (`docs/decisions-ex.md` has the figures):

| Criterion | What the test shows |
|---|---|
| IAC1 | three accounts, every message once and tagged with its account, across a restart in the middle of a batch |
| IAC2 | a proposed draft waits for the owner; after the signed approval it is created once, in the thread, addressed by the mailbox's envelope |
| IAC3 | at run time, a draft carrying another account's mail is denied `audience`; at check, a variant that reads a thread under a second principal is `PL6831` with a witness |
| IAC4 | a message with instructions yields its triage and kind and nothing else |
| IAC5 | a draft citing a message it was not given, or none, is refused `uncited` |
| IAC6 | with the monthly budget below a batch's cost, triage stops at the limit, nothing is overspent, and the rest wait |
| IAC7 | canaries in a message body and in every token appear in no record |
| IAC8 | forgetting an account erases its bodies and its mail, and replay still folds |
| IAC9 | the program is `CLEAN` with its instance, and 65 runs and 3 gate sessions replay with no divergence |

**The IAC3 limit.** IAC3's evidence at check is a cut-down copy (`test/fixtures/ex-inbox/cross-account.poly`) that keeps every part the leak runs through. The inbox's own `Todo` with that one change, reading the thread under a second principal, ran out of a 12 GB heap after 571 s, so the full inbox is not checkable with it within that memory. At run time IAC3 is shown on the full inbox.

### Check it yourself

From the repository root, after `npm ci` and `npm run build`:

```sh
node --max-old-space-size=8192 packages/poly-check/dist/src/cli.js check examples/inbox/inbox.poly
node --max-old-space-size=8192 --test --test-concurrency=1 test/ex-inbox.test.mjs test/ex-inbox-drafts.test.mjs test/ex-inbox-read-grant.test.mjs
```

The first checks the program alone, with its maps and prices beside it. The tests admit the project with its policy, load it over recorded Gmail traffic and run IAC1 to IAC9. The light tests are `test/ex-inbox-host.test.mjs`, `test/ex-gmail-source.test.mjs`, `test/ex-mime.test.mjs`, `test/ex-inbox-provider.test.mjs`, `test/ex-inbox-readonly.test.mjs` and `test/ex-inbox-setup.test.mjs`.

## Run it yourself

You set every key and every id yourself, on your own machine. Nothing below holds one: where this guide shows a command it names the variable or the file you set, never a value, and the host keeps no secret in any project file. Run the dry run first (the last part of this section): it starts the host through the same steps on recorded traffic, with none of your keys.

**Read-only first.** The host starts read-only. It reads, triages and prints a digest, and it cannot propose a draft: it never dispatches a request for a draft, never connects the compose credential, never registers the handler that creates a draft, and refuses a command to draft. Allow drafts only after you have read the digests for a while (`--drafts`).

### What you set, and where

| What | Where you set it |
|---|---|
| the Google OAuth client id | the environment variable `INBOX_GOOGLE_CLIENT_ID` |
| the Google OAuth client secret | the environment variable `INBOX_GOOGLE_CLIENT_SECRET` |
| the model provider key | the environment variable `ANTHROPIC_API_KEY` (the name is `model.keyEnv` in `inbox.host.json`) |
| the two model ids | `setup.mjs --small-model` and `--large-model`; they are in `inbox.host.json` and the price tables |
| the prices of those models | `setup.mjs --small-price` and `--large-price`, with the page you read them on and the date |
| the number of asks per decision | `setup.mjs --samples` (default 5) |
| the confidence threshold | `setup.mjs --threshold` (default 0.9) |
| the monthly cap, in usd | `setup.mjs --cap` (default 20) |
| your accounts | `setup.mjs --account <label>:<owner>`, once for each |
| your keys (admission, person, ledger, the vault's) | generated by `setup.mjs` into the key directory you name; nothing prints them |

### 1. The Google side

You do this once, in your browser. Google changes these screens and rules, so each item says what to confirm against Google's current documentation rather than what to expect.

1. Create a project in the Google Cloud console, and enable the Gmail API for it.
2. Set up the OAuth consent screen. Choose the user type that fits your accounts, and add every Google account you will link as a test user. Confirm what the "Testing" publishing status means today, above all **how long a refresh token lasts for an app in Testing status**. If Google documents a short expiry there, the assistant will lose its access to each account at that interval, and you relink it (step 6) or move the app out of Testing. Confirm what moving it requires.
3. Add the two scopes the assistant uses: read-only (`https://www.googleapis.com/auth/gmail.readonly`) and compose (`https://www.googleapis.com/auth/gmail.compose`, which creates drafts and cannot send). Confirm how Google classifies each scope today, and whether verification is required for the way you use them; this guide assumes your own accounts, as test users of your own app.
4. Create an OAuth client. Confirm which client type allows a redirect to a loopback address with a port and a path, and whether the redirect must be registered exactly. The host receives Google's redirect on your machine only (127.0.0.1), at these two addresses, with the port you give `setup.mjs` (8765 by default); register both exactly, and confirm Google accepts them:
   - `http://localhost:8765/credentials/gmail_read`
   - `http://localhost:8765/credentials/gmail_draft`
5. Note the client id and the client secret where Google shows them. You will put them in your environment in step 2, and nowhere else.

Confirm also, with your model provider, the ids of the two models you will use (a small one for triage and a larger one for the harder calls and the drafts), their prices per million tokens, and the page you read them on.

### 2. Set the three environment variables

In the shell you will start the host from. A file is not the place: a value in a project file is refused at admission (`PL6825`).

```sh
# live: environment, bash
export INBOX_GOOGLE_CLIENT_ID=<the client id from step 1>
export INBOX_GOOGLE_CLIENT_SECRET=<the client secret from step 1>
export ANTHROPIC_API_KEY=<your model provider key>
```

```powershell
# live: environment, PowerShell
$env:INBOX_GOOGLE_CLIENT_ID = '<the client id from step 1>'
$env:INBOX_GOOGLE_CLIENT_SECRET = '<the client secret from step 1>'
$env:ANTHROPIC_API_KEY = '<your model provider key>'
```

### 3. Scaffold your project

`<REPO>` is this repository, `<PROJECT>` a new directory and `<KEYS>` another, both outside the repository and not inside each other: setup refuses otherwise, since a key in the tree is one `git add` from being committed. The key directory also holds your Gmail text and the encrypted tokens, so keep it where only you can read it.

```sh
# live: setup
node <REPO>/examples/inbox/host/setup.mjs --project <PROJECT> --keys <KEYS> --account work:me-work --account home:me-home --small-model <small model id> --small-price <usd per million input tokens>,<usd per million output tokens> --large-model <large model id> --large-price <usd per million input tokens>,<usd per million output tokens> --prices-source <the https page you read the prices on> --prices-read-on <the date, YYYY-MM-DD>
```

Setup writes the program tailored to your choices, the policy as it is, your price tables, identity calibration maps for your two models, the handler that creates a draft, `poly.json` and `inbox.host.json`. It generates your keys, prints the reservations at your number of asks, and stops if the cap is below the largest of them. Add `--name` to give the project a name other than `inbox`, and `--port` to change the port.

What it tailors, and why. The example is checked with a recording; a live model needs these changes, each made in exactly one place and checked again when you admit the program:

- **n asks per decision.** A decision with a few answers is asked n times and the vote shares are its distribution. The program's token limits are for all n asks together, so they are n times the example's (4,000 input and 20 output tokens at one ask).
- **A confidence threshold of 0.9** instead of 0.8, in both routes and in the due date. With the identity maps and five asks, only a unanimous vote clears it, so an uncertain call goes to the large model and then to you. This is deliberately conservative.
- **Timeouts of 30 s, and 60 s for a draft,** instead of 2 to 20 s.
- **Your cap.** The cap lives in the program (`budget monthly`) and must stay at or above the largest reservation, or the check gives `PL6845`.

**Changing the model, the prices, the number of asks or the cap changes the build.** Edit them by running setup into a new project, or edit the files and check and admit again (steps 4 and 5).

### 4. Check the policy and the rings, then admit

```sh
# live: anchor
node <REPO>/packages/poly-check/dist/src/cli.js anchor keyrings --out <KEYS>/anchor.json --project <PROJECT>
# live: sign
node <REPO>/packages/poly-check/dist/src/cli.js sign policy inbox --by inbox-owner --key <KEYS>/person.pem --project <PROJECT>
# live: admit
node <REPO>/packages/poly-check/dist/src/cli.js admit <PROJECT>
```

The anchor fixes the first keyrings outside the project, and is named in your per-user configuration. Signing is yours, with your person key: it is the proof that you, not an agent that can edit the project, approved the policy. `admit` checks the program with its policy (about two minutes, up to 8 GB; give node `--max-old-space-size=8192` if it runs out), and writes the signed certificate. If the check reports a finding, the project is not admitted; read it before changing anything.

### 5. Replace the placeholders that make `conf` mean something

Until the calibration maps are refitted on your own mail, the model's confidence is uncalibrated: a vote share is only a vote share. Two things you can do, and the first is already done for you:

- The thresholds are conservative (above), so an uncertain decision escalates to you.
- A map is fitted on adjudicated outcomes (PD2.4) by `poly journal fit --db <PROJECT>/.poly/run/store.sqlite --decision triage --model <small model id>`, and is put in `src/maps/` with its `fittedFor` and admitted again. This host does not collect adjudications yet, so until you have a way to record them, treat the confidence as uncalibrated and leave the thresholds where they are. The example's own maps, in this repository, are the tests' and are fitted for no real model.

### 6. Link each account

Each account is linked as its owner, by a request you sign (S461), and the host takes it from the approvals folder.

```sh
# live: link
node <REPO>/examples/inbox/host/run.mjs link --project <PROJECT> --account work
node <REPO>/examples/inbox/host/run.mjs link --project <PROJECT> --account home
```

Start the host (step 7). On its first pass it takes each request and prints an address for each account. Open it in a browser signed in to that account, and allow read access. Google redirects to your machine; the host receives it, the vault keeps the tokens encrypted under your vault key, and the account's grant becomes `Granted`. To stop an account, revoke the app's access in that Google account's settings; the host then reports that account's sync as failed and goes on with the others. (The runtime can revoke a grant from a signed record, `poly grant-revoke`, but the command line does not offer that command yet.)

### 7. Start the host, read-only

```sh
# live: run
node <REPO>/examples/inbox/host/run.mjs run --project <PROJECT>
```

It makes a pass every five minutes (`--interval <seconds>` changes that, `--once` makes one pass and stops). Each pass syncs each account, lets the machines work and prints the digest: for each account the messages to do, filed, held for you, and being read; the open to-dos with their titles and due buckets; and the messages the assistant could not decide, with their sender and subject. The digest goes to your terminal only; no title, subject or body is written to a log or a file by the host. Stop it with Ctrl-C; the store survives, and a restart asks again for what was held.

Mail text is kept in two places on your machine, and nowhere else: the Gmail text in `<KEYS>/mail`, and the bodies the decisions read, by digest, in `<PROJECT>/.poly/run/store.sqlite`.

### 8. Allow drafts, when you are ready

Stop the host, link the compose scope for each account, and start it with `--drafts`:

```sh
# live: drafts
node <REPO>/examples/inbox/host/run.mjs link --project <PROJECT> --account work --drafts
node <REPO>/examples/inbox/host/run.mjs run --project <PROJECT> --drafts
```

Ask for a draft for a to-do from the digest (`<id>` is the id in angle brackets there), then propose it. The host takes the command on its next pass:

```sh
# live: ask
node <REPO>/examples/inbox/host/run.mjs ask --project <PROJECT> --todo <id> --do draft
node <REPO>/examples/inbox/host/run.mjs ask --project <PROJECT> --todo <id> --do propose
```

A proposed draft waits for you. The digest names the intent. Sign your approval, and the host creates the draft in your Gmail Drafts, in the thread, for you to edit and send from Gmail:

```sh
# live: approve
node <REPO>/packages/poly-check/dist/src/cli.js approve <intent> --by inbox-owner --key <KEYS>/person.pem --db <PROJECT>/.poly/run/store.sqlite --out <PROJECT>/approvals/<intent>.json
```

### If the model key expires

An expired or revoked key makes every model call fail. The decision takes its failed path, the message is held for you, and nothing is guessed: the host does not crash and does not answer for the model. It prints one line saying the key was refused and stops asking while it knows. To recover, stop the host (Ctrl-C), set a fresh key in `ANTHROPIC_API_KEY` as in step 2, and start the same command again. The held messages are asked again on the restart.

### If a Google grant stops working

The host prints `not linked yet` for an account whose grant is not `Granted`, and carries on with the others. If Google has expired a refresh token (see step 1, the Testing status), link the account again: run the `link` command for it and open the address.

### The dry run

The dry run starts the host through the steps above on recorded Gmail traffic and a recorded model, in a project of its own with its own keys, so you can see the startup path work before any key of yours is involved. The fake Google issues made-up tokens and the owner's consent is given for you. `<DRY_PROJECT>` and `<DRY_KEYS>` are two new directories outside the repository.

```sh
# step: dry-1-setup
node <REPO>/examples/inbox/host/setup.mjs --project <DRY_PROJECT> --keys <DRY_KEYS> --name inbox-dry-run --account work:me-work --account home:me-home --small-model dry-run-small --small-price 1,5 --large-model dry-run-large --large-price 3,15 --prices-source https://example.com/prices --prices-read-on 2026-10-11
# step: dry-2-anchor
node <REPO>/packages/poly-check/dist/src/cli.js anchor keyrings --out <DRY_KEYS>/anchor.json --project <DRY_PROJECT>
# step: dry-3-sign
node <REPO>/packages/poly-check/dist/src/cli.js sign policy inbox --by inbox-owner --key <DRY_KEYS>/person.pem --project <DRY_PROJECT>
# step: dry-4-admit
node <REPO>/packages/poly-check/dist/src/cli.js admit <DRY_PROJECT>
# step: dry-5-link
node <REPO>/examples/inbox/host/run.mjs link --project <DRY_PROJECT> --account work
node <REPO>/examples/inbox/host/run.mjs link --project <DRY_PROJECT> --account home
# step: dry-6-run
node <REPO>/examples/inbox/host/run.mjs run --project <DRY_PROJECT> --once --fixtures <REPO>/examples/inbox/dry-run/fixtures.json
```

Each `# step:` line above names a block that `test/after/ex-inbox-dry-run.test.mjs` reads from this file and runs, with the placeholders filled in, so the steps cannot drift from the test. The test is in the serial group because the admission takes minutes and a large heap. It asserts that the read-only run emits no draft: no `gmail.createDraft`, no `decision.write` and no envelope retrieval in the outbox. It was written with the steps and has not been run yet; do not take the steps as tested end to end until it has been.

## What it costs

A decision with a few answers is asked n times, so it costs n asks. The estimate below is arithmetic on stated assumptions, with **illustrative prices that are not your provider's**: replace them with the prices you read, and recompute with the formula.

- **Prices (illustrative):** small tier 1 usd per million input tokens and 5 per million output; large tier 3 and 15.
- **Per ask:** 1,500 input tokens (the headers and the text of one message) and 12 output tokens for a classification.
- **A classification ask:** small 1,560 micro-usd (a millionth of a usd), large 4,680. With five asks, a decision costs 7,800 on the small tier, and 23,400 more when it goes on to the large one.
- **A message:** two decisions (triage and kind), and an assumed 30 in 100 decisions go on to the large tier: 2 x (7,800 + 0.3 x 23,400) = 29,640 micro-usd, or 0.030 usd.
- **A to-do:** a title (one ask, 1,500 input and 20 output tokens, 1,600 micro-usd) and a due date (five asks, 7,800): 0.0094 usd.
- **A draft:** one ask on the large tier, 3,000 input and 200 output tokens: 0.012 usd.
- **A stated volume:** 10 messages a day (300 a month), 3 in 10 of them to-dos (90), and 15 drafts a month.
- **The month:** 300 x 0.02964 + 90 x 0.0094 + 15 x 0.012 = 8.89 + 0.85 + 0.18, about **10 usd a month**.

The cap you set (20 usd by default) is the limit, not the estimate: before each call the largest cost it can have (its reservation) is set aside, a call that does not fit is denied and its message waits, and the real cost replaces the reservation after the call. With these prices and five asks the reservations are 0.0205 usd for a small-tier classification, 0.0615 for a large-tier one, 0.0050 for a title and 0.039 for a draft; setup prints yours. `poly cost --db <PROJECT>/.poly/run/store.sqlite` sums what was spent.

## The model provider

The built-in provider asks the Anthropic Messages API (`https://api.anthropic.com/v1/messages`, the `x-api-key` header, the `anthropic-version` header); confirm all three against Anthropic's current documentation before the first live run. For a decision with a few answers it asks n times and takes the vote shares as the raw probabilities; an ask whose answer is not one of the allowed answers is no vote and lowers every share. A decision whose result is text is asked once, and a draft carries the message ids the model says it relied on. An authentication failure, a rate limit or an outage is thrown, so the decision fails and is asked again later; the provider never returns a default.

To use another model or another way of forming the distribution, point the config at your own module: set `"model": { "provider": "module", "module": "<absolute path to an ES module>" }` in `inbox.host.json`. The module exports `makeProviders({ results, config, env })`, where `results` maps each decision to its allowed answers or to `'content'`. It returns:

```js
{
  tiers: { small(question, materials), large(question, materials) },                  // the two routes' tiers
  decisions: { summary: { provider, model }, when: { provider, model }, write: { provider, model } },
}
```

Each function takes `question` (`{ decision, limits: { maxInputTokens, maxTokens } }`) and `materials` (`{ bodies, items: { <parameter>: [{ id, body }] } }`) and returns `{ answer, distribution: [[answer, p], ...], usage: { input, output }, cites }`: the chosen answer first with its raw probability in 0 to 1, the tokens used (within `limits`), and for `write` the ids it cited. It must throw when it cannot answer, and never return a guess. The email in `materials` is untrusted data.

## Stated limits

- **Gmail only.** Mail through Amazon SES is deferred.
- **No page.** The digest on your terminal and the commands folder are the interface; there is no web page.
- **Uncalibrated confidence,** and no way yet in the host to record the adjudications a refit needs. The thresholds are conservative for that reason.
- **The vault is the development keychain,** the one store that needs no cloud key service. Your tokens are encrypted under a key in a file beside them, so anything that can read your key directory can read your tokens. Admission refuses it in a production project (`PL6826`), so the anchor must not be marked production.
- **Single user, single process.** One host owns the store at a time.
- **The program is tailored, and checked again on your machine.** Its `CLEAN` is for the example; yours is the verdict of `poly admit`.
- **The first live run is yours.** The recorded model and fake Google are the only ones this repository has run against.
- **IAC3's check evidence is a cut-down copy,** as stated above.

## Conclusion

The inbox assistant keeps a monthly budget, a per-account grant, a taint on every message and a signed approval before every draft, and the checker and the tests hold each to account on recorded traffic. What stays with you is the live side: your Google project, your keys, your model's prices, and the first run. Start read-only, read the digest for a while, and allow drafts when you trust it.

## Glossary

- **Account:** one Gmail mailbox, a source owned by the principal you name for it.
- **Admit:** check a project and, when it is clean, write and sign the certificate the runtime loads.
- **Anchor:** the file, outside the project, that fixes the first keyrings, so that an agent that can edit the project cannot add its own key.
- **Approval:** your signed record that a proposed draft may be created.
- **Ask:** one call to the model; a decision with a few answers is asked n times.
- **Cap:** the monthly limit on spend, in the program.
- **Digest:** the list the host prints after each pass.
- **Dry run:** the host started on recorded traffic through the same steps, with none of your keys.
- **Grant:** the authorisation of a credential for one account, requested by your signed record.
- **Held:** a message the assistant could not decide, left for you.
- **Principal:** the name you give an account's owner.
- **Read-only run:** the host without `--drafts`, which cannot propose a draft.
- **Reservation:** the most a call can cost, set aside before it runs.
- **Taint:** the account a piece of mail came from, carried with it.
- **Vault:** where a credential's tokens are kept, encrypted.
- **Vote share:** the fraction of asks that gave an answer, used as its raw probability.
