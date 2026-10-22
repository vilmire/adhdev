import path from 'node:path';

/**
 * PURE process-tree analysis for the worker background-work guard.
 *
 * This module never touches the OS: it receives an already-read process table
 * and classifies it. Reading the table is `process-table-snapshot.ts`'s job and
 * is fully asynchronous, throttled and shared across sessions — the daemon's
 * main loop must never wait on `ps` / PowerShell. There is deliberately no
 * default table here (and no `*Sync` process call anywhere on this path); a
 * source-shape guard in the tests fails if one is reintroduced.
 */

export interface ProcessNodeInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly comm: string;
  readonly args?: string;
  /**
   * Epoch ms the process started, when the platform query reports it (POSIX
   * `etime`, Windows `CreationDate`). Undefined = unknown, never "old".
   */
  readonly startedAtMs?: number;
  /**
   * Cumulative CPU time (user+system) the process has consumed, in ms, when the
   * platform query reports it (POSIX `ps time=`, Linux /proc utime+stime,
   * Windows Win32_Process Kernel+UserModeTime). Undefined = unknown, never 0.
   */
  readonly cpuTimeMs?: number;
}

export interface ProcessTreeExclusionRule {
  readonly id:
    | 'root_pty_and_cli_harness'
    | 'mcp_server_helper'
    | 'language_server_and_code_intel'
    | 'cli_internal_sidecar_and_watcher'
    | 'self_inspection_probe';
  readonly reason: string;
  readonly examples: readonly string[];
}

/**
 * Documented exclusions when inspecting a worker session's OS process tree
 * from its PTY root PID. Each exclusion is recorded with why ignoring it is
 * safe and does not mask user/worker-started background commands.
 *
 * Matching is by process IDENTITY and ANCESTRY, never by substring of the
 * command line: the executable name, the entry script's name, a
 * `node_modules/<package>` path segment or an `npx`-style package spec must
 * equal a known helper. A worker job that merely mentions "mcp", "claude" or
 * "gopls" somewhere in its arguments (`npm run test -w packages/mcp-server`,
 * `vitest run fsm-evaluator-claude.test.ts`, `go test ./cmd/gopls/...`) is a
 * worker job and stays visible.
 *
 * Two more rules complement the identity lists and are not name based:
 * a process that STARTED BEFORE THE ATTEMPT WAS DELIVERED is baseline (a CLI
 * helper of any name, or a leftover from a previous task in a reused session),
 * and an idle interactive shell with no live descendants is not work.
 */
export const SESSION_PROCESS_EXCLUSIONS: readonly ProcessTreeExclusionRule[] = [
  {
    id: 'root_pty_and_cli_harness',
    reason:
      'The session PTY root process itself and the provider CLI process (`claude`, `codex`, `gemini`, `kimi`, `agy`, `antigravity`, `opencode`, `cursor-agent`, `qwen`, `droid`, `hermes`, `aider`) stay alive for the entire interactive session by design. The CLI is recognised by its executable / entry-script / npm-package identity and only along the launch chain from the PTY root (shell or runtime launcher → CLI); a provider-named process anywhere else, or a CLI launched by a native CLI, is a worker job.',
    examples: ['claude', 'codex', 'gemini', 'kimi', 'agy', 'antigravity', 'opencode', 'cursor-agent'],
  },
  {
    id: 'mcp_server_helper',
    reason:
      'Provider CLIs spawn MCP stdio server subtrees at startup and keep them alive across turns to serve tool calls. A process is an MCP server only when its executable, entry script (`mcp-server/index.js`), npm package (`@modelcontextprotocol/*`, `*-mcp`) or npx/uvx package spec says so; its whole subtree is excluded by ancestry. Substrings of unrelated arguments never match.',
    examples: ['adhdev-mcp', '@modelcontextprotocol/server-filesystem', 'mcp-server/index.js', 'fastmcp'],
  },
  {
    id: 'language_server_and_code_intel',
    reason:
      'Language servers and code-intelligence daemons (`tsserver`, `typescript-language-server`, `vtsls`, `pyright`, `rust-analyzer`, `gopls`, `clangd`, `eslint_d`, `prettierd`) are long-lived indexing helpers managed by the CLI/editor runtime across turns; they are recognised by executable / entry-script / package identity only.',
    examples: ['tsserver', 'typescript-language-server', 'pyright-langserver', 'rust-analyzer', 'gopls', 'clangd'],
  },
  {
    id: 'cli_internal_sidecar_and_watcher',
    reason:
      'Runtime/OS sidecars (`codex-code-mode-host`, `watchman`, `fseventsd`, `caffeinate`, `conpty_console_list_agent`, `OpenConsole.exe`, `conhost.exe`, `esbuild --service`, `crashpad_handler`) are persistent terminal/filesystem/telemetry/tool-host daemons owned by the host or CLI runtime, not turn-scoped worker tasks.',
    examples: ['codex-code-mode-host', 'conhost.exe', 'OpenConsole.exe', 'esbuild --service', 'watchman', 'crashpad_handler'],
  },
  {
    id: 'self_inspection_probe',
    reason:
      'The daemon process (`process.pid`) is never a worker job. The process-table read itself runs outside the session tree and is not walked.',
    examples: ['adhdev daemon'],
  },
] as const;

