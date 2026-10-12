// plan-e3.md E3.7: the tool calls of a live turn, run in a scratch copy of a task (tasks.mjs) and nowhere else.
//
// The three rules of the owner (2026-10-12) are held by tasks.mjs and used here without exception: every path is resolved inside
// the copy (an edit that would leave it throws), every command goes through runIn (the built environment holds no key, the
// toolchains are offline, a command that names a network tool is refused), and a command runs without a shell. The call shapes
// are those of the recordings: edit {path, old?, new}, write {path, content}, read {path}, search {pattern, path?}, bash {command}.
// This file holds no rule of the machines. It is the host's, not the module's, until the `act` effect declares an exec capability
// (open, waiting for the owner's go on admissions; see docs/decisions-e3.md).
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { inside, runIn } from './tasks.mjs';

/** Splits a command line into words, honouring single and double quotes. No expansion, no operators: a shell is never run. */
export function words(line) {
  const out = [];
  let cur = '';
  let quote = null;
  let any = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      any = true;
    } else if (/\s/.test(ch)) {
      if (cur !== '' || any) out.push(cur);
      cur = '';
      any = false;
    } else cur += ch;
  }
  if (cur !== '' || any) out.push(cur);
  return out;
}

const SKIP = new Set(['node_modules', '.git', '.poly', '.gocache', 'dist', 'coverage']);

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

/** One call, run in the copy. Returns the text the agent sees and an exit status; it never throws on the agent's mistakes. */
export async function runCall(copy, call, { timeoutMs = 120_000 } = {}) {
  try {
    switch (call?.tool) {
      case 'read': {
        return { text: readFileSync(inside(copy, call.path), 'utf8'), exitStatus: 0 };
      }
      case 'write': {
        const p = inside(copy, call.path);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, String(call.content ?? ''));
        return { text: `wrote ${call.path}\n`, exitStatus: 0 };
      }
      case 'edit': {
        const p = inside(copy, call.path);
        const text = readFileSync(p, 'utf8');
        if (typeof call.old !== 'string' || call.old === '') return { text: `edit ${call.path}: "old" is required\n`, exitStatus: 1 };
        const n = text.split(call.old).length - 1;
        if (n !== 1) return { text: `edit ${call.path}: "old" occurs ${n} times, it must occur once\n`, exitStatus: 1 };
        writeFileSync(p, text.replace(call.old, () => String(call.new ?? '')));
        return { text: `edited ${call.path}\n`, exitStatus: 0 };
      }
      case 'search': {
        const re = new RegExp(call.pattern);
        const root = inside(copy, call.path ?? '.');
        const hits = [];
        for (const f of walk(root)) {
          const lines = readFileSync(f, 'utf8').split('\n');
          const rel = relative(copy, f).split(sep).join('/');
          lines.forEach((l, i) => { if (re.test(l) && hits.length < 200) hits.push(`${rel}:${i + 1}:${l}`); });
        }
        return { text: `${hits.join('\n')}\n`, exitStatus: hits.length ? 0 : 1 };
      }
      case 'bash': {
        const [cmd, ...args] = words(String(call.command ?? ''));
        if (!cmd) return { text: 'empty command\n', exitStatus: 1 };
        const r = await runIn(copy, cmd, args, { timeoutMs });
        const text = `${r.stdout}${r.stderr}${r.timedOut ? '\n[timed out]\n' : ''}`;
        return { text, exitStatus: r.status ?? 1 };
      }
      default:
        return { text: `unknown tool ${JSON.stringify(call?.tool)}\n`, exitStatus: 1 };
    }
  } catch (e) {
    return { text: `${e.message}\n`, exitStatus: 1 };
  }
}

/** A turn's calls (the JSON the model wrote), run in order. Output is joined; the status is the last non-zero one, else 0. */
export async function runCalls(copy, callsJson, opts) {
  let calls;
  try {
    calls = JSON.parse(callsJson);
  } catch {
    return { text: 'the calls are not valid JSON\n', exitStatus: 1 };
  }
  if (!Array.isArray(calls)) return { text: 'the calls must be a list\n', exitStatus: 1 };
  let text = '';
  let exitStatus = 0;
  for (const c of calls) {
    const r = await runCall(copy, c, opts);
    text += r.text;
    if (r.exitStatus !== 0) exitStatus = r.exitStatus;
  }
  return { text, exitStatus };
}
