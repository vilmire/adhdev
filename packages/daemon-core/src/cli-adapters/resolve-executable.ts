import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';

// Extensions ConPTY/CreateProcess can launch directly (not .cmd/.bat, which
// need a cmd.exe wrapper).
const DIRECT_EXEC_EXT = new Set(['.exe', '.com']);

// Batch-style shims: absolute and launchable by node-pty's ConPTY, but NOT by
// child_process.execFile/spawn without a cmd.exe wrapper (Node ≥18.20/20.12/22/24
// refuse to exec a .cmd/.bat directly — CVE-2024-27980 mitigation). Preferred
// over extensionless Unix wrappers, which are not win32-executable at all.
const SHIM_EXEC_EXT = new Set(['.cmd', '.bat']);

// Executable extensions to probe when scanning a directory ourselves, ordered
// most-directly-launchable first. node-pty's ConPTY backend launches an
// absolute `.cmd`/`.bat` shim fine (verified) — it only fails to *resolve* a
// bare command against an incomplete PATH — so once we hand it an absolute
// path, a `.cmd` shim works just as well as a real `.exe`.
const WIN_EXEC_EXT = ['.exe', '.com', '.cmd', '.bat'];

/**
 * Resolve a bare command against well-known global-bin directories that are
 * frequently NOT on the daemon's inherited PATH, so `where` (which only
 * searches PATH) misses them. A daemon running under one Node install (e.g.
 * nvm) never sees another npm prefix's bin dir — notably npm's Windows default
 * prefix at %APPDATA%\npm, where `npm i -g @openai/codex` lands. Returns an
 * absolute path on the first hit, or null. Mirrors findBinary()'s extraDirs in
 * provider-cli-shared.ts; kept inline here so this lightweight module (loaded
 * by pty-transport) need not pull in the heavier shared module.
 */
