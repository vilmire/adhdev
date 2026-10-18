import fs from 'node:fs';
import path from 'node:path';
import { hiddenExecFileSync } from './hidden-spawn.js';

export interface ProcessNodeInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly comm: string;
  readonly args?: string;
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
 */
export const SESSION_PROCESS_EXCLUSIONS: readonly ProcessTreeExclusionRule[] = [
  {
    id: 'root_pty_and_cli_harness',
    reason:
      'The session PTY root process itself, its direct login/wrapper shell when acting as an ancestor of the CLI binary, and the provider CLI process (`claude`, `codex`, `gemini`, `kimi`, `agy`, `antigravity`, `opencode`, `cursor-agent`, `qwen`, `droid`, `hermes`, `aider`) stay alive for the entire interactive session by design; they are the session host rather than a background job launched during a turn.',
    examples: ['claude', 'codex', 'gemini', 'kimi', 'agy', 'antigravity', 'opencode', 'cursor-agent'],
  },
  {
    id: 'mcp_server_helper',
    reason:
      'Provider CLIs spawn MCP stdio server subtrees (`*mcp*`, `@adhdev/mcp`, `adhdev-mcp`, `modelcontextprotocol`, `fastmcp`) at startup and keep them alive across turns to serve tool calls; excluding the MCP server subtree is safe because MCP helpers never represent worker-backgrounded shell commands.',
    examples: ['adhdev-mcp', '@modelcontextprotocol/server-filesystem', 'mcp-server', 'fastmcp'],
  },
  {
    id: 'language_server_and_code_intel',
    reason:
      'Language servers and code-intelligence daemons (`tsserver`, `typescript-language-server`, `vtsls`, `pyright`, `rust-analyzer`, `gopls`, `clangd`, `eslint_d`, `prettierd`, `biome`, `rg --files`) are long-lived indexing helpers managed by the CLI/editor runtime across turns.',
    examples: ['tsserver', 'typescript-language-server', 'pyright-langserver', 'rust-analyzer', 'gopls', 'clangd'],
  },
  {
    id: 'cli_internal_sidecar_and_watcher',
    reason:
      'Runtime/OS sidecars (`watchman`, `fseventsd`, `caffeinate`, `conpty_console_list_agent`, `OpenConsole.exe`, `conhost.exe`, `esbuild --service`, `crashpad_handler`) are persistent terminal/filesystem/telemetry daemons owned by the host or CLI runtime, not turn-scoped worker tasks.',
    examples: ['conhost.exe', 'OpenConsole.exe', 'esbuild --service', 'watchman', 'crashpad_handler'],
  },
  {
    id: 'self_inspection_probe',
    reason:
      'The daemon process (`process.pid`) and any ephemeral `ps` / `powershell` / `wmic` subprocess spawned to inspect the process table exist only for the inspection call itself.',
    examples: ['ps', 'powershell.exe', 'wmic.exe'],
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
  'qwen',
  'droid',
  'hermes',
  'aider',
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
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
]);

const RUNTIME_LAUNCHERS = new Set([
  'node',
  'node.exe',
  'nodejs',
  'bun',
  'deno',
  'python',
  'python3',
  'python.exe',
  'uv',
  'uvx',
  'npx',
  'npm',
  'pnpm',
  'yarn',
]);

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
  ' ruby-lsp',
  'jdtls',
  'lua-language-server',
  'zls',
  'haskell-language-server',
  ' csharp-ls',
  'omnisharp',
]);

const CLI_SIDECAR_NAMES = new Set([
  'watchman',
  'fseventsd',
  'caffeinate',
  'conpty_console_list_agent',
  'conpty_console_list_agent.exe',
  'openconsole',
  'openconsole.exe',
  'conhost',
  'conhost.exe',
  'crashpad_handler',
  'crashpad_handler.exe',
  'xsel',
  'xclip',
  'pbcopy',
  'pbpaste',
  'wl-copy',
  'wl-paste',
]);