const PROVIDER_CLI_BINARIES = new Set([
  'claude',
  'claude-code',
  'codex',
  'gemini',
  'kimi',
  'agy',
  'antigravity',
  'antigravity-cli',
  'opencode',
  'cursor-agent',
  'cursor-agent-sea',
  'qwen',
  'droid',
  'hermes',
  'aider',
]);

/** `node_modules/<name>` package directories a provider CLI is installed under. */
const PROVIDER_CLI_PACKAGES = new Set([
  '@anthropic-ai/claude-code',
  '@openai/codex',
  '@google/gemini-cli',
  '@qwen-code/qwen-code',
  'opencode-ai',
  'opencode',
  'kimi-cli',
  'cursor-agent',
  'aider-chat',
]);

const SHELL_WRAPPERS = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'tcsh',
  'csh',
  'login',
  'cmd',
  'powershell',
  'pwsh',
]);

/** Interpreters whose first non-flag argument is the entry script. */
const SCRIPT_RUNTIMES = new Set([
  'node',
  'nodejs',
  'bun',
  'deno',
  'python',
  'python3',
  'tsx',
  'ts-node',
]);

/** Launchers that fetch-and-run a package by spec (`npx -y foo`, `uvx foo`, `pnpm dlx foo`). */
const PACKAGE_RUNNERS = new Set(['npx', 'bunx', 'uvx', 'pnpx']);
const PACKAGE_RUNNER_SUBCOMMANDS = new Set(['dlx', 'exec', 'x']);

const LANGUAGE_SERVER_NAMES = new Set([
  'tsserver',
  'typescript-language-server',
  'vtsls',
  'pyright',
  'pyright-langserver',
  'basedpyright-langserver',
  'rust-analyzer',
  'gopls',
  'clangd',
  'eslint_d',
  'prettierd',
  'solargraph',
  'ruby-lsp',
  'jdtls',
  'lua-language-server',
  'zls',
  'haskell-language-server',
  'csharp-ls',
  'omnisharp',
]);

const CLI_SIDECAR_NAMES = new Set([
  'codex-code-mode-host',
  'codex-voice-host',
  'codex-linux-sandbox',
  'cursor-agent-worker-sea',
  'cursor-askpass',
  'cursorsandbox',
  'crepectl',
  'claude-askpass',
  'watchman',
  'fseventsd',
  'caffeinate',
  'conpty_console_list_agent',
  'openconsole',
  'conhost',
  'crashpad_handler',
  'xsel',
  'xclip',
  'pbcopy',
  'pbpaste',
  'wl-copy',
  'wl-paste',
]);

/** Node flags that take a separate value, so the value is not mistaken for the entry script. */
const RUNTIME_FLAGS_WITH_VALUE = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--conditions', '-C']);
/** Flags after which the next token is inline code, not a script path. */
const RUNTIME_INLINE_CODE_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-c']);

const MAX_TREE_DEPTH = 16;
const MAX_TREE_NODES = 256;
/** A harness may only sit this deep below the PTY root (wrapper shell → launcher → CLI). */
const MAX_HARNESS_DEPTH = 3;
/**
 * Slack around the delivery boundary. POSIX `etime` has 1 s granularity and a
 * model cannot start a job within a second of receiving the prompt, so a
 * process that began within this window of delivery still counts as baseline.
 */
export const BASELINE_START_TOLERANCE_MS = 1_500;

/** POSIX `ps -o comm=` truncates at 15 chars (Linux TASK_COMM_LEN-1) or 16 chars (macOS MAXCOMLEN). */
const POSIX_COMM_TRUNCATION_LEN = 15;

function extractExecToken(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('"')) {
    const endQuote = trimmed.indexOf('"', 1);
    return endQuote > 1 ? trimmed.slice(1, endQuote) : trimmed.slice(1);
  }
  if (trimmed.startsWith("'")) {
    const endQuote = trimmed.indexOf("'", 1);
    return endQuote > 1 ? trimmed.slice(1, endQuote) : trimmed.slice(1);
  }
  const winExeMatch = /^([a-zA-Z]:[\\/][^\r\n]*?\.(?:exe|cmd|bat|ps1|com))(?:\s|$)/i.exec(trimmed);
  if (winExeMatch) {
    return winExeMatch[1]!;
  }
  return trimmed.split(/\s+/)[0] ?? '';
}

