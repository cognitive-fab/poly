#!/usr/bin/env node
// The PreToolUse hook of a baseline run (DB11 item 7). Claude Code runs it before every tool call of the agent. It reads one JSON object on
// standard input (tool_name, tool_input, cwd), takes the workspace from POLY_DEMO_WORKSPACE, asks guard.mjs, and prints one JSON object with
// the decision. It exits 0 and fails closed: a missing workspace, input that is not JSON, or any error is a deny.
import { checkToolCall } from './guard.mjs';

const decision = (permissionDecision, permissionDecisionReason) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason },
});

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
    out = verdict.allow ? decision('allow', 'inside the workspace') : decision('deny', verdict.reason);
  }
} catch (e) {
  out = decision('deny', `the hook could not judge the call: ${e.message}`);
}
process.stdout.write(`${JSON.stringify(out)}\n`);
