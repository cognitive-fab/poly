// M7.3 fixtures: SYNTHETIC Claude Code transcripts (JSONL) written from the history of polyness's verified-push example
// (polyness/examples/verified-push/run.mjs): fifteen tasks, twelve of which verify, add, commit and push; two push without
// verifying; one pushes twice. Verification is `npm test`, a command polyness recognises with no correction. Nothing here
// is anyone's transcript. The strings that a real transcript would carry and a proposal must never carry (a prompt, a path,
// an argument, a branch, a project name) are in the fixture on purpose, with a canary beside each, so that a test can look
// for them.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PUSH = { gitOperation: { push: { branch: 'release-main' } } };
const OK = 'Tests run: 40, Failures: 0, Errors: 0';

/** The tasks of one history: each is a list of [command, stdout, extra]. */
export function history(variant = 'default') {
  const full = (canary) => [
    [canary ? `npm test -- --grep ${canary}` : 'npm test', OK],
    ['git add -A', ''],
    [canary ? `git commit -m "change ${canary}"` : 'git commit -m change', ''],
    ['git push origin release-main', 'To github.com:acme/shop.git', PUSH],
  ];
  if (variant === 'careless') {
    // The standard is not the user's own: nobody here verifies before pushing.
    return Array.from({ length: 10 }, () => [['git add -A', ''], ['git commit -m change', ''], ['git push origin release-main', '', PUSH]]);
  }
  const canary = variant === 'canary' ? 'CANARY-7f3a9c1e' : null;
  return [
    ...Array.from({ length: 12 }, (_, i) => full(i === 0 ? canary : null)),
    [['git add -A', ''], ['git commit -m change', ''], ['git push origin release-main', '', PUSH]],
    [['git add -A', ''], ['git commit -m change', ''], ['git push origin release-main', '', PUSH]],
    [...full(null), ['git push origin release-main', '', PUSH]],
  ];
}

/** The JSONL lines of a history, as Claude Code writes them (the fields polyness reads). */
export function lines(tasks, { canary = null, base = 0 } = {}) {
  const out = [];
  let t = Date.parse('2026-08-01T09:00:00.000Z');
  const at = () => new Date((t += 60_000)).toISOString();
  tasks.forEach((commands, e) => {
    const session = `sess-secret-${String(base + e).padStart(2, '0')}`;
    out.push({ type: 'user', sessionId: session, timestamp: at(), message: { role: 'user', content: `please ship the change in /home/someone/private-shop/${e}${canary && e === 0 ? ` and remember ${canary}` : ''}` } });
    commands.forEach(([command, stdout, git], k) => {
      const id = `call-${base + e}-${k}`;
      const ts = at();
      out.push({ type: 'assistant', sessionId: session, timestamp: ts, gitBranch: 'release-main', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
      out.push({ type: 'user', sessionId: session, timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, toolUseResult: { stdout, stderr: '', ...(git ?? {}) } });
    });
  });
  return out;
}

/** Writes a folder of transcripts (one file per five tasks), returns the folder. */
export function writeTranscripts(dir, variant = 'default') {
  mkdirSync(dir, { recursive: true });
  const tasks = history(variant);
  const canary = variant === 'canary' ? 'CANARY-7f3a9c1e' : null;
  for (let i = 0; i < tasks.length; i += 5) {
    const slice = tasks.slice(i, i + 5);
    writeFileSync(join(dir, `session-${i / 5}.jsonl`), lines(slice, { canary: i === 0 ? canary : null, base: i }).map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  return dir;
}