function cleanExecBasename(execToken: string): string {
  const unquoted = execToken.replace(/^['"]+|['"]+$/g, '');
  const normalizedSlashes = unquoted.replace(/\\/g, '/');
  const base = path.posix.basename(normalizedSlashes).replace(/^-+/, '');
  const cleaned = base.replace(/[^a-zA-Z0-9._+@/-]/g, '');
  if (cleaned === '.' || cleaned === '..') return '';
  return cleaned;
}

/**
 * Strip paths, leading login-shell dashes (`-zsh`), and all command-line arguments
 * so only the bare executable/command name is returned (never leaking secrets in args).
 * When `comm` is truncated or a path prefix (e.g. macOS 16-char MAXCOMLEN `"/Users/example/."`),
 * prefer the executable token from `args` (`argv[0]`).
 */
export function sanitizeProcessCommandName(comm?: string | null, args?: string | null): string {
  const commToken = extractExecToken(comm ?? '');
  const argsToken = extractExecToken(args ?? '');
  const commName = cleanExecBasename(commToken);
  const argsName = cleanExecBasename(argsToken);

  if (argsName && !argsToken.startsWith('-')) {
    const normComm = commToken.replace(/^['"]+|['"]+$/g, '').replace(/\\/g, '/');
    const normArgs = argsToken.replace(/^['"]+|['"]+$/g, '').replace(/\\/g, '/');
    const commTruncatedOrPathPrefix =
      !commName ||
      commName.startsWith('.') ||
      normComm.endsWith('/') ||
      (normComm.length > 0 && normArgs.startsWith(normComm) && normArgs.length > normComm.length) ||
      (commName.length > 0 && argsName.toLowerCase().startsWith(commName.toLowerCase()) && argsName.length > commName.length) ||
      (normComm.includes('/') && normComm.length >= POSIX_COMM_TRUNCATION_LEN && commName !== argsName);
    if (commTruncatedOrPathPrefix) {
      return argsName;
    }
  }

  return commName || argsName || 'unknown';
}

const EXEC_EXTENSIONS = /\.(exe|cmd|bat|ps1|sh|js|mjs|cjs|ts|mts|py)$/i;

function normalizeExecName(name: string): string {
  return sanitizeProcessCommandName(name).toLowerCase().replace(EXEC_EXTENSIONS, '');
}

// ─── process identity ─────────────────────────────────────────────────────

interface ProcessIdentity {
  /** Normalized executable basename (argv[0], falling back to the ps `comm`). */
  readonly exec: string;
  /** Normalized basename of the entry script when `exec` is a script runtime. */
  readonly script: string | null;
  /** Lower-cased names of the (up to three) directories nearest the entry script, innermost first. */
  readonly scriptDirs: readonly string[];
  /** `node_modules/<package>` of the entry script, lower-cased. */
  readonly scriptPackage: string | null;
  /** Package spec handed to npx/uvx/dlx, version stripped, lower-cased. */
  readonly runnerSpec: string | null;
  /** `python -m <module>` module name, lower-cased. */
  readonly pyModule: string | null;
  readonly argv: readonly string[];
}

const identityCache = new WeakMap<ProcessNodeInfo, ProcessIdentity>();

function tokenizeArgs(args: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args)) !== null && out.length < 64) {
    out.push((m[1] ?? m[2] ?? m[3] ?? '').trim());
  }
  return out.filter(Boolean);
}

function stripVersion(spec: string): string {
  // `@scope/name@1.2.3` and `name@latest`; a leading `@` is the scope marker.
  const at = spec.indexOf('@', 1);
  return (at > 0 ? spec.slice(0, at) : spec).toLowerCase();
}

function nodeModulesPackage(scriptPath: string): string | null {
  const normalized = scriptPath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('node_modules/');
  if (idx < 0) return null;
  const rest = normalized.slice(idx + 'node_modules/'.length).split('/');
  const first = rest[0];
  if (!first) return null;
  if (first.startsWith('@')) return rest[1] ? `${first}/${rest[1]}`.toLowerCase() : null;
  return first.toLowerCase();
}

function isKnownLauncherName(name: string): boolean {
  return SCRIPT_RUNTIMES.has(name) || PACKAGE_RUNNERS.has(name) || SHELL_WRAPPERS.has(name)
    || /^python\d/.test(name) || ['npm', 'pnpm', 'yarn'].includes(name);
}

function identify(node: ProcessNodeInfo): ProcessIdentity {
  const cached = identityCache.get(node);
  if (cached) return cached;

  let argv = tokenizeArgs(node.args ?? '');
  const commExec = normalizeExecName(node.comm ?? '');
  // `ps args=` / CIM `CommandLine` start with argv[0]. A table whose args omit
  // it (the comm is a known launcher but args begin with something else) gets
  // the comm put back, so the entry script is still found.
  if (argv.length === 0) {
    argv = node.comm ? [node.comm] : [];
  } else if (isKnownLauncherName(commExec) && normalizeExecName(argv[0]!) !== commExec) {
    argv = [node.comm, ...argv];
  }
  const argv0 = argv[0] ?? node.comm ?? '';
  const exec = normalizeExecName(argv0 || node.comm || '');
  // A truncated or path-wrapped ps `comm` (Linux 15-char limit) must not hide a
  // known runtime: trust whichever of the two names a known launcher.
  const execName = SCRIPT_RUNTIMES.has(commExec) || PACKAGE_RUNNERS.has(commExec) ? commExec : exec;

  let script: string | null = null;
  let scriptDirs: string[] = [];
  let scriptPackage: string | null = null;
  let runnerSpec: string | null = null;
  let pyModule: string | null = null;

  const isRuntime = SCRIPT_RUNTIMES.has(execName) || /^python\d/.test(execName);
  const isRunner = PACKAGE_RUNNERS.has(execName)
    || (['pnpm', 'yarn', 'npm', 'bun'].includes(execName) && PACKAGE_RUNNER_SUBCOMMANDS.has((argv[1] ?? '').toLowerCase()));

  if (isRuntime || isRunner) {
    const rest = argv.slice(isRunner && !PACKAGE_RUNNERS.has(execName) ? 2 : 1);
    for (let i = 0; i < rest.length; i += 1) {
      const tok = rest[i]!;
      if (isRuntime && tok === '-m' && rest[i + 1]) {
        pyModule = rest[i + 1]!.toLowerCase();
        break;
      }
      if (tok.startsWith('-')) {
        if (RUNTIME_INLINE_CODE_FLAGS.has(tok)) break;
        if (RUNTIME_FLAGS_WITH_VALUE.has(tok)) i += 1;
        continue;
      }
      if (isRunner) {
        runnerSpec = stripVersion(tok);
      } else {
        const normalized = tok.replace(/\\/g, '/');
        script = normalizeExecName(normalized);
        scriptDirs = path.posix.dirname(normalized).split('/').filter((seg) => seg && seg !== '.' && seg !== '..').slice(-3).reverse().map((seg) => seg.toLowerCase());
        scriptPackage = nodeModulesPackage(normalized);
      }
      break;
    }
  }

  const identity: ProcessIdentity = { exec: execName, script, scriptDirs, scriptPackage, runnerSpec, pyModule, argv };
  identityCache.set(node, identity);
  return identity;
}

/** Names a process answers to, for exact matching against a helper list. */
function identityNames(id: ProcessIdentity): string[] {
  const names = [id.exec];
  if (id.script) names.push(id.script);
  if (id.scriptPackage) names.push(id.scriptPackage);
  if (id.runnerSpec) names.push(id.runnerSpec);
  if (id.pyModule) names.push(id.pyModule);
  return names;
}

const MCP_NAME = /^(?:adhdev-mcp|mcp-server(?:-[\w.-]+)?|[\w.-]+-mcp(?:-server)?|fastmcp|mcp-(?:proxy|remote|inspector)|mcp_server(?:_[\w]+)?|[\w]+_mcp)$/;
const MCP_SCOPED_PACKAGE = /^@modelcontextprotocol\/[^/]+$/;
const MCP_ENTRY_DIRS = new Set(['mcp-server', 'adhdev-mcp']);
const MCP_ENTRY_BASENAMES = new Set(['index', 'cli', 'main', 'server', 'bin']);

function isMcpServerIdentity(id: ProcessIdentity): boolean {
  for (const name of identityNames(id)) {
    if (MCP_NAME.test(name) || MCP_SCOPED_PACKAGE.test(name)) return true;
    // `@scope/mcp-server`, `@scope/foo-mcp`: judge the unscoped package name.
    if (name.startsWith('@') && MCP_NAME.test(name.slice(name.indexOf('/') + 1))) return true;
  }
  // `adhdev mcp …` or `node …/bin/adhdev mcp …` (worker-scoped MCP server subcommand).
  if ((id.exec === 'adhdev' || id.script === 'adhdev') && id.argv.some((tok, idx) => idx > 0 && tok.toLowerCase() === 'mcp' && normalizeExecName(id.argv[idx - 1]!) === 'adhdev')) {
    return true;
  }
  // The bundled adhdev server is started as `node …/mcp-server/(dist/)index.js`.
  return id.script !== null && MCP_ENTRY_BASENAMES.has(id.script)
    && id.scriptDirs.some((dir) => MCP_ENTRY_DIRS.has(dir));
}

function isLanguageServerIdentity(id: ProcessIdentity): boolean {
  return identityNames(id).some((name) => LANGUAGE_SERVER_NAMES.has(name));
}

function isCliSidecarIdentity(id: ProcessIdentity): boolean {
  if (CLI_SIDECAR_NAMES.has(id.exec) || (id.script !== null && CLI_SIDECAR_NAMES.has(id.script))) return true;
  if (id.exec === 'esbuild' && id.argv.some((tok) => tok === '--ping' || tok.startsWith('--service'))) return true;
  return id.argv.includes('--type=crashpad-handler');
}

function isProviderCliIdentity(id: ProcessIdentity): boolean {
  if (PROVIDER_CLI_BINARIES.has(id.exec)) return true;
  if (id.script && PROVIDER_CLI_BINARIES.has(id.script)) return true;
  if (id.scriptPackage && PROVIDER_CLI_PACKAGES.has(id.scriptPackage)) return true;
  return false;
}

function isShellIdentity(id: ProcessIdentity): boolean {
  return SHELL_WRAPPERS.has(id.exec);
}

/** A shell/launcher that can legitimately sit between the PTY root and the CLI. */
function isLaunchWrapperIdentity(id: ProcessIdentity): boolean {
  return isShellIdentity(id) || SCRIPT_RUNTIMES.has(id.exec) || /^python\d/.test(id.exec) || PACKAGE_RUNNERS.has(id.exec);
}

/** An interactive shell waiting at its prompt (no `-c`, no script) is a prompt, not a job. */
function isInteractiveShellIdentity(id: ProcessIdentity): boolean {
  if (!isShellIdentity(id)) return false;
  return id.argv.slice(1).every((tok) => tok.startsWith('-') && tok !== '-c' && !/^-[a-z]*c[a-z]*$/i.test(tok));
}

// ─── table parsing ────────────────────────────────────────────────────────

/** `[[dd-]hh:]mm:ss` → ms, or null when the token is not an elapsed-time field. */
export function parsePsElapsed(token: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(token);
  if (!m) return null;
  const days = m[1] ? Number.parseInt(m[1], 10) : 0;
  const hours = m[2] ? Number.parseInt(m[2], 10) : 0;
  const minutes = Number.parseInt(m[3]!, 10);
  const seconds = Number.parseInt(m[4]!, 10);
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

/**
 * `ps time=` cumulative CPU: `[[dd-]hh:]mm:ss` (Linux) or `[hh:]mm:ss.cc`
 * (macOS: `0:01.23`, `1:02:03`) → ms. Null when not a CPU-time field.
 */
export function parsePsCpuTime(token: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?$/.exec(token);
  if (!m) return null;
  const days = m[1] ? Number.parseInt(m[1], 10) : 0;
  const hours = m[2] ? Number.parseInt(m[2], 10) : 0;
  const minutes = Number.parseInt(m[3]!, 10);
  const seconds = Number.parseInt(m[4]!, 10);
  const fraction = m[5] ? Math.round(Number.parseFloat(`0.${m[5]}`) * 1000) : 0;
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000 + fraction;
}

/**
 * Parse `ps -ax -o pid=,ppid=,etime=,time=,comm=,args=` (or the older
 * `pid=,ppid=,etime=,comm=,args=` / `pid=,ppid=,comm=,args=` shapes).
 * `readAtMs` is when the table was read; with it `etime` becomes an absolute
 * start time.
 */
export function parsePosixPsOutput(stdout: string, readAtMs: number = Date.now()): ProcessNodeInfo[] {
  const out: ProcessNodeInfo[] = [];
  const lines = stdout.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1]!, 10);
    const ppid = Number.parseInt(match[2]!, 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || pid <= 0) continue;
    let comm = match[3] ?? '';
    let rest = match[4] ?? '';
    let startedAtMs: number | undefined;
    let cpuTimeMs: number | undefined;
    const elapsed = parsePsElapsed(comm);
    if (elapsed !== null) {
      startedAtMs = readAtMs - elapsed;
      let withComm = /^(\S+)(?:\s+(.*))?$/.exec(rest);
      if (!withComm) continue;
      const cpu = parsePsCpuTime(withComm[1] ?? '');
      if (cpu !== null && withComm[2] !== undefined) {
        // `time=` column present: the next token is the real comm.
        cpuTimeMs = cpu;
        withComm = /^(\S+)(?:\s+(.*))?$/.exec(withComm[2]);
        if (!withComm) continue;
      }
      comm = withComm[1] ?? '';
      rest = withComm[2] ?? '';
    }
    const args = rest || comm;
    out.push({
      pid,
      ppid,
      comm,
      args,
      ...(startedAtMs !== undefined ? { startedAtMs } : {}),
      ...(cpuTimeMs !== undefined ? { cpuTimeMs } : {}),
    });
  }
  return out;
}

export function parseWin32ProcessOutput(stdout: string): ProcessNodeInfo[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const out: ProcessNodeInfo[] = [];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        const pid = Number(rec.ProcessId ?? rec.Id ?? rec.pid);
        const ppid = Number(rec.ParentProcessId ?? rec.ppid ?? 0);
        const name = typeof rec.Name === 'string' ? rec.Name : typeof rec.ProcessName === 'string' ? rec.ProcessName : '';
        const cmd = typeof rec.CommandLine === 'string' ? rec.CommandLine : name;
        const startMs = Number(rec.StartMs);
        const cpuMs = rec.CpuMs === null || rec.CpuMs === undefined ? Number.NaN : Number(rec.CpuMs);
        if (Number.isFinite(pid) && pid > 0 && Number.isFinite(ppid) && ppid >= 0) {
          out.push({
            pid,
            ppid,
            comm: name || cmd,
            args: cmd || name,
            ...(Number.isFinite(startMs) && startMs > 0 ? { startedAtMs: startMs } : {}),
            ...(Number.isFinite(cpuMs) && cpuMs >= 0 ? { cpuTimeMs: cpuMs } : {}),
          });
        }
      }
      return out;
    } catch {
      // Fall through to CSV parser if JSON parsing fails.
    }
  }

  // Fallback for WMIC CSV format: Node,CommandLine,Name,ParentProcessId,ProcessId
  const out: ProcessNodeInfo[] = [];
  const lines = trimmed.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || /^Node\s*,/i.test(line)) continue;
    const parts = line.split(',');
    if (parts.length < 5) continue;
    const pidStr = parts[parts.length - 1]!.trim();
    const ppidStr = parts[parts.length - 2]!.trim();
    const name = parts[parts.length - 3]!.trim();
    const cmd = parts.slice(1, parts.length - 3).join(',').trim();
    const pid = Number.parseInt(pidStr, 10);
    const ppid = Number.parseInt(ppidStr, 10);
    if (Number.isFinite(pid) && pid > 0 && Number.isFinite(ppid) && ppid >= 0) {
      out.push({ pid, ppid, comm: name || cmd, args: cmd || name });
    }
  }
  return out;
}

