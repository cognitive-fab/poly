// The audit of a saved session, in three statuses (DB17 items 7 and 8, finding H6 and the kept runs). An escape is a call that names a place outside
// its workspace, or a tool that is not allowed. It is `escaped` if it ran, and `attempted` if the hook refused it (the result in the session says so): the
// run is invalid only for the first. `refused` is a call inside the workspace that was refused, by the guard (the pipe rule of DB15 item 1) or by the
// arm's tool list (the permission mode said no). A refusal is listed and does not mark the run: poly-pilot-2 never left its workspace, and
// auditEscapes called it escaped for a pipe into grep.
//
// This file reads the verdicts of guard.mjs and does not edit it, so the hash of the guard (and the hook) that a run records stays the one the
// pre-registration names (DB13 item 6). The guard's own audit follows the folder the shell is left in between commands; to use that without
// copying it, each tool call of a rewritten copy of the session carries its id as its first input field, which the guard ignores, and the
// denied calls it lists are read back by that id. The session file itself is never written.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { auditEscapes } from './guard.mjs';

/** What Claude Code's permission mode answers when a tool list does not allow a call (seen in every recorded session). */
/** What the hook answers when it refuses a call (seen in every session made under the hook). */
const HOOK_REFUSAL = /^PreToolUse:.*hook error/;
const TOOL_LIST_REFUSAL = /^Permission to use \S+ has been denied because Claude Code is running in don't ask mode/;
/** The reasons of the guard that mean leaving: a place outside the workspace, or a tool that is never allowed. */
const LEAVES = /names a place outside the workspace|is not allowed in a baseline run/;
const ID_FIELD = '__audit_id';
const NOTE_MSYS = 'guard false positive: MSYS path';
const NOTE_WORD = 'guard false positive: non-path word';

/** A path as text for a comparison: one kind of separator, no trailing one, the case ignored (the run platform is Windows). */
const alike = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
/** An MSYS path /c/rest as the drive path C:/rest; anything else as it is. */
const fromMsys = (p) => p.replace(/^\/([A-Za-z])(?=\/|$)/, (_, drive) => `${drive.toUpperCase()}:`);
/** Whether `item` is the workspace, or a place inside it, once MSYS is converted. */
const insideWorkspace = (item, workspace) => {
  // . and .. are resolved first: /c/ws/run/../x is not inside /c/ws/run.
  const a = posix.normalize(alike(fromMsys(item)));
  const w = posix.normalize(alike(fromMsys(workspace)));
  return a === w || a.startsWith(`${w}/`);
};

/**
 * Whether `item` is a word of the command line itself: it is still a word once every heredoc body and every quoted string is taken out. A bare drive
 * that is a word of the command line (cd D:) names a drive. When the call is not a Bash command, the item is the input itself.
 */
function remainsAsWord(command, item) {
  if (typeof command !== 'string') return true;
  const bare = command
    // The body goes, with the operator and its delimiter; the rest of the opener line stays (it is part of the command line).
    .replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\2(?=\n|$)/g, ' $3')
    // A quoted string goes, unless it is exactly the item: bash removes the quotes, so cd "D:" names a drive.
    .replace(/'([^']*)'|"((?:[^"\\]|\\.)*)"/g, (_, single, double) => ((single ?? double) === item ? ` ${item} ` : ' '));
  return bare.split(/[\s;&|()<>]+/).includes(item);
}

/**
 * Judges a call that the guard denied (DB17 item 7). `escape` is true for a disallowed tool, or if any place the denial names is outside the
 * workspace once an MSYS path is converted. The places the denial names are the items of its first clause; what the pipe rule adds is not one.
 * Otherwise the call is a guard refusal with a note for the shapes of the guard that are not escapes: the workspace in MSYS form, and a bare
 * letter and colon (`i:`) that is not path-shaped.
 */
