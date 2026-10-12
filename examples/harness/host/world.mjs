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

// The bash tool is not a shell. It runs one program of a fixed list, from an argv array, and refuses everything else. The list
// is the classifier's table of declared runners (FUSABLE_COMMANDS, HF3.4, S559) plus vitest through node, which is how the
// repositories' own checks run. A command is accepted only when it matches the table whole, so there is no quoting, no pipe,
// no redirection, no substitution, no list and no expansion to parse: a word is made of letters, digits and . / : = @ + - _ only.
// The limit, stated: npm and go run the repository's own scripts and tests, which the agent may have edited, so the program
// that runs is bounded by the list and by the environment of tasks.mjs (no key, offline), not by the list alone.
import { FUSABLE_COMMANDS } from './handlers/classify.mjs';

const WORD = /^[A-Za-z0-9_./:=@+-]+$/;
// Only the runners the tasks use: npm-family test/build/lint, node --test, go test/build/vet. make, cargo, tsc and the Python
// runners of the table stay out (make runs a Makefile, which is a shell).
const ALLOWED = [...FUSABLE_COMMANDS.filter((re) => /^[\^][(]npm[|]|^[\^]node --test|^[\^]go /.test(re.source)), /^node node_modules\/vitest\/vitest\.mjs run( [A-Za-z0-9_./:=@+-]+)*$/];

/**
 * The argv of a bash call, or the reason it is refused. A call is { argv: [...] } or { command: "word word" }, where a command
 * is only words joined by single spaces (a string with any other character is refused, so it cannot hide a shell construct).
 * @returns {{ argv: string[] } | { refused: string }}
 */
export function bashArgv(copy, call) {
  let argv = call.argv;
  if (argv === undefined) {
    if (typeof call.command !== 'string') return { refused: 'a bash call needs argv or command' };
    argv = call.command.split(' ');
  }
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((w) => typeof w === 'string' && WORD.test(w))) {
    return { refused: 'a word holds a character outside letters, digits and . / : = @ + - _ (no shell syntax of any kind)' };
  }
  if (!ALLOWED.some((re) => re.test(argv.join(' ')))) return { refused: `${argv[0]} ${argv[1] ?? ''}`.trim() + ' is not among the declared runners' };
  // node runs a test runner or the repository's vitest, never a script of the agent's choosing by option (-e, -p, --import ...)
  if (argv[0] === 'node' && argv.slice(1).some((w, i) => w.startsWith('-') && !(i === 0 && w === '--test') && !['-t', '--pool=threads', '--reporter=dot'].includes(w))) {
    return { refused: 'node takes no option other than --test' };
  }
  // go runs another program through these options
  if (argv[0] === 'go' && argv.slice(2).some((w) => /^-{1,2}(exec|toolexec|o|overlay|modfile|pkgdir)(=|$)/.test(w))) return { refused: 'go takes no option that names a program or a file out of the package' };
  // a word that is a path stays inside the copy
  for (const w of argv.slice(1)) {
    if (!w.includes('/') && !w.includes('..')) continue;
    if (/^[A-Za-z]:|^[/]/.test(w) || w.split('/').includes('..')) return { refused: `${w} is outside the copy` };
    try {
      inside(copy, w.replace(/(^|[/])[.]{3}$/, '$1_'));  // a Go package pattern ends in /...
    } catch {
      return { refused: `${w} is outside the copy` };
    }
  }
  return { argv };
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
        const v = bashArgv(copy, call);
        if (v.refused) return { text: `refused: ${v.refused}\n`, exitStatus: 1 };
        const [cmd, ...args] = v.argv;
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
