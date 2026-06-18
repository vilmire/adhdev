/**
 * ADHDev — Windows IDE version detection (execution-free)
 *
 * On Windows the resolved "CLI" for a VS Code fork (Cursor, Antigravity, …)
 * frequently resolves to the GUI Electron executable itself, because the
 * case-insensitive filesystem matches `...\cursor\cursor.exe` against the
 * real `Cursor.exe`. Running `<that exe> --version` boots the GUI instead of
 * printing a version (Electron ignores the unknown flag and opens a window).
 *
 * To learn the version WITHOUT spawning anything, we read the bundled
 * `product.json` / `package.json` that ship next to the executable. VS Code
 * forks embed their version there. This is a pure filesystem read.
 *
 * It also exposes a guard so any remaining `--version` exec path can refuse to
 * spawn a binary that is a known GUI executable for an IDE provider.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Candidate locations for the version manifest relative to the GUI exe dir.
 * VS Code forks place `resources/app/{product,package}.json` next to the exe.
 */
function manifestCandidates(exeDir: string): string[] {
  return [
    path.join(exeDir, 'resources', 'app', 'product.json'),
    path.join(exeDir, 'resources', 'app', 'package.json'),
    // Some packagings keep product.json one level up.
    path.join(exeDir, 'product.json'),
  ];
}

function parseVersionFromManifest(raw: string): string | null {
  try {
    const json = JSON.parse(raw) as Record<string, unknown>;
    // product.json forks expose the IDE's own version here; package.json
    // exposes the upstream VS Code engine version. Prefer the former.
    const candidate = json.version;
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  } catch {
    /* not valid JSON — ignore */
  }
  return null;
}

/**
 * Read an IDE version from disk (no process spawn).
 *
 * @param exePath Absolute path to the GUI executable (or any path inside the
 *   IDE install dir — we read the manifest relative to its directory).
 * @returns The version string, or null if it could not be determined.
 */
export function readWin32IdeVersionFromDisk(exePath: string): string | null {
  if (!exePath) return null;
  let exeDir: string;
  try {
    exeDir = fs.statSync(exePath).isDirectory() ? exePath : path.dirname(exePath);
  } catch {
    exeDir = path.dirname(exePath);
  }
  for (const candidate of manifestCandidates(exeDir)) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const version = parseVersionFromManifest(fs.readFileSync(candidate, 'utf-8'));
      if (version) return version;
    } catch {
      /* ignore unreadable manifest */
    }
  }
  return null;
}

/**
 * True when `binPath` resolves to a known GUI executable for some IDE.
 *
 * Used as a safety net: any code path about to run `<bin> --version` must skip
 * the spawn when the binary is actually the GUI Electron exe, since that would
 * launch the IDE window. Comparison is case-insensitive on the basename
 * (Windows filesystem semantics) against every provider's `processNames.win32`.
 *
 * @param binPath Resolved binary path that would be exec'd.
 * @param win32ProcessNames Map of provider type → list of GUI exe names
 *   (from provider.json `processNames.win32`, e.g. `["Cursor.exe"]`).
 */
export function isKnownWin32GuiExe(
  binPath: string | null | undefined,
  win32ProcessNames: Record<string, string[]>,
): boolean {
  if (!binPath) return false;
  // Use win32 basename semantics regardless of host OS: this matches Windows
  // paths even when the daemon-core test/CI host is POSIX (where `/` is the
  // only separator). On the real win32 target this is identical to basename().
  const base = path.win32.basename(binPath).toLowerCase();
  if (!base.endsWith('.exe')) return false;
  for (const names of Object.values(win32ProcessNames)) {
    for (const name of names) {
      if (typeof name === 'string' && name.toLowerCase() === base) {
        return true;
      }
    }
  }
  return false;
}