function judge(call, workspace, command) {
  if (!LEAVES.test(call.reason)) return { escape: false };
  if (/is not allowed in a baseline run/.test(call.reason)) return { escape: true };
  const head = call.reason.split('; ')[0];
  const prefix = `names a place outside the workspace ${workspace}: `;
  const at = head.indexOf(prefix);
  // The items of the first clause, found in the guard's list in order (the list is those items followed by the pipe sinks).
  const tail = at < 0 ? '' : head.slice(at + prefix.length);
  const items = [];
  for (const offending of call.offending) {
    const joined = [...items, offending].join(', ');
    if (!tail.startsWith(joined)) break;
    items.push(offending);
    if (joined === tail) break;
  }
  if (items.length === 0) return { escape: true };
  let msys = false;
  let word = false;
  for (const item of items) {
    if (/^\/[A-Za-z]\/./.test(item) && insideWorkspace(item, workspace)) msys = true;
    // The MSYS option form of a Windows tool (taskkill //F //IM node.exe) is not a path, whether or not it is a word of the command line.
    else if (/^\/\/[A-Z]{1,3}$/.test(item)) word = true;
    else if (/^[A-Za-z]:$/.test(item) && !remainsAsWord(command, item)) word = true;
    else return { escape: true };
  }
  return { escape: false, note: [msys ? NOTE_MSYS : null, word ? NOTE_WORD : null].filter(Boolean).join('; ') };
}

const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => c?.text ?? '').join('') : '');
const excerptOf = (input) => JSON.stringify(input ?? {}).slice(0, 200);

/** The events of a session file, in order; a line that is not JSON is skipped, as the guard's audit does. */
function events(file) {
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    try { out.push(JSON.parse(line)); } catch { /* not an event */ }
  }
  return out;
}

/**
 * Audits a session. Returns { status, escaped, refused, calls }: `status` is `escaped` if `escaped` is not empty, otherwise `clean`; `calls` is
 * `escaped` (the field DB12 already had). Every entry is { tool, reason, offending, excerpt }; a `refused` entry also has `by`, `guard` or `tool-list`.
 */
export function auditRun(sessionFile, workspace) {
  const uses = [];
  const refusals = new Map();
  const hookRefused = new Map();
  const tagged = [];
  for (const event of events(sessionFile)) {
    const content = event?.message?.content;
    if (!Array.isArray(content)) continue;
    const copy = [];
    for (const part of content) {
      if (event.type === 'assistant' && part?.type === 'tool_use') {
        uses.push({ id: part.id, tool: part.name, input: part.input ?? {} });
        // The audit's number goes first, and a field of that name in the model's own input is dropped, so that it cannot change which call a verdict belongs to (DB17 item 9).
        const { [ID_FIELD]: _forged, ...own } = part.input ?? {};
        copy.push({ ...part, input: { [ID_FIELD]: uses.length - 1, ...own } });
      } else {
        copy.push(part);
        // A result is a refusal only if it is an error: the same words in the output of a call that ran are not one (DB17 item 9).
        if (event.type === 'user' && part?.type === 'tool_result' && part.is_error === true) {
          const text = textOf(part.content);
          if (TOOL_LIST_REFUSAL.test(text)) refusals.set(part.tool_use_id, text.split('\n')[0]);
          if (HOOK_REFUSAL.test(text)) hookRefused.set(part.tool_use_id, text.split('\n')[0]);
        }
      }
    }
    if (event.type === 'assistant') tagged.push({ ...event, message: { ...event.message, content: copy } });
  }

  const dir = mkdtempSync(join(tmpdir(), 'baseline-audit-'));
  const denied = new Map();
  try {
    const copyFile = join(dir, 'session.jsonl');
    writeFileSync(copyFile, tagged.map((e) => JSON.stringify(e)).join('\n'));
    for (const call of auditEscapes(copyFile, workspace).calls) denied.set(Number(new RegExp(`"${ID_FIELD}":(\\d+)`).exec(call.excerpt)[1]), call);
  } finally { rmSync(dir, { recursive: true, force: true }); }

  const escaped = [];
  const attempted = [];
  const refused = [];
  for (const [index, use] of uses.entries()) {
    const call = denied.get(index);
    const excerpt = excerptOf(use.input);
    const verdict = call ? judge(call, workspace, use.input?.command) : null;
    if (verdict?.escape) (hookRefused.has(use.id) || refusals.has(use.id) ? attempted : escaped).push({ tool: use.tool, reason: call.reason, offending: call.offending, excerpt });
    else if (call) refused.push({ tool: use.tool, reason: call.reason, offending: call.offending, excerpt, by: 'guard', ...(verdict.note ? { note: verdict.note } : {}) });
    else if (hookRefused.has(use.id)) refused.push({ tool: use.tool, reason: hookRefused.get(use.id), offending: [], excerpt, by: 'hook' });
    else if (refusals.has(use.id)) refused.push({ tool: use.tool, reason: refusals.get(use.id), offending: [], excerpt, by: 'tool-list' });
  }
  return { status: escaped.length ? 'escaped' : attempted.length ? 'attempted' : 'clean', escaped, attempted, refused, calls: escaped };
}