const MAX_TREE_DEPTH = 16;
const MAX_TREE_NODES = 256;

/**
 * Strip paths, leading login-shell dashes (`-zsh`), and all command-line arguments
 * so only the bare executable/command name is returned (never leaking secrets in args).
 */
export function sanitizeProcessCommandName(comm?: string | null, args?: string | null): string {
  const raw = (comm && comm.trim()) || (args && args.trim()) || '';
  if (!raw) return 'unknown';

  let execToken = raw;
  if (raw.startsWith('"')) {
    const endQuote = raw.indexOf('"', 1);
    execToken = endQuote > 1 ? raw.slice(1, endQuote) : raw.slice(1);
  } else if (raw.startsWith("'")) {
    const endQuote = raw.indexOf("'", 1);
    execToken = endQuote > 1 ? raw.slice(1, endQuote) : raw.slice(1);
  } else {
    const winExeMatch = /^([a-zA-Z]:[\\/][^\r\n]*?\.(?:exe|cmd|bat|ps1|com))(?:\s|$)/i.exec(raw);
    if (winExeMatch) {
      execToken = winExeMatch[1]!;
    } else {
      execToken = raw.split(/\s+/)[0] ?? '';
    }
  }

  const unquoted = execToken.replace(/^['"]+|['"]+$/g, '');
  const normalizedSlashes = unquoted.replace(/\\/g, '/');
  const base = path.posix.basename(normalizedSlashes).replace(/^-+/, '');
  const cleaned = base.replace(/[^a-zA-Z0-9._+@/-]/g, '');
  return cleaned || 'unknown';
}

function normalizeExecName(name: string): string {
  return sanitizeProcessCommandName(name).toLowerCase().replace(/\.(exe|cmd|bat|ps1|sh|js|mjs|cjs)$/i, '');
}

function isMcpServerProcess(comm: string, args: string): boolean {
  const lowerComm = sanitizeProcessCommandName(comm).toLowerCase();
  const lowerArgs = args.toLowerCase();
  if (lowerComm.includes('mcp')) return true;
  if (
    /(?:^|[\s/\\'"@_-])(mcp[-_]?server|server[-_]?mcp|adhdev[-_]?mcp|modelcontextprotocol|fastmcp|mcp[-_]?proxy|mcp[-_]?remote|mcp[-_]?inspector)(?:$|[\s/\\'"@._-])/i.test(
      lowerArgs,
    )
  ) {
    return true;
  }
  return false;
}

function isLanguageServerProcess(comm: string, args: string): boolean {
  const norm = normalizeExecName(comm);
  if (LANGUAGE_SERVER_NAMES.has(norm)) return true;
  const lowerArgs = args.toLowerCase();
  if (
    /(?:^|[\s/\\'"])(tsserver(?:\.js)?|typescript-language-server|vtsls|pyright(?:-langserver)?|rust-analyzer|gopls|clangd|eslint_d|prettierd)(?:$|[\s/\\'"])/i.test(
      lowerArgs,
    )
  ) {
    return true;
  }
  return false;
}

function isCliSidecarProcess(comm: string, args: string): boolean {
  const lowerComm = sanitizeProcessCommandName(comm).toLowerCase();
  const norm = normalizeExecName(comm);
  if (CLI_SIDECAR_NAMES.has(lowerComm) || CLI_SIDECAR_NAMES.has(norm)) return true;
  const lowerArgs = args.toLowerCase();
  if (norm === 'esbuild' && (lowerArgs.includes('--service') || lowerArgs.includes('--ping'))) {
    return true;
  }
  if (lowerArgs.includes('crashpad_handler') || lowerArgs.includes('--type=crashpad-handler')) {
    return true;
  }
  return false;
}

function isProviderCliHarnessProcess(comm: string, args: string): boolean {
  const norm = normalizeExecName(comm);
  if (PROVIDER_CLI_BINARIES.has(norm)) return true;
  if (!RUNTIME_LAUNCHERS.has(norm) && !RUNTIME_LAUNCHERS.has(sanitizeProcessCommandName(comm).toLowerCase())) {
    return false;
  }
  const lowerArgs = args.toLowerCase();
  for (const cli of PROVIDER_CLI_BINARIES) {
    const pattern = new RegExp(`(?:^|[\\s/\\\\'"@_-])${cli}(?:$|[\\s/\\\\'"._-])`, 'i');
    if (pattern.test(lowerArgs)) return true;
  }
  return false;
}

export function parsePosixPsOutput(stdout: string): ProcessNodeInfo[] {
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
    const comm = match[3] ?? '';
    const args = match[4] ?? comm;
    out.push({ pid, ppid, comm, args });
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
        if (Number.isFinite(pid) && pid > 0 && Number.isFinite(ppid) && ppid >= 0) {
          out.push({ pid, ppid, comm: name || cmd, args: cmd || name });
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

function readLinuxProcTable(): ProcessNodeInfo[] {
  try {
    const entries = fs.readdirSync('/proc', { withFileTypes: true });
    const out: ProcessNodeInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const pid = Number.parseInt(entry.name, 10);
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const closeParen = stat.lastIndexOf(')');
        const openParen = stat.indexOf('(');
        if (openParen < 0 || closeParen < 0) continue;
        const comm = stat.slice(openParen + 1, closeParen);
        const rest = stat.slice(closeParen + 2).trim().split(/\s+/);
        const ppid = Number.parseInt(rest[1] ?? '0', 10);
        let args = comm;
        try {
          const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0+/g, ' ').trim();
          if (cmdline) args = cmdline;
        } catch {
          // Ignore cmdline read failure.
        }
        if (Number.isFinite(ppid)) {
          out.push({ pid, ppid, comm, args });
        }
      } catch {
        // Process exited during scan.
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function readSystemProcessTable(platform: NodeJS.Platform = process.platform): ProcessNodeInfo[] {
  if (platform === 'win32') {
    try {
      const stdout = hiddenExecFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress',
        ],
        {
          encoding: 'utf8',
          timeout: 2500,
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        },
      );
      const parsed = parseWin32ProcessOutput(typeof stdout === 'string' ? stdout : String(stdout ?? ''));
      if (parsed.length > 0) return parsed;
    } catch {
      // Fallback to wmic on older Windows installations.
    }
    try {
      const stdout = hiddenExecFileSync(
        'wmic.exe',
        ['process', 'get', 'CommandLine,Name,ParentProcessId,ProcessId', '/FORMAT:CSV'],
        {
          encoding: 'utf8',
          timeout: 2500,
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        },
      );
      return parseWin32ProcessOutput(typeof stdout === 'string' ? stdout : String(stdout ?? ''));
    } catch {
      return [];
    }
  }

  // POSIX (macOS / Linux / BSD)
  try {
    const stdout = hiddenExecFileSync('ps', ['-ax', '-o', 'pid=,ppid=,comm=,args='], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = parsePosixPsOutput(typeof stdout === 'string' ? stdout : String(stdout ?? ''));
    if (parsed.length > 0) return parsed;
  } catch {
    // Fallback to /proc on Linux if ps fails.
  }

  if (platform === 'linux') {
    return readLinuxProcTable();
  }
  return [];
}

export interface SessionProcessTreeInspection {
  readonly rootPid: number | undefined;
  readonly hasLiveBackgroundProcesses: boolean;
  /** Sanitized command basenames (no arguments, so secrets cannot leak). */
  readonly liveProcessNames: readonly string[];
  readonly livePids: readonly number[];
  readonly excludedPids: readonly number[];
}

export interface InspectSessionProcessTreeOptions {
  readonly processTable?: readonly ProcessNodeInfo[];
  readonly selfPid?: number;
  readonly platform?: NodeJS.Platform;
}

/**
 * Walk the descendant tree of `rootPid` (the session PTY PID), excluding
 * the root PTY process, the provider CLI harness itself, and long-lived CLI
 * helpers (MCP servers, language servers, sidecars), and return any live
 * worker-started background processes with sanitized command names.
 */
export function inspectSessionProcessTree(
  rootPid: number | undefined,
  options?: InspectSessionProcessTreeOptions,
): SessionProcessTreeInspection {
  if (typeof rootPid !== 'number' || !Number.isFinite(rootPid) || rootPid <= 0) {
    return {
      rootPid: undefined,
      hasLiveBackgroundProcesses: false,
      liveProcessNames: [],
      livePids: [],
      excludedPids: [],
    };
  }

  const selfPid = options?.selfPid ?? process.pid;
  const table = options?.processTable ?? readSystemProcessTable(options?.platform);
  if (table.length === 0) {
    return {
      rootPid,
      hasLiveBackgroundProcesses: false,
      liveProcessNames: [],
      livePids: [],
      excludedPids: [],
    };
  }

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

  // First pass: collect bounded descendant subtree under rootPid (excluding entire subtrees
  // rooted at MCP servers, language servers, sidecars, or our own inspection probe).
  const excludedPids: number[] = [];
  const candidateNodes: Array<{ node: ProcessNodeInfo; depth: number }> = [];
  const visited = new Set<number>([rootPid]);
  const queue: Array<{ pid: number; depth: number }> = [{ pid: rootPid, depth: 0 }];

  while (queue.length > 0 && visited.size <= MAX_TREE_NODES) {
    const current = queue.shift()!;
    if (current.depth >= MAX_TREE_DEPTH) continue;
    const children = childrenByPpid.get(current.pid) ?? [];
    for (const child of children) {
      if (visited.has(child.pid)) continue;
      visited.add(child.pid);

      const comm = child.comm ?? '';
      const args = child.args ?? comm;

      // Exclude self probe and entire helper subtrees (MCP, LSP, CLI sidecars).
      if (
        child.pid === selfPid ||
        isMcpServerProcess(comm, args) ||
        isLanguageServerProcess(comm, args) ||
        isCliSidecarProcess(comm, args)
      ) {
        excludedPids.push(child.pid);
        continue;
      }

      candidateNodes.push({ node: child, depth: current.depth + 1 });
      queue.push({ pid: child.pid, depth: current.depth + 1 });
    }
  }

  // Identify the provider CLI harness node(s) in the tree so we can exclude:
  // 1) the provider CLI binary itself; and
  // 2) any direct login/wrapper shell that only acts as an ancestor launching the CLI binary.
  const harnessPids = new Set<number>();
  for (const { node, depth } of candidateNodes) {
    if (depth <= 3 && isProviderCliHarnessProcess(node.comm ?? '', node.args ?? '')) {
      harnessPids.add(node.pid);
    }
  }

  const wrapperShellAncestorPids = new Set<number>();
  for (const cliPid of harnessPids) {
    let cursor = byPid.get(cliPid)?.ppid;
    let guard = 0;
    while (cursor && cursor !== rootPid && guard < 6) {
      guard += 1;
      const ancestor = byPid.get(cursor);
      if (!ancestor) break;
      const norm = normalizeExecName(ancestor.comm ?? '');
      if (SHELL_WRAPPERS.has(norm) || SHELL_WRAPPERS.has(sanitizeProcessCommandName(ancestor.comm).toLowerCase())) {
        wrapperShellAncestorPids.add(ancestor.pid);
      }
      cursor = ancestor.ppid;
    }
  }

  const livePids: number[] = [];
  const liveProcessNames: string[] = [];
  const seenNames = new Set<string>();

  for (const { node } of candidateNodes) {
    if (harnessPids.has(node.pid) || wrapperShellAncestorPids.has(node.pid)) {
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
  };
}

/**
 * Extract a session's PTY PID from an adapter, instance, or runtime handle when available.
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
 * secondary signal when there is no structured `report_completion`.
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
  for (const rule of PENDING_BACKGROUND_WORK_ALLOWLIST) {
    if (rule.pattern.test(trimmed)) return true;
  }
  return false;
}