// ─── tree inspection ──────────────────────────────────────────────────────

export interface SessionProcessTreeInspection {
  readonly rootPid: number | undefined;
  readonly hasLiveBackgroundProcesses: boolean;
  /** Sanitized command basenames (no arguments, so secrets cannot leak). */
  readonly liveProcessNames: readonly string[];
  readonly livePids: readonly number[];
  readonly excludedPids: readonly number[];
  /**
   * Is the live set consuming CPU? Needs `previousProcessTable`. 'unknown'
   * means CPU time was not available for some live process (or there is no
   * earlier snapshot) — it is NEVER the same as 'idle'.
   */
  readonly cpuActivity: CpuActivity;
}

/** `active`: some live process burned CPU between two snapshots (or a new one appeared). */
export type CpuActivity = 'active' | 'idle' | 'unknown';

/**
 * Noise floor for "CPU grew": an idle dev server with a file watcher ticks a
 * few ms of CPU now and then, and `ps` resolves 10 ms. Growth counts as
 * activity only at ≥ 1 % of one core averaged over the snapshot interval, and
 * never less than one `ps` tick.
 */
export const CPU_ACTIVE_MIN_RATE = 0.01;
export const CPU_ACTIVE_MIN_GROWTH_MS = 10;

export interface InspectSessionProcessTreeOptions {
  /**
   * The table to walk. REQUIRED: this function is pure and never reads the OS.
   * Obtain one from `process-table-snapshot.ts` (async, shared, throttled).
   */
  readonly processTable: readonly ProcessNodeInfo[];
  readonly selfPid?: number;
  readonly platform?: NodeJS.Platform;
  /**
   * Epoch ms the current attempt was delivered. Descendants that started
   * before it (beyond `BASELINE_START_TOLERANCE_MS`) are baseline — CLI
   * helpers or leftovers from an earlier task — and are not worker-started
   * background work. Processes with an unknown start time are never baseline.
   */
  readonly startedAfterMs?: number;
  /** The snapshot before `processTable`, for CPU growth. Omitted = CPU activity unknown. */
  readonly previousProcessTable?: readonly ProcessNodeInfo[];
  /** Wall-clock gap between `previousProcessTable` and `processTable` (scales the CPU noise floor). */
  readonly snapshotIntervalMs?: number;
}

