// `polyaxion install --claude-code`: the five-minute mount.
//
// Writes, idempotently and atomically (tmp + rename, other entries preserved):
//   .mcp.json                         the advisory mount (four MCP tools)
//   .claude/settings.json             the mandatory mount (hooks)
//   .polyaxion/config.json            scope, port, policy files
//   polyaxion.policy.json             a starter policy (only if absent)
//   .gitignore                        state dir ignored
//
// Transport: "http" hooks to the gate process (no per-call process spawn;
// measured node start-up on the reference machine is ~1.7 s, which no one
// leaves switched on). With --strict, "command" hooks are written instead —
// slower, but a dead gate then fails closed at the host.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, portForProject } from '../../daemon.mjs';

const BIN = resolve(fileURLToPath(new URL('../../../bin/polyaxion.mjs', import.meta.url)));
const MARK = 'polyaxion';

function readJson(p, fallback) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeJsonAtomic(p, obj) {
  mkdirSync(join(p, '..'), { recursive: true });
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, p);
}

const isOurs = (h) => (h.type === 'http' && /\/hooks\/[A-Za-z]+$/.test(h.url ?? '') && /127\.0\.0\.1:\d+\/hooks\//.test(h.url)) || (h.type === 'command' && /polyaxion/i.test(h.command ?? '') && /\bhook\b/.test(h.command ?? ''));

/** What the hooks cannot see (spec 07 §8): the host's own startup subprocesses. Printed at install so the gap is named, not implied away. */
export const OUTSIDE_THE_MOUNT = 'The hooks gate the tool calls the model makes. The startup commands the host runs itself (e.g. `git status` for context, before the trust prompt) never cross a hook: a repository that arrived as files with a .git/config naming a command (core.fsmonitor and settings of its kind) runs it as you. Inspect .git/config before opening a folder you did not clone yourself; run host-side git with -c core.fsmonitor=false.';

export function hookWiring({ port, strict, command, token = true }) {
  // with tokens (06 §1.6): SessionStart is a command hook that mints the session token into CLAUDE_ENV_FILE; the http hooks carry it in a header the host interpolates
  const cmd = (event, timeout) => ({ type: 'command', command: `${command} hook ${event}`, timeout });
  const mk = (event, timeout = 10) => strict
    ? cmd(event, timeout)
    : token
      ? { type: 'http', url: `http://127.0.0.1:${port}/hooks/${event}`, headers: { Authorization: 'Bearer $POLYAXION_HOOK_TOKEN' }, allowedEnvVars: ['POLYAXION_HOOK_TOKEN'], timeout }
      : { type: 'http', url: `http://127.0.0.1:${port}/hooks/${event}`, timeout };
  return {
    SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [strict || token ? cmd('SessionStart', 30) : mk('SessionStart', 30)] }],
    UserPromptSubmit: [{ hooks: [mk('UserPromptSubmit')] }],
    PreToolUse: [{ matcher: '.*', hooks: [mk('PreToolUse')] }],
    PostToolUse: [{ matcher: '.*', hooks: [mk('PostToolUse')] }],
    PreCompact: [{ matcher: 'manual|auto', hooks: [mk('PreCompact')] }],
    Stop: [{ hooks: [mk('Stop', 30)] }],
    SessionEnd: [{ hooks: [mk('SessionEnd', 5)] }],
  };
}

function mergeHooks(existing = {}, wiring) {
  const out = { ...existing };
  for (const [event, groups] of Object.entries(wiring)) {
    const kept = (out[event] ?? []).map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) })).filter((g) => g.hooks.length);
    out[event] = kept.concat(groups);
  }
  return out;
}

