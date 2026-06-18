import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';

// Extensions ConPTY/CreateProcess can launch directly (not .cmd/.bat, which
// need a cmd.exe wrapper).
const DIRECT_EXEC_EXT = new Set(['.exe', '.com']);

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
      // Prefer a directly-launchable executable (.exe/.com) over .cmd/.bat shims.
      const direct = matches.find((m) => DIRECT_EXEC_EXT.has(path.extname(m).toLowerCase()));
      return direct || matches[0] || command;
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