interface ProcessTableIndex {
  readonly byPid: Map<number, ProcessNodeInfo>;
  readonly childrenByPpid: Map<number, ProcessNodeInfo[]>;
}

// One snapshot serves every session in a tick; index it once, not per session.
const indexCache = new WeakMap<readonly ProcessNodeInfo[], ProcessTableIndex>();

function indexProcessTable(table: readonly ProcessNodeInfo[]): ProcessTableIndex {
  const cached = indexCache.get(table);
  if (cached) return cached;
  const byPid = new Map<number, ProcessNodeInfo>();
  const childrenByPpid = new Map<number, ProcessNodeInfo[]>();
  for (const node of table) {
    byPid.set(node.pid, node);
    let list = childrenByPpid.get(node.ppid);
    if (!list) {
      list = [];
      childrenByPpid.set(node.ppid, list);
    }
    list.push(node);
  }
  const index = { byPid, childrenByPpid };
  indexCache.set(table, index);
  return index;
}

function emptyInspection(rootPid: number | undefined): SessionProcessTreeInspection {
  return { rootPid, hasLiveBackgroundProcesses: false, liveProcessNames: [], livePids: [], excludedPids: [], cpuActivity: 'unknown' };
}

/** CPU activity of `livePids` between two snapshots; see `CpuActivity`. */
function measureCpuActivity(
  livePids: readonly number[],
  byPid: Map<number, ProcessNodeInfo>,
  previous: readonly ProcessNodeInfo[] | undefined,
  intervalMs: number | undefined,
): CpuActivity {
  if (!previous || livePids.length === 0) return 'unknown';
  const prevByPid = indexProcessTable(previous).byPid;
  let grewMs = 0;
  let allKnown = true;
  for (const pid of livePids) {
    const now = byPid.get(pid);
    const before = prevByPid.get(pid);
    // Not in the earlier snapshot (or a recycled pid): it STARTED since — activity.
    if (!now || !before || before.comm !== now.comm || before.ppid !== now.ppid) return 'active';
    if (now.cpuTimeMs === undefined || before.cpuTimeMs === undefined) {
      allKnown = false;
      continue;
    }
    if (now.cpuTimeMs > before.cpuTimeMs) grewMs += now.cpuTimeMs - before.cpuTimeMs;
  }
  const floor = Math.max(CPU_ACTIVE_MIN_GROWTH_MS, intervalMs && intervalMs > 0 ? intervalMs * CPU_ACTIVE_MIN_RATE : 0);
  if (grewMs >= floor) return 'active';
  return allKnown ? 'idle' : 'unknown';
}