export const STARTER_POLICY = (scope) => ({
  polyaxion: '1',
  id: `${scope}/baseline`,
  version: '1',
  scope: `${scope}/**`,
  description: 'Starter policy written by `polyaxion install`. Edit freely; the gate reloads it on the next session start.',
  obligations: [
    { id: 'no-direct-push-main', kind: 'rule', severity: 'deny', text: 'Do not push directly to main or master.',
      when: "action.kind == 'vcs.push'", require: "!((action.branch ?? '') in ['main', 'master'])",
      hint: 'Push a feature branch and open a pull request.' },
    { id: 'no-force-push', kind: 'rule', severity: 'deny', text: 'Never force-push.',
      when: "action.kind == 'vcs.push'", require: '(action.force ?? false) == false' },
    { id: 'no-opaque-shell', kind: 'rule', severity: 'warn', text: 'Avoid shell constructs whose effect cannot be read from the command text (eval, $(…), inline interpreter code).',
      when: "action.kind == 'shell.opaque'", require: 'false' },
    { id: 'tests-before-publish', kind: 'machine', severity: 'deny', text: 'After changing source, run the tests before publishing or deploying.',
      machine: {
        states: ['clean', 'dirty', 'tested'], initial: 'clean',
        transitions: [
          { from: '*', when: "action.kind == 'fs.write' && !glob(action.path ?? '', '**/*.md')", to: 'dirty' },
          { from: 'dirty', when: "action.kind == 'process.run' && action.target == 'test'", to: 'tested' },
        ],
        guards: [{ in: ['dirty'], when: "action.kind == 'custom.publish' || (action.kind == 'process.run' && (action.infra ?? false) == true)", reason: 'untested-changes' }],
      } },
    { id: 'read-project-docs', kind: 'recalled', text: 'Before starting a task, read CLAUDE.md and any docs it points to.' },
  ],
});

/**
 * @param {string} projectDir
 * @param {object} opts {port?, strict?, command?, scope?, dryRun?, token?: boolean (default true)}
 */
export function install(projectDir, opts = {}) {
  const dir = resolve(projectDir);
  const cfg = loadConfig(dir, { port: opts.port, scope: opts.scope });
  const port = opts.port ?? cfg.port ?? portForProject(dir);
  const scope = opts.scope ?? cfg.scope;
  const command = opts.command ?? `node "${BIN}"`;
  const changes = [];

  // .polyaxion/config.json
  const cfgPath = join(dir, '.polyaxion', 'config.json');
  const token = opts.token !== false;
  const cfgDoc = { ...readJson(cfgPath, {}), scope, port, policies: cfg.policies, recall_on_prompt: cfg.recall_on_prompt, recall_on_compact: cfg.recall_on_compact, enforce_end_on_stop: cfg.enforce_end_on_stop, hook_token: token ? 'require' : 'off' };
  changes.push({ file: cfgPath, doc: cfgDoc });

  // .mcp.json
  const mcpPath = join(dir, '.mcp.json');
  const mcp = readJson(mcpPath, {});
  mcp.mcpServers = { ...(mcp.mcpServers ?? {}), [MARK]: { type: 'stdio', command: 'node', args: [BIN, 'serve', '--project', dir] } };
  changes.push({ file: mcpPath, doc: mcp });

  // .claude/settings.json
  const setPath = join(dir, '.claude', 'settings.json');
  const settings = readJson(setPath, {});
  settings.hooks = mergeHooks(settings.hooks, hookWiring({ port, strict: !!opts.strict, command, token }));
  changes.push({ file: setPath, doc: settings });

  // starter policy
  const polPath = join(dir, cfg.policies[0] ?? 'polyaxion.policy.json');
  if (!existsSync(polPath)) changes.push({ file: polPath, doc: STARTER_POLICY(scope) });

  if (!opts.dryRun) {
    for (const c of changes) writeJsonAtomic(c.file, c.doc);
    const gi = join(dir, '.gitignore');
    const cur = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
    if (!/^\.polyaxion\/\*\.sqlite/m.test(cur)) writeFileSync(gi, cur + (cur.endsWith('\n') || !cur ? '' : '\n') + '.polyaxion/*.sqlite*\n.polyaxion/token\n');
  }
  return { projectDir: dir, port, scope, strict: !!opts.strict, hook_token: token ? 'require' : 'off', files: changes.map((c) => c.file), url: `http://127.0.0.1:${port}`, outside_the_mount: OUTSIDE_THE_MOUNT };
}

export function uninstall(projectDir) {
  const dir = resolve(projectDir);
  const mcpPath = join(dir, '.mcp.json');
  const mcp = readJson(mcpPath, null);
  if (mcp?.mcpServers?.[MARK]) { delete mcp.mcpServers[MARK]; writeJsonAtomic(mcpPath, mcp); }
  const setPath = join(dir, '.claude', 'settings.json');
  const settings = readJson(setPath, null);
  if (settings?.hooks) {
    for (const ev of Object.keys(settings.hooks)) {
      settings.hooks[ev] = settings.hooks[ev].map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) })).filter((g) => g.hooks.length);
      if (!settings.hooks[ev].length) delete settings.hooks[ev];
    }
    if (!Object.keys(settings.hooks).length) delete settings.hooks;
    writeJsonAtomic(setPath, settings);
  }
  return { projectDir: dir, removed: true };
}
