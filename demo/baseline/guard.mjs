// The confinement of a baseline run (DB11): no tool call may touch a path outside the run's own workspace, and four tools are never allowed.
// checkToolCall reads one tool call (its name and its input); the hook runs it before each call, and auditEscapes runs it again over the
// saved session after the run. It reads inputs. It does not read what a program the agent wrote does when it runs (DB11 item 6).
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** Tools no arm may use (DB11 item 2): a second agent, a web fetch, a web search. */
export const DISALLOWED_TOOLS = ['Agent', 'Task', 'WebFetch', 'WebSearch'];

const WIN = process.platform === 'win32';
const P = WIN ? path.win32 : path.posix;

/** Names the null device and its kin: a redirect to them touches nothing. */
const HARMLESS = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr', 'nul', 'NUL']);

/** C:\x, C:/x and /c/x name one place on Windows. */
function toNative(p) {
  if (!WIN) return p;
  const git = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(p);
  return git ? `${git[1].toUpperCase()}:/${git[2] ?? ''}` : p;
}

/** The real path of the longest existing prefix of an absolute path, with the rest appended. A link that leaves the workspace shows here. */
function realPrefix(abs) {
  const rest = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      return rest.length ? P.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = P.dirname(cur);
      if (parent === cur) return abs;
      rest.push(P.basename(cur));
      cur = parent;
    }
  }
}

const resolveFrom = (base, p) => realPrefix(P.resolve(base, toNative(p)));