/**
 * Walk the descendant tree of `rootPid` (the session PTY PID) in `processTable`,
 * excluding the provider CLI harness (by identity, along the launch chain),
 * long-lived CLI helpers (MCP servers, language servers, sidecars — whole
 * subtrees), baseline processes that predate the attempt, and idle interactive
 * shells; return the live worker-started background processes with sanitized
 * command names.
 */
export function inspectSessionProcessTree(
  rootPid: number | undefined,
  options: InspectSessionProcessTreeOptions,
): SessionProcessTreeInspection {
  if (typeof rootPid !== 'number' || !Number.isFinite(rootPid) || rootPid <= 0) {
    return emptyInspection(undefined);
  }

  const selfPid = options.selfPid ?? process.pid;
  const table = options.processTable;
  if (table.length === 0) return emptyInspection(rootPid);

  const { byPid, childrenByPpid } = indexProcessTable(table);
  const baselineBefore =
    typeof options.startedAfterMs === 'number' && Number.isFinite(options.startedAfterMs)
      ? options.startedAfterMs + BASELINE_START_TOLERANCE_MS
      : undefined;

  // First pass: bounded descendant walk. Helper subtrees are excluded wholesale
  // by ancestry (their children belong to them). Baseline processes are only
  // FLAGGED here: the CLI itself predates the attempt, and what it spawns later
  // (its shell tool, the worker's job) must stay reachable.
  const excludedPids: number[] = [];
  const candidates: Array<{ node: ProcessNodeInfo; depth: number; parentPid: number; baseline: boolean }> = [];
  const visited = new Set<number>([rootPid]);
  const queue: Array<{ pid: number; depth: number }> = [{ pid: rootPid, depth: 0 }];

  while (queue.length > 0 && visited.size <= MAX_TREE_NODES) {
    const current = queue.shift()!;
    if (current.depth >= MAX_TREE_DEPTH) continue;
    const children = childrenByPpid.get(current.pid) ?? [];
    for (const child of children) {
      if (visited.has(child.pid)) continue;
      visited.add(child.pid);

      const id = identify(child);
      if (
        child.pid === selfPid ||
        isMcpServerIdentity(id) ||
        isLanguageServerIdentity(id) ||
        isCliSidecarIdentity(id)
      ) {
        excludedPids.push(child.pid);
        continue;
      }

      const baseline = baselineBefore !== undefined && child.startedAtMs !== undefined && child.startedAtMs < baselineBefore;
      candidates.push({ node: child, depth: current.depth + 1, parentPid: current.pid, baseline });
      queue.push({ pid: child.pid, depth: current.depth + 1 });
    }
  }

  // The harness is the provider CLI on the launch chain from the PTY root:
  // every ancestor between root and it must be a shell / runtime launcher, and
  // its direct parent must be one too (or the root). A provider-named process
  // under a native CLI (`claude -p …` run by the agent) is a worker job.
  const candidateByPid = new Map(candidates.map((c) => [c.node.pid, c]));
  const harnessPids = new Set<number>();
  const rootNode = byPid.get(rootPid);
  const rootIsLauncher = !rootNode || isLaunchWrapperIdentity(identify(rootNode));
  for (const { node, depth, parentPid } of candidates) {
    if (depth > MAX_HARNESS_DEPTH) continue;
    if (!isProviderCliIdentity(identify(node))) continue;
    const parentIsLauncher = parentPid === rootPid
      ? rootIsLauncher
      : isLaunchWrapperIdentity(identify(byPid.get(parentPid)!)) || harnessPids.has(parentPid);
    if (!parentIsLauncher) continue;
    let onChain = true;
    let cursor = parentPid;
    let guard = 0;
    while (cursor !== rootPid && guard < MAX_HARNESS_DEPTH) {
      guard += 1;
      const ancestor = candidateByPid.get(cursor);
      if (!ancestor) {
        onChain = false;
        break;
      }
      const aid = identify(ancestor.node);
      if (!isLaunchWrapperIdentity(aid) && !isProviderCliIdentity(aid)) {
        onChain = false;
        break;
      }
      cursor = ancestor.parentPid;
    }
    if (onChain) harnessPids.add(node.pid);
  }

  // Wrapper shells/launchers that only sit above the harness are part of it.
  const wrapperAncestorPids = new Set<number>();
  for (const harnessPid of harnessPids) {
    let cursor = candidateByPid.get(harnessPid)?.parentPid;
    let guard = 0;
    while (cursor !== undefined && cursor !== rootPid && guard < MAX_HARNESS_DEPTH) {
      guard += 1;
      const ancestor = candidateByPid.get(cursor);
      if (!ancestor) break;
      if (isLaunchWrapperIdentity(identify(ancestor.node))) wrapperAncestorPids.add(ancestor.node.pid);
      cursor = ancestor.parentPid;
    }
  }

  // Live = candidates minus the harness chain and minus baseline LINEAGE: a
  // process that predates the attempt (and is not the harness chain) and
  // everything below it belongs to an earlier task or to the CLI's own start-up.
  // Candidates are in BFS order, so a parent is always decided before its child.
  const baselineLineage = new Set<number>();
  const live = candidates.filter(({ node, parentPid, baseline }) => {
    if (harnessPids.has(node.pid) || wrapperAncestorPids.has(node.pid)) {
      excludedPids.push(node.pid);
      return false;
    }
    if (baselineLineage.has(parentPid) || baseline) {
      baselineLineage.add(node.pid);
      excludedPids.push(node.pid);
      return false;
    }
    return true;
  });
  // Then drop idle interactive shells that have no live descendant (a
  // persistent CLI shell is a prompt, not a job).
  const liveSet = new Set(live.map((c) => c.node.pid));
  const hasLiveChild = new Set<number>();
  for (const { node } of live) if (liveSet.has(node.ppid)) hasLiveChild.add(node.ppid);

  const livePids: number[] = [];
  const liveProcessNames: string[] = [];
  const seenNames = new Set<string>();
  for (const { node } of live) {
    if (isInteractiveShellIdentity(identify(node)) && !hasLiveChild.has(node.pid)) {
      excludedPids.push(node.pid);
      continue;
    }
    const sanitized = sanitizeProcessCommandName(node.comm, node.args);
    livePids.push(node.pid);
    if (!seenNames.has(sanitized)) {
      seenNames.add(sanitized);
      liveProcessNames.push(sanitized);
    }
  }

  return {
    rootPid,
    hasLiveBackgroundProcesses: livePids.length > 0,
    liveProcessNames,
    livePids,
    excludedPids,
    cpuActivity: measureCpuActivity(livePids, byPid, options.previousProcessTable, options.snapshotIntervalMs),
  };
}