function resolveWin32GlobalBin(trimmed: string): string | null {
  // Only resolve a bare command name — anything with a path separator is the
  // caller's explicit location and must not be re-pointed at a global bin dir.
  if (path.isAbsolute(trimmed) || trimmed.includes('/') || trimmed.includes('\\')) {
    return null;
  }
  const extraDirs: string[] = [];
  if (process.env.APPDATA) extraDirs.push(path.join(process.env.APPDATA, 'npm'));
  try { extraDirs.push(path.dirname(process.execPath)); } catch { /* best-effort */ }
  for (const dir of extraDirs) {
    if (!dir) continue;
    for (const ext of WIN_EXEC_EXT) {
      const full = path.join(dir, trimmed + ext);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

/**
 * Pick the best launch target from `where`'s match list on win32.
 *
 * `where npm` on a typical install returns BOTH the extensionless Unix wrapper
 * (e.g. `C:\Program Files\nodejs\npm`, a bash shell script) AND the `npm.cmd`
 * shim. The extensionless wrapper is NOT a win32 executable — handing it to a
 * spawn boundary ENOENTs (errno -4058). So:
 *   1. Prefer a directly-launchable `.exe`/`.com`.
 *   2. Otherwise take a `.cmd`/`.bat` shim (absolute → works for ConPTY, and for
 *      execFile once wrapped via buildWin32ExecFileSpawn).
 *   3. NEVER fall back to an extensionless match — return null so the caller can
 *      try other resolution strategies (global-bin scan) rather than emit a
 *      path that cannot be exec'd.
 */
export function selectWin32ExecutableMatch(matches: string[]): string | null {
  const cleaned = matches.map((m) => m.trim()).filter(Boolean);
  const direct = cleaned.find((m) => DIRECT_EXEC_EXT.has(path.extname(m).toLowerCase()));
  if (direct) return direct;
  const shim = cleaned.find((m) => SHIM_EXEC_EXT.has(path.extname(m).toLowerCase()));
  if (shim) return shim;
  return null;
}

/**
 * Resolve a launch command to an absolute executable path on Windows.
 *
 * node-pty's ConPTY backend resolves a bare/relative command against the
 * *calling process's* `Path` env var and — critically — does NOT apply PATHEXT.
 * So a provider command like `claude` never matches `claude.exe` and the native
 * layer throws `File not found:` (empty), which crashes the daemon. We resolve
 * it to an absolute `.exe` here (in the daemon process, which has the full PATH)
 * before the command ever reaches node-pty.
 *
 * No-op on non-Windows and when the command is already an existing absolute path
 * or cannot be resolved (caller keeps the original behaviour).
 */
export function resolveWin32Executable(command: string): string {
  if (process.platform !== 'win32') return command;
  const trimmed = (command || '').trim();
  if (!trimmed) return command;

  // Already an absolute path that exists — keep it.
  if (path.isAbsolute(trimmed) && existsSync(trimmed)) return trimmed;

  try {
    const out = execFileSync('where', [trimmed], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    if (out) {
      const matches = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      // Prefer .exe/.com, then a .cmd/.bat shim; never an extensionless Unix
      // wrapper (the old `matches[0]` fallback returned exactly that and made
      // the spawn boundary ENOENT). On no usable match, fall through to the
      // off-PATH global-bin scan below rather than returning a dead path.
      const selected = selectWin32ExecutableMatch(matches);
      if (selected) return selected;
    }
  } catch {
    // `where` not found / non-zero exit — fall through to the global-bin scan.
  }

  // `where` found nothing on PATH. Before giving up (and letting node-pty crash
  // with "File not found:" on the bare command), search npm's off-PATH global
  // bin dir(s). This is the codex case: `npm i -g @openai/codex` installs to
  // %APPDATA%\npm, which is absent from a nvm-launched daemon's PATH, so a spec
  // binary of "codex" never resolved and the spawn ENOENT'd.
  const globalBin = resolveWin32GlobalBin(trimmed);
  if (globalBin) return globalBin;

  return command;
}

/**
 * Quote one argument for a cmd.exe command line using the standard
 * CommandLineToArgvW rules (the same algorithm Node uses internally): wrap in
 * double quotes only when needed, double up the backslashes that precede a
 * quote, and escape embedded quotes. We do per-argument quoting ourselves
 * (rather than `{ shell: true }`) because Node's shell mode joins argv with bare
 * spaces and applies NO quoting — any argument containing a space (a path, a
 * test name) would split. Inputs here are repo-mesh validation/bootstrap command
 * tokens (trusted config, not network data), so argv-quoting for spaces/quotes
 * is sufficient; we deliberately do not attempt full cmd.exe metacharacter
 * (& | < > ^ %) escaping.
 */
export function quoteWin32CmdArg(arg: string): string {
  if (arg.length > 0 && !/[ \t"]/.test(arg)) return arg;
  let result = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      // Escape every pending backslash (they precede a quote) plus the quote.
      result += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    result += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  // Trailing backslashes precede the closing quote → must be doubled.
  result += '\\'.repeat(backslashes * 2) + '"';
  return result;
}

export interface Win32ExecFileSpawn {
  file: string;
  args: string[];
  /** Set when the args are pre-quoted for cmd.exe and must not be re-quoted. */
  windowsVerbatimArguments?: boolean;
}

/**
 * Build child_process.execFile/spawn parameters for an already-resolved command.
 *
 * On win32 a `.cmd`/`.bat` shim (what `npm`/`npx`/`tsc`/`vitest` resolve to)
 * cannot be launched by execFile directly — modern Node refuses it (CVE-2024-27980
 * mitigation) and CreateProcess cannot exec a batch file. So wrap it in
 * `cmd.exe /d /s /c "<quoted command line>"` with `windowsVerbatimArguments` so
 * our own per-argument quoting is preserved. `.exe`/`.com` (and every non-win32
 * platform, and any already-cmd.exe target) pass through unchanged — this is a
 * strict no-op off win32, guarding against regressions on linux/macOS.
 */
export function buildWin32ExecFileSpawn(resolvedCommand: string, args: string[]): Win32ExecFileSpawn {
  if (process.platform !== 'win32') return { file: resolvedCommand, args };
  const ext = path.extname(resolvedCommand).toLowerCase();
  if (!SHIM_EXEC_EXT.has(ext)) return { file: resolvedCommand, args };
  // cmd.exe /d (skip AutoRun) /s (treat the rest, between the outer quotes, as
  // the verbatim command) /c (run then exit). Mirrors Node's internal shell
  // wrapping but with each token individually quoted.
  const commandLine = [resolvedCommand, ...args].map(quoteWin32CmdArg).join(' ');
  return {
    file: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * Convenience: resolve a bare command to an absolute win32 path AND build the
 * execFile spawn parameters (cmd.exe-wrapping a .cmd/.bat shim). Returns the
 * resolved command alongside the spawn spec so callers can still surface the
 * resolved path in diagnostics.
 */
export function resolveWin32ExecFileSpawn(
  command: string,
  args: string[],
): Win32ExecFileSpawn & { resolvedCommand: string } {
  const resolvedCommand = resolveWin32Executable(command);
  return { resolvedCommand, ...buildWin32ExecFileSpawn(resolvedCommand, args) };
}