function inside(workspaceReal, abs) {
  const rel = P.relative(workspaceReal, abs);
  if (rel === '') return true;
  if (P.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${P.sep}`);
}

/** Checks one path string. Returns null when it is inside, otherwise the offending text. */
function pathProblem(ctx, text, base = ctx.cwd) {
  if (HARMLESS.has(text)) return null;
  if (/^~/.test(text)) return text;
  return inside(ctx.workspaceReal, resolveFrom(base, text)) ? null : text;
}

const HOME_WORD = /(?:^|[^\w])(?:~(?:[\\/]|$)|\$\{?HOME\}?|\$\{?USERPROFILE\}?|%USERPROFILE%)/i;
const URL_WORD = /^[a-z][a-z0-9+.-]*:\/\//i;
const PATH_LIKE = /[\\/]|^\.\.?$|^~|^[A-Za-z]:(?:[\\/]|$)/;
/** An absolute path of two segments or more (/c/Users, /proc/self/environ, /etc/hosts), found inside quoted code or arguments: outside the workspace by definition. */
const ROOT_IN_TEXT = /(?:^|[\s'"=(,])(\/(?:[a-zA-Z]|[\w.-]+)\/[^\s'"`)]*)/g;
const DRIVE_IN_TEXT = /(?<![\w])[A-Za-z]:[\\/][^\s'"`)]*/g;
const DOTDOT_IN_TEXT = /(?:^|[\s'"=(,])(\.\.[\\/][^\s'"`)]*)/g;
const HOME_IN_TEXT = /(?:^|[\s'"=(,])(~\/[^\s'"`)]*)/g;

/** Splits a command the way a shell does: words (with whether they were quoted) in segments separated by operators. */
function splitCommand(command) {
  const segments = [[]];
  let word = '';
  let has = false;
  let quoted = false;
  const endWord = () => {
    if (has) segments.at(-1).push({ text: word, quoted });
    word = ''; has = false; quoted = false;
  };
  const endSegment = () => { endWord(); if (segments.at(-1).length) segments.push([]); };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end < 0 ? command.length : end;
      word += command.slice(i + 1, stop); has = true; quoted = true; i = stop;
    } else if (c === '"') {
      let j = i + 1;
      let chunk = '';
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\' && command[j + 1] === '"') { chunk += '"'; j += 2; } else chunk += command[j++];
      }
      word += chunk; has = true; quoted = true; i = j;
    } else if (/\s/.test(c)) {
      if (c === '\n') endSegment(); else endWord();
    } else if (c === '&' || c === '|' || c === ';' || c === '(' || c === ')' || c === '<' || c === '>' || c === '`') {
      endSegment();
    } else if (c === '$' && command[i + 1] === '(') {
      endSegment(); i++;
    } else { word += c; has = true; }
  }
  endWord();
  return segments.filter((s) => s.length);
}

function checkBash(ctx, command) {
  const offending = [];
  const note = (text) => { if (text && !offending.includes(text)) offending.push(text); };
  let cwd = ctx.cwd;
  for (const segment of splitCommand(command)) {
    const cd = (segment[0]?.text === 'cd' || segment[0]?.text === 'pushd') ? segment[0].text : null;
    if (cd && segment.length === 1) note(`${cd} (to the home folder)`);
    for (const [index, { text }] of segment.entries()) {
      if (cd && index === 0) continue;
      if (HOME_WORD.test(text)) { note(text); continue; }
      let value = text;
      const flag = /^(?:-{1,2}[\w-]+|[A-Za-z_]\w*)=(.*)$/s.exec(text);
      if (flag) value = flag[1];
      // One path per word: the word itself, after a flag= or a NAME= prefix.
      if (value && !URL_WORD.test(value) && PATH_LIKE.test(value) && !/\s/.test(value)) note(pathProblem({ ...ctx, cwd }, value, cwd));
      // Code and prose can hold paths too (node -e "...", a quoted argument): the places named inside any word.
      for (const m of text.matchAll(DRIVE_IN_TEXT)) note(pathProblem({ ...ctx, cwd }, m[0], cwd));
      for (const m of text.matchAll(DOTDOT_IN_TEXT)) note(pathProblem({ ...ctx, cwd }, m[1], cwd));
      for (const re of [ROOT_IN_TEXT, HOME_IN_TEXT]) for (const m of text.matchAll(re)) if (!HARMLESS.has(m[1])) note(m[1]);
    }
    if (cd && segment.length > 1) {
      const target = segment[1].text;
      cwd = P.resolve(cwd, toNative(target));
    }
  }
  return { offending, cwd };
}

/** The part of a glob before its first wildcard, cut back to the last separator. */
function staticPrefix(pattern) {
  const at = pattern.search(/[*?[{]/);
  if (at < 0) return pattern;
  const head = pattern.slice(0, at);
  const cut = Math.max(head.lastIndexOf('/'), head.lastIndexOf('\\'));
  return cut < 0 ? '' : head.slice(0, cut + 1);
}

const DOTDOT_SEGMENT = /(?:^|[\\/{,])\.\.(?:[\\/},]|$)/;

/**
 * Checks one tool call. `workspace` is absolute; `cwd` is where relative paths start (the workspace by default).
 * Returns { allow: true } or { allow: false, reason, offending }.
 */
export function checkToolCall(call) {
  return evaluate(call).verdict;
}

/** checkToolCall, and the folder a Bash command leaves the shell in (the next command starts there). */
function evaluate({ tool, input = {}, workspace, cwd }) {
  if (typeof workspace !== 'string' || !P.isAbsolute(toNative(workspace))) throw new Error(`the workspace must be an absolute path: ${workspace}`);
  const deny = (reason, offending) => ({ allow: false, reason, offending });
  if (DISALLOWED_TOOLS.includes(tool)) return { verdict: deny(`the ${tool} tool is not allowed in a baseline run`, [tool]), cwd };
  const ctx = { workspaceReal: realPrefix(P.resolve(toNative(workspace))) };
  ctx.cwd = cwd ? P.resolve(ctx.workspaceReal, toNative(cwd)) : ctx.workspaceReal;
  const offending = [];
  const note = (text) => { if (text) offending.push(text); };

  for (const field of ['file_path', 'notebook_path']) {
    if (typeof input[field] === 'string') note(pathProblem(ctx, input[field]));
  }
  const base = typeof input.path === 'string' ? resolveFrom(ctx.cwd, input.path) : ctx.cwd;
  if (typeof input.path === 'string') note(pathProblem(ctx, input.path));
  for (const field of tool === 'Glob' ? ['pattern'] : tool === 'Grep' ? ['glob'] : []) {
    const pattern = input[field];
    if (typeof pattern !== 'string') continue;
    if (DOTDOT_SEGMENT.test(pattern)) { note(pattern); continue; }
    const prefix = staticPrefix(pattern);
    if (prefix) note(pathProblem(ctx, prefix, base));
  }
  let after = ctx.cwd;
  if (tool === 'Bash' && typeof input.command === 'string') {
    const bash = checkBash(ctx, input.command);
    offending.push(...bash.offending);
    after = bash.cwd;
  }

  if (offending.length) return { verdict: deny(`${tool} names a place outside the workspace ${workspace}: ${offending.join(', ')}`, offending), cwd: ctx.cwd };
  return { verdict: { allow: true }, cwd: after };
}

/**
 * Reads a saved session and checks every tool call in it, the way the hook did. `escaped` if any call is denied, including a call the hook
 * refused in the run, because the run tried it (DB11 item 10).
 */
export function auditEscapes(sessionFile, workspace) {
  const calls = [];
  // The shell keeps its folder between commands, and the hook was told that folder with each call: the audit follows it too.
  let cwd;
  for (const line of readFileSync(sessionFile, 'utf8').split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== 'assistant') continue;
    for (const part of event.message?.content ?? []) {
      if (part?.type !== 'tool_use') continue;
      const { verdict, cwd: next } = evaluate({ tool: part.name, input: part.input ?? {}, workspace, cwd });
      if (verdict.allow && part.name === 'Bash') cwd = next;
      if (!verdict.allow) calls.push({ tool: part.name, reason: verdict.reason, offending: verdict.offending, excerpt: JSON.stringify(part.input ?? {}).slice(0, 200) });
    }
  }
  return { status: calls.length ? 'escaped' : 'clean', calls };
}