/**
 * Extract a session's PTY PID from an adapter, instance, or runtime handle when available.
 *
 * For a session-host-hosted PTY (every Windows session, and POSIX sessions
 * under the managed session host) the PID is the one the host reported in
 * `session_started` / `session_resumed`: the OS PID of the PTY's child
 * process, in the same PID namespace the daemon's process-table read sees. It
 * is 0 until that event arrives, which this returns as undefined (unknown).
 */
export function extractSessionPtyPid(source: unknown): number | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const obj = source as Record<string, unknown>;

  if (typeof obj.getPid === 'function') {
    try {
      const pid = (obj.getPid as () => unknown)();
      if (typeof pid === 'number' && Number.isFinite(pid) && pid > 0) return pid;
    } catch {
      // Ignore getter failure.
    }
  }

  if (typeof obj.pid === 'number' && Number.isFinite(obj.pid) && obj.pid > 0) {
    return obj.pid;
  }

  const pty = obj.pty as Record<string, unknown> | undefined;
  if (pty && typeof pty === 'object' && typeof pty.pid === 'number' && Number.isFinite(pty.pid) && pty.pid > 0) {
    return pty.pid;
  }

  const adapter = obj.adapter as Record<string, unknown> | undefined;
  if (adapter && typeof adapter === 'object') {
    const fromAdapter = extractSessionPtyPid(adapter);
    if (fromAdapter) return fromAdapter;
  }

  return undefined;
}

