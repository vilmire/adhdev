import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';

// Extensions ConPTY/CreateProcess can launch directly (not .cmd/.bat, which
// need a cmd.exe wrapper).
const DIRECT_EXEC_EXT = new Set(['.exe', '.com']);

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
    // `where` not found / non-zero exit — fall through to original command.
  }
  return command;
}
