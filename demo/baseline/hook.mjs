#!/usr/bin/env node
// The PreToolUse hook of a baseline run (DB11 item 7). Claude Code runs it before every tool call of the agent. It reads one JSON object on
// standard input (tool_name, tool_input, cwd), takes the workspace from POLY_DEMO_WORKSPACE, asks guard.mjs, and prints one JSON object with
// the decision. It exits 0 and fails closed: a missing workspace, input that is not JSON, or any error is a deny.
import { checkToolCall, isAllowedWithTail, isReadOnlyBash } from './guard.mjs';

const decision = (permissionDecision, permissionDecisionReason) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason },
});

// The Bash patterns of the arm's own tool list, from the same settings the run uses (DB15 item 6). Missing or unreadable is an empty list: nothing is allowed by it.
function allowedBashFromEnv() {
  try {
    const list = JSON.parse(process.env.POLY_DEMO_ALLOWED_BASH ?? '[]');
    return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

let out;
try {
  const workspace = process.env.POLY_DEMO_WORKSPACE;
  if (!workspace) out = decision('deny', 'POLY_DEMO_WORKSPACE is not set, so no path can be shown to be inside the workspace');
  else {
    const call = JSON.parse(await readStdin());
    const verdict = checkToolCall({ tool: call.tool_name, input: call.tool_input ?? {}, workspace, cwd: call.cwd });
    if (!verdict.allow) out = decision('deny', verdict.reason);
    // A Bash command outside the read-only set is not allowed here: the arm's tool list decides it, so the hook says nothing (DB15 item 3).
    else if (call.tool_name === 'Bash') {
      const command = call.tool_input?.command ?? '';
      if (isReadOnlyBash(command, { workspace, cwd: call.cwd })) out = decision('allow', 'a read-only command inside the workspace');
      else if (isAllowedWithTail(command, { workspace, cwd: call.cwd, allowedBash: allowedBashFromEnv() })) out = decision('allow', "a command of the arm's own list, trimmed by head, tail or wc");
      else out = {};
    }
    else out = decision('allow', 'inside the workspace');
  }
} catch (e) {
  out = decision('deny', `the hook could not judge the call: ${e.message}`);
}
process.stdout.write(`${JSON.stringify(out)}\n`);
