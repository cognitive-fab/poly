// Claude Code tool call → canonical actions.
//
// Deterministic, no I/O. A tool call becomes one or more actions; a shell
// command chain becomes one action per command in the chain (a gate that only
// looked at the first command would be bypassable with `true && git push`).
// Constructs whose effect cannot be read from the text (eval, $(...),
// interpreters fed inline code, piped scripts) become `shell.opaque` so a
// policy can decide whether opacity is acceptable in its scope.
import { normalizeAction } from '../../core/action.mjs';
import { normPath } from '../../core/expr.mjs';

const OPAQUE_RE = /\$\(|`|\beval\b|\bsource\b|\bexec\b|\bxargs\b|\bbase64\s+(-d|--decode)\b|\/dev\/tcp\/|\bInvoke-Expression\b|\biex\b|\bbash\s+-c\b|\bsh\s+-c\b|\bpwsh\s+-c\b|\bpowershell\s+-c\b/i;
const INTERPRETER_INLINE = /^(python3?|node|ruby|perl|php|deno|bun)\s+(-c|-e|--eval)\b/i;

/** Split a shell command line into simple commands at &&, ||, ;, |, and newlines, honoring quotes. */
export function splitChain(cmd) {
  const out = []; let cur = ''; let q = null; let i = 0;
  const push = () => { const t = cur.trim(); if (t) out.push(t); cur = ''; };
  while (i < cmd.length) {
    const c = cmd[i];
    if (q) { cur += c; if (c === '\\' && q === '"' && i + 1 < cmd.length) { cur += cmd[i + 1]; i += 2; continue; } if (c === q) q = null; i++; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; i++; continue; }
    if (c === '\\' && i + 1 < cmd.length) { cur += c + cmd[i + 1]; i += 2; continue; }
    if (cmd.startsWith('&&', i) || cmd.startsWith('||', i)) { push(); i += 2; continue; }
    if (c === ';' || c === '|' || c === '\n' || (c === '&' && cmd[i + 1] !== '&')) { push(); i++; continue; }
    cur += c; i++;
  }
  push();
  return out;
}

/** Tokenize one simple command into argv (quotes removed), plus redirect targets. */
export function argvOf(simple) {
  const argv = []; const redirects = []; let cur = ''; let q = null; let has = false; let i = 0;
  const flush = () => { if (has) { argv.push(cur); } cur = ''; has = false; };
  while (i < simple.length) {
    const c = simple[i];
    if (q) { if (c === q) { q = null; } else if (c === '\\' && q === '"' && i + 1 < simple.length) { cur += simple[i + 1]; i++; } else cur += c; i++; continue; }
    if (c === '"' || c === "'") { q = c; has = true; i++; continue; }
    if (c === '\\' && i + 1 < simple.length) { cur += simple[i + 1]; has = true; i += 2; continue; }
    if (c === ' ' || c === '\t') { flush(); i++; continue; }
    if (c === '>' ) {
      if (cur.length && /^[0-9]$/.test(cur)) { cur = ''; has = false; } // `2>` is an fd redirect, not an argument
      flush();
      const append = simple[i + 1] === '>';
      i += append ? 2 : 1;
      while (simple[i] === ' ') i++;
      let t = '';
      while (i < simple.length && simple[i] !== ' ' && simple[i] !== '\t') { t += simple[i]; i++; }
      if (t && !t.startsWith('&')) redirects.push({ target: t.replace(/^["']|["']$/g, ''), append });
      continue;
    }
    cur += c; has = true; i++;
  }
  flush();
  // strip leading env assignments and `sudo`/`cd x` are left as-is (cd is its own command)
  while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) argv.shift();
  if (argv[0] === 'sudo') argv.shift();
  return { argv, redirects };
}

function hostOf(url) { try { return url ? new URL(url).hostname.toLowerCase() : null; } catch { return null; } }

function flagValue(argv, names) {
  for (let i = 1; i < argv.length; i++) {
    for (const n of names) {
      if (argv[i] === n) return argv[i + 1] ?? null;
      if (argv[i].startsWith(n + '=')) return argv[i].slice(n.length + 1);
    }
  }
  return null;
}
const positionals = (argv, from = 1) => argv.slice(from).filter((a) => !a.startsWith('-'));

/** One simple command → one canonical action. */
export function classifyCommand(simple, tool = 'Bash') {
  const base = { tool, command: simple };
  if (OPAQUE_RE.test(simple) || INTERPRETER_INLINE.test(simple)) return { ...base, kind: 'shell.opaque', opaque: true, target: simple.slice(0, 80) };
  const { argv, redirects } = argvOf(simple);
  if (!argv.length) return { ...base, kind: 'shell', exe: null, argv: [] };
  const exe = argv[0].replace(/\\/g, '/').split('/').pop().replace(/\.exe$/i, '').toLowerCase();
  const a = { ...base, exe, argv };
  const sub = argv[1] ?? null;

  const primary = classifyArgv(a, exe, argv, sub);
  const real = redirects.filter((r) => !/^(\/dev\/null|nul|&\d)$/i.test(r.target));
  if (!real.length) return primary;
  // a redirect is an extra effect, never a disguise for the command in front of it
  const write = { ...base, kind: 'fs.write', path: real[0].target, paths: real.map((r) => r.target), append: real[0].append, target: real[0].target, redirect: true };
  return Object.assign(primary, { redirects: [write] });
}

function classifyArgv(a, exe, argv, sub) {
  switch (exe) {
    case 'git': {
      switch (sub) {
        case 'push': {
          const pos = positionals(argv, 2);
          let branch = pos[1] ?? null; const remote = pos[0] ?? null;
          if (branch && branch.includes(':')) branch = branch.split(':').pop();
          if (branch === 'HEAD') branch = null;
          const force = argv.some((x) => x === '-f' || x === '--force' || x.startsWith('--force-with-lease'));
          const del = argv.some((x) => x === '-d' || x === '--delete');
          return { ...a, kind: 'vcs.push', remote, branch, force, delete: del, target: branch ?? remote ?? 'push' };
        }
        case 'commit': return { ...a, kind: 'vcs.commit', message: flagValue(argv, ['-m', '--message']), target: 'commit' };
        case 'checkout': case 'switch': return { ...a, kind: 'vcs.checkout', branch: positionals(argv, 2)[0] ?? flagValue(argv, ['-b', '-c']) ?? null, target: positionals(argv, 2)[0] ?? null };
        case 'reset': return { ...a, kind: 'vcs.reset', hard: argv.includes('--hard'), target: positionals(argv, 2)[0] ?? 'HEAD' };
        case 'tag': return { ...a, kind: 'vcs.tag', target: positionals(argv, 2)[0] ?? null };
        case 'merge': case 'rebase': return { ...a, kind: 'vcs.merge', target: positionals(argv, 2)[0] ?? null };
        case 'rm': return { ...a, kind: 'fs.delete', paths: positionals(argv, 2), path: positionals(argv, 2)[0] ?? null };
        case 'mv': { const p = positionals(argv, 2); return { ...a, kind: 'fs.rename', from: p[0] ?? null, to: p[1] ?? null, paths: p, path: p[0] ?? null }; }
        default: return { ...a, kind: 'shell', target: `git ${sub ?? ''}`.trim() };
      }
    }
    case 'gh': {
      if (sub === 'pr' && argv[2] === 'merge') return { ...a, kind: 'vcs.merge', target: positionals(argv, 3)[0] ?? 'pr', via: 'gh' };
      return { ...a, kind: 'shell', target: `gh ${sub ?? ''}`.trim() };
    }
    case 'rm': case 'rmdir': case 'del': case 'erase': case 'remove-item': case 'ri': case 'unlink': case 'shred': {
      const p = positionals(argv);
      return { ...a, kind: 'fs.delete', paths: p, path: p[0] ?? null, recursive: argv.some((x) => /^-[a-zA-Z]*r/i.test(x) || x === '--recursive' || x === '-Recurse') };
    }
    case 'mv': case 'move': case 'move-item': case 'mi': case 'rename': case 'rename-item': case 'ren': {
      const p = positionals(argv); return { ...a, kind: 'fs.rename', from: p[0] ?? null, to: p[1] ?? null, paths: p, path: p[0] ?? null };
    }
    case 'cp': case 'copy': case 'copy-item': case 'cpi': case 'rsync': case 'scp': case 'tee': case 'install': case 'touch': case 'mkdir': case 'new-item': case 'ni': case 'set-content': case 'sc': case 'add-content': case 'out-file': {
      const p = positionals(argv); const dest = ['tee', 'touch', 'mkdir', 'new-item', 'ni', 'set-content', 'sc', 'add-content', 'out-file'].includes(exe) ? (p[0] ?? flagValue(argv, ['-Path', '-FilePath'])) : (p[p.length - 1] ?? null);
      return { ...a, kind: 'fs.write', path: dest, paths: p, target: dest };
    }
    case 'curl': case 'wget': case 'http': case 'https': case 'httpie': case 'invoke-webrequest': case 'iwr': case 'invoke-restmethod': case 'irm': case 'aria2c': {
      const url = argv.slice(1).find((x) => /^https?:\/\//i.test(x)) ?? flagValue(argv, ['-Uri', '--url']) ?? null;
      const method = (flagValue(argv, ['-X', '--request', '-Method']) ?? (argv.some((x) => ['-d', '--data', '--data-binary', '-F', '--form', '-T', '--upload-file', '-Body'].includes(x)) ? 'POST' : 'GET')).toUpperCase();
      const download = exe === 'wget' || exe === 'aria2c' || argv.some((x) => x === '-o' || x === '-O' || x === '--output' || x === '-OutFile' || x === '--remote-name');
      const headers = []; for (let i = 1; i < argv.length; i++) if (argv[i] === '-H' || argv[i] === '--header') headers.push(argv[i + 1] ?? '');
      return { ...a, kind: 'http.request', url, host: hostOf(url), method, download, headers, upload: argv.some((x) => ['-T', '--upload-file', '-F', '--form', '--data-binary'].includes(x)), target: url };
    }
    case 'ssh': case 'nc': case 'ncat': case 'netcat': case 'telnet': case 'ftp': case 'sftp':
      return { ...a, kind: 'http.request', url: null, host: positionals(argv)[0]?.split('@').pop() ?? null, method: exe.toUpperCase(), target: positionals(argv)[0] ?? null };
    case 'npm': case 'pnpm': case 'yarn': case 'npx': case 'bun': {
      if (['install', 'i', 'add', 'ci'].includes(sub) || exe === 'npx') return { ...a, kind: 'package.install', manager: exe, packages: positionals(argv, 2), target: positionals(argv, 2)[0] ?? sub };
      if (sub === 'publish') return { ...a, kind: 'custom.publish', manager: exe, target: 'publish' };
      if (sub === 'test' || sub === 't') return { ...a, kind: 'process.run', target: 'test', script: 'test' };
      if (sub === 'run') return { ...a, kind: 'process.run', target: argv[2] ?? null, script: argv[2] ?? null };
      return { ...a, kind: 'process.run', target: sub };
    }
    case 'pip': case 'pip3': case 'uv': case 'poetry': case 'cargo': case 'go': case 'gem': case 'brew': case 'apt': case 'apt-get': case 'choco': case 'winget': {
      if (['install', 'add', 'get'].includes(sub)) return { ...a, kind: 'package.install', manager: exe, packages: positionals(argv, 2), target: positionals(argv, 2)[0] ?? sub };
      if (sub === 'test') return { ...a, kind: 'process.run', target: 'test' };
      if (sub === 'publish' || sub === 'push') return { ...a, kind: 'custom.publish', manager: exe, target: sub };
      return { ...a, kind: 'process.run', target: sub ?? exe };
    }
    case 'pytest': case 'jest': case 'vitest': case 'mocha': case 'gradlew': case 'gradle': case 'mvn': case 'make': case 'dotnet': case 'ctest': {
      const isTest = exe === 'pytest' || exe === 'jest' || exe === 'vitest' || exe === 'mocha' || exe === 'ctest' || argv.includes('test');
      return { ...a, kind: 'process.run', target: isTest ? 'test' : (sub ?? exe), script: sub ?? null };
    }
    case 'docker': case 'kubectl': case 'helm': case 'terraform': case 'pulumi': case 'aws': case 'gcloud': case 'az': case 'vercel': case 'fly': case 'heroku':
      return { ...a, kind: 'process.run', target: `${exe} ${sub ?? ''}`.trim(), infra: true };
    case 'cat': case 'head': case 'tail': case 'less': case 'more': case 'type': case 'get-content': case 'gc':
      return { ...a, kind: 'fs.read', path: positionals(argv)[0] ?? null, paths: positionals(argv), target: positionals(argv)[0] ?? null };
    case 'ls': case 'dir': case 'find': case 'grep': case 'rg': case 'ag': case 'fd': case 'tree': case 'get-childitem': case 'gci': case 'select-string': case 'sls': case 'pwd': case 'which': case 'where':
      return { ...a, kind: 'fs.search', target: positionals(argv)[0] ?? null };
    case 'sed': case 'awk': case 'perl':
      if (argv.includes('-i') || argv.some((x) => x.startsWith('-i'))) return { ...a, kind: 'fs.write', path: positionals(argv).pop() ?? null, target: positionals(argv).pop() ?? null, inplace: true };
      return { ...a, kind: 'shell', target: exe };
    case 'python': case 'python3': case 'node': case 'ruby': case 'deno': case 'php':
      return { ...a, kind: 'process.run', target: positionals(argv)[0] ?? exe, script: positionals(argv)[0] ?? null, interpreter: exe };
    default:
      return { ...a, kind: 'shell', target: exe };
  }
}

/** Claude Code hook payload → list of canonical actions. */
export function extractActions(toolName, toolInput = {}, opts = {}) {
  const tool = String(toolName ?? '');
  const inp = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const cwd = opts.cwd ?? null;
  const rel = (p) => (typeof p === 'string' ? relPath(p, cwd) : null);
  let actions;
  switch (tool) {
    case 'Bash': case 'PowerShell': {
      const cmd = String(inp.command ?? '');
      actions = splitChain(cmd).flatMap((c) => { const x = classifyCommand(c, tool); const { redirects, ...main } = x; return redirects ? [main, ...redirects] : [main]; });
      if (!actions.length) actions = [{ kind: 'shell', tool, command: cmd, exe: null, argv: [] }];
      for (const a of actions) { if (a.path) a.path = rel(a.path); if (a.paths) a.paths = a.paths.map(rel); if (a.from) a.from = rel(a.from); if (a.to) a.to = rel(a.to); }
      break;
    }
    case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      actions = [{ kind: 'fs.write', tool, path: rel(inp.file_path ?? inp.notebook_path), content: inp.new_string ?? inp.new_source ?? null, edit: true }];
      break;
    case 'Write':
      actions = [{ kind: 'fs.write', tool, path: rel(inp.file_path), content: typeof inp.content === 'string' ? inp.content : null, edit: false }];
      break;
    case 'Read':
      actions = [{ kind: 'fs.read', tool, path: rel(inp.file_path) }];
      break;
    case 'Glob': case 'Grep': case 'LSP':
      actions = [{ kind: 'fs.search', tool, path: rel(inp.path ?? null), pattern: inp.pattern ?? null }];
      break;
    case 'WebFetch':
      actions = [{ kind: 'http.request', tool, url: inp.url ?? null, method: 'GET', download: false, upload: false }];
      break;
    case 'WebSearch':
      actions = [{ kind: 'web.search', tool, query: inp.query ?? null, target: inp.query ?? null }];
      break;
    case 'Task': case 'Agent':
      actions = [{ kind: 'agent.spawn', tool, agent: inp.subagent_type ?? null, target: inp.subagent_type ?? inp.description ?? null, prompt: typeof inp.prompt === 'string' ? inp.prompt.slice(0, 2000) : null }];
      break;
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(tool);
      if (m) actions = [{ kind: 'mcp.call', tool, server: m[1], name: m[2], args: inp, target: `${m[1]}/${m[2]}` }];
      else actions = [{ kind: 'tool.call', tool, name: tool, args: inp, target: tool }];
    }
  }
  return actions.map((a) => normalizeAction({ ...a, raw: opts.keepRaw ? inp : undefined }));
}

/** Make an absolute path relative to cwd when it is under it; normalize either way. */
export function relPath(p, cwd) {
  if (typeof p !== 'string' || !p) return null;
  const n = normPath(p);
  if (cwd) {
    const c = normPath(cwd).replace(/\/$/, '');
    if (n === c) return '.';
    if (n.startsWith(c + '/')) return n.slice(c.length + 1);
  }
  return n;
}
