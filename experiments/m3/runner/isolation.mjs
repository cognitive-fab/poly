// What an arm runs with on the owner's subscription (decisions-m3, 4210fa6). The arms run without --bare, which
// accepts only an API key, so their isolation from the owner's own setup comes from three things:
//
//   - CLAUDE_CONFIG_DIR, a dedicated folder outside the repository that holds only the login, a settings.json with
//     DISABLE_AUTOUPDATER=1, and the state the CLI keeps for its own sessions; the runner checks it before each run;
//   - CLAUDE_CODE_DISABLE_CLAUDE_MDS=1: the workspace lives under the owner's home, and the CLI reads every
//     CLAUDE.md above the working directory, the owner's `~/.claude/CLAUDE.md` among them. Measured with a marker
//     before this switch: both reached the model (test/m3-isolation.test.mjs);
//   - CLAUDE_CODE_DISABLE_AUTO_MEMORY=1, so no run leaves a memory another run of the same workspace would read.
//
// And no API billing: the runner refuses to start while ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is set, or when the
// folder's login is not a Claude subscription. The key's value is never printed or recorded, only its name.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

/** The arms' configuration folder, outside the repository. */
export const ARM_CONFIG_DIR = join(homedir(), '.poly-m3', 'claude');

/** The only settings the folder may hold. */
export const SETTINGS = { env: { DISABLE_AUTOUPDATER: '1' } };

/** The login. */
const LOGIN = ['.credentials.json', '.claude.json'];
/**
 * The state the CLI writes for its own sessions, read by no arm as instructions: transcripts (which `--resume`
 * needs), backups of `.claude.json`, caches, logs and telemetry. Anything not listed, here or as the login or the
 * settings, is refused, so a new kind of entry is looked at before it is allowed.
 */
const STATE = new Set(['backups', 'cache', 'debug', 'downloads', 'feedback', 'file-history', 'history.jsonl', 'ide', 'jobs', 'paste-cache', 'plans', 'policy-limits.json', 'policy-limits.json.stamp.json', 'projects', 'session-env', 'sessions', 'shell-snapshots', 'state', 'stats-cache.json', 'statsig', 'telemetry', 'todos', '.last-cleanup', '.last-update-result.json', 'mcp-needs-auth-cache.json', 'daemon', 'daemon.lock', 'daemon.log', 'daemon.status.json']);
/** What would put the owner's or anyone's setup in front of the arm. */
const FORBIDDEN = new Set(['CLAUDE.md', 'CLAUDE.local.md', 'agents', 'commands', 'skills', 'plugins', 'hooks', 'output-styles', 'rules', 'settings.local.json', 'remote-settings.json', 'managed-settings.json', 'keybindings.json']);

/** The environment of an arm's CLI: the runner's own, pointed at the arms' folder, with the owner's CLAUDE.md files and auto memory off. */
export function armEnv(base = process.env, configDir = ARM_CONFIG_DIR) {
  // The account's own setup: logged in to the subscription, the CLI syncs the account's plugins and skills into the
  // folder and loads its claude.ai connectors. Measured after the owner's login, against a local stand-in for the
  // API: 8 plugins and 58 MCP servers (Gmail, Drive and Calendar among them) loaded, and their names reached the
  // model. CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC stops the sync; ENABLE_CLAUDEAI_MCP_SERVERS=false and
  // --strict-mcp-config (agent.mjs) load no MCP server. With all three, the stand-in saw none of them.
  return { ...base, CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false', DISABLE_AUTOUPDATER: '1' };
}

/** Why a run would bill an API key: the variables that are set, by name only. */
export function apiKeyProblems(env = process.env) {
  return ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].filter((k) => env[k]).map((k) => `${k} is set; the runs use the subscription, never an API key (4210fa6)`);
}

const json = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; } };

/** Why the folder is not fit for an arm, or [] when it holds only the login, the settings and the CLI's own state. */
export function configProblems(dir = ARM_CONFIG_DIR) {
  if (!existsSync(dir)) return [`${dir} does not exist`];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (FORBIDDEN.has(name)) out.push(`${name} is in ${dir}`);
    else if (!LOGIN.includes(name) && name !== 'settings.json' && !STATE.has(name) && !/^\.claude\.json\.(backup|corrupted)/.test(name)) out.push(`${name} is in ${dir}, and is neither the login, the settings nor the CLI's own state`);
  }
  if (!existsSync(join(dir, '.credentials.json'))) out.push(`no login in ${dir} (.credentials.json)`);
  if (!isDeepStrictEqual(json(join(dir, 'settings.json')), SETTINGS)) out.push(`settings.json in ${dir} is not exactly ${JSON.stringify(SETTINGS)}`);
  const state = json(join(dir, '.claude.json'));
  if (state === undefined) out.push(`no readable .claude.json in ${dir}`);
  else {
    if (state.mcpServers && Object.keys(state.mcpServers).length) out.push(`.claude.json in ${dir} configures mcpServers`);
    if (state.primaryApiKey || state.apiKeyHelper || state.customApiKeyResponses?.approved?.length) out.push(`.claude.json in ${dir} holds an API key or an apiKeyHelper`);
    for (const [p, v] of Object.entries(state.projects ?? {})) if (v?.mcpServers && Object.keys(v.mcpServers).length) out.push(`.claude.json in ${dir} configures mcpServers for ${p}`);
  }
  // Auto memory is off for the arms; a memory left by anything else is refused rather than read.
  const projects = join(dir, 'projects');
  if (existsSync(projects)) {
    for (const p of readdirSync(projects)) {
      const mem = join(projects, p, 'memory');
      if (existsSync(mem) && statSync(mem).isDirectory() && readdirSync(mem).length) out.push(`a memory is in ${mem}`);
    }
  }
  return out;
}

/** The folder's login as the CLI reports it: { loggedIn, authMethod, subscriptionType }, nothing else. */
export function loginOf(dir = ARM_CONFIG_DIR, bin = 'claude') {
  const env = armEnv(process.env, dir);
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const s = JSON.parse(execFileSync(bin, ['auth', 'status', '--json'], { encoding: 'utf8', env }));
  return { loggedIn: s.loggedIn === true, authMethod: s.authMethod ?? null, subscriptionType: s.subscriptionType ?? null };
}

/** Why the folder's login is not a Claude subscription. */
export function loginProblems(login) {
  if (!login.loggedIn) return ['the arms\' folder is not logged in'];
  if (login.authMethod !== 'claude.ai') return [`the arms' folder is logged in by ${login.authMethod}, not a Claude subscription`];
  return [];
}