/**
 * Small, tested allow-list of pending-background-work phrases used ONLY as a
 * secondary signal when there is no structured `report_completion`. It can
 * hold a turn end that has no report; it can never complete one, and it is
 * never consulted once a report for the current generation exists.
 */
export const PENDING_BACKGROUND_WORK_ALLOWLIST: readonly {
  readonly id: string;
  readonly pattern: RegExp;
}[] = [
  {
    id: 'waiting_for_it_to_complete',
    pattern: /\bwaiting\s+for\s+(?:it|them|the\s+(?:background\s+)?(?:command|task|process|job|test|tests|run|build|script)s?)\s+to\s+(?:complete|finish)\b/i,
  },
  {
    id: 'running_in_background_waiting',
    pattern: /\brunning\b[^.!?\n]{0,160}\bin\s+the\s+background\b[\s\S]{0,160}\bwaiting\b/i,
  },
  {
    id: 'started_in_background_waiting',
    pattern: /\b(?:started|launched|spawned)\b[^.!?\n]{0,160}\bin\s+the\s+background\b[\s\S]{0,160}\bwaiting\b/i,
  },
  {
    id: 'background_command_still_running',
    pattern: /\bbackground\s+(?:command|task|process|job)\s+is\s+(?:still\s+)?running\b/i,
  },
] as const;

/**
 * Secondary signal: returns true when an inferred final assistant summary is
 * a short waiting-for-background-work placeholder rather than actual results.
 */
export function isPendingBackgroundWorkSummary(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 600) return false;
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return false;
  // A waiting line is the LAST thing a worker says. A phrase buried earlier in
  // a longer write-up of real results ("…I had been waiting for the build to
  // finish, it did, all green") is a result, not a pending marker.
  const tail = trimmed.slice(-PENDING_TEXT_TAIL_CHARS);
  for (const rule of PENDING_BACKGROUND_WORK_ALLOWLIST) {
    if (rule.pattern.test(tail)) return true;
  }
  return false;
}

const PENDING_TEXT_TAIL_CHARS = 360;
