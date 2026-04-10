/**
 * Provider Version Detection & Archiving
 *
 * Detects installed versions for all provider categories (IDE, CLI, ACP, Extension).
 * Archives version history to ~/.adhdev/version-history.json for compatibility tracking.
 *
 * Usage:
 *   const archive = new VersionArchive();
 *   const results = await detectAllVersions(providerLoader, archive);
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { platform } from 'os';
import type { ProviderLoader } from './provider-loader.js';
import type { ProviderModule } from './contracts.js';

// ─── Types ──────────────────────────────────────

export interface ProviderVersionInfo {
  type: string;
  name: string;
  category: string;
  installed: boolean;
  version: string | null;
  path: string | null;
  binary: string | null;
  detectedAt: string;  // ISO timestamp
  /**
   * Set when the detected version is NOT listed in provider.json testedVersions.
   * Means scripts may not work correctly with this version.
   */
  warning?: string;
}

export interface VersionHistoryEntry {
  version: string;
  detectedAt: string;
  os: string;
}

export interface VersionHistory {
  [providerType: string]: VersionHistoryEntry[];
}

// ─── Version Archive ──────────────────────────────

const ARCHIVE_PATH = path.join(os.homedir(), '.adhdev', 'version-history.json');
const MAX_ENTRIES_PER_PROVIDER = 20;

export class VersionArchive {
  private history: VersionHistory = {};

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(ARCHIVE_PATH)) {
        this.history = JSON.parse(fs.readFileSync(ARCHIVE_PATH, 'utf-8'));
      }
    } catch {
      this.history = {};
    }
  }

  /** Record a detected version (deduplicates same version) */
  record(type: string, version: string): void {
    if (!this.history[type]) this.history[type] = [];

    const entries = this.history[type];
    const last = entries[entries.length - 1];

    // Skip if same version as last entry
    if (last && last.version === version) return;

    entries.push({
      version,
      detectedAt: new Date().toISOString(),
      os: platform(),
    });

    // Trim old entries
    if (entries.length > MAX_ENTRIES_PER_PROVIDER) {
      this.history[type] = entries.slice(-MAX_ENTRIES_PER_PROVIDER);
    }

    this.save();
  }

  /** Get version history for a provider */
  getHistory(type: string): VersionHistoryEntry[] {
    return this.history[type] || [];
  }

  /** Get latest known version for a provider */
  getLatest(type: string): string | null {
    const entries = this.history[type];
    return entries?.length ? entries[entries.length - 1].version : null;
  }

  /** Get full archive */
  getAll(): VersionHistory {
    return { ...this.history };
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(ARCHIVE_PATH), { recursive: true });
      fs.writeFileSync(ARCHIVE_PATH, JSON.stringify(this.history, null, 2));
    } catch { /* ignore write errors */ }
  }
}

// ─── Version Detection ──────────────────────────────

function runCommand(cmd: string, timeout = 10000): string | null {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function findBinary(name: string): string | null {
  const cmd = platform() === 'win32' ? `where ${name}` : `which ${name}`;
  const result = runCommand(cmd, 5000);
  return result ? result.split('\n')[0] : null;
}

/** Extract version string from CLI output */
function parseVersion(raw: string): string {
  // Common patterns: "1.2.3", "v1.2.3", "tool 1.2.3", "tool version 1.2.3"
  const match = raw.match(/v?(\d+\.\d+(?:\.\d+)?(?:-[a-zA-Z0-9.]+)?)/);
  return match ? match[1] : raw.split('\n')[0].substring(0, 100);
}

function getPlatformVersionCommand(
  versionCommand: ProviderModule['versionCommand'],
  currentOs: string,
): string | undefined {
  if (!versionCommand) return undefined;
  if (typeof versionCommand === 'string') {
    const trimmed = versionCommand.trim();
    return trimmed || undefined;
  }
  const platformValue = versionCommand[currentOs];
  if (typeof platformValue === 'string' && platformValue.trim()) {
    return platformValue.trim();
  }
  const defaultValue = versionCommand.default;
  if (typeof defaultValue === 'string' && defaultValue.trim()) {
    return defaultValue.trim();
  }
  return undefined;
}

function getVersion(binary: string, versionCommand?: string): string | null {
  // Custom version command from provider.json
  if (versionCommand) {
    const raw = runCommand(versionCommand);
    return raw ? parseVersion(raw) : null;
  }

  // Default: try --version, then -V, then -v
  for (const flag of ['--version', '-V', '-v']) {
    const raw = runCommand(`"${binary}" ${flag}`);
    if (raw && raw.length < 500) return parseVersion(raw);
  }
  return null;
}

function checkPathExists(paths: string[]): string | null {
  for (const p of paths) {
    if (p.includes('*')) {
      const home = os.homedir();
      const resolved = p.replace(/\*/g, home.split(path.sep).pop() || '');
      if (fs.existsSync(resolved)) return resolved;
    } else {
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/** macOS: Get app version from Info.plist */
function getMacAppVersion(appPath: string): string | null {
  if (platform() !== 'darwin' || !appPath.endsWith('.app')) return null;
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  if (!fs.existsSync(plistPath)) return null;
  const raw = runCommand(`/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "${plistPath}"`);
  return raw || null;
}

/**
 * Detect versions for all loaded providers
 */
export async function detectAllVersions(
  loader: ProviderLoader,
  archive?: VersionArchive,
): Promise<ProviderVersionInfo[]> {
  const results: ProviderVersionInfo[] = [];
  const currentOs = platform() as string;

  for (const provider of loader.getAll()) {
    const info: ProviderVersionInfo = {
      type: provider.type,
      name: provider.name,
      category: provider.category,
      installed: false,
      version: null,
      path: null,
      binary: null,
      detectedAt: new Date().toISOString(),
    };

    const versionCommand = getPlatformVersionCommand(provider.versionCommand, currentOs);

    if (provider.category === 'ide') {
      // IDE: check app path + CLI
      const osPaths = provider.paths?.[currentOs] || [];
      const appPath = checkPathExists(osPaths);
      const cliBin = provider.cli ? findBinary(provider.cli) : null;

      // Also check bundled CLI inside .app for macOS
      let resolvedBin = cliBin;
      if (!resolvedBin && appPath && currentOs === 'darwin') {
        const bundled = path.join(appPath, 'Contents', 'Resources', 'app', 'bin', provider.cli || '');
        if (provider.cli && fs.existsSync(bundled)) resolvedBin = bundled;
      }

      info.installed = !!(appPath || resolvedBin);
      info.path = appPath || null;
      info.binary = resolvedBin || null;

      // Version: try CLI first, then plist
      if (resolvedBin) {
        info.version = getVersion(resolvedBin, versionCommand);
      }
      if (!info.version && appPath) {
        info.version = getMacAppVersion(appPath);
      }

    } else if (provider.category === 'cli' || provider.category === 'acp') {
      // CLI/ACP: check binary
      const bin = provider.binary || provider.spawn?.command || provider.cli || provider.type;
      const binPath = findBinary(bin);
      info.installed = !!binPath;
      info.binary = binPath || null;

      if (binPath) {
        info.version = getVersion(binPath, versionCommand);
      }

    } else if (provider.category === 'extension') {
      // Extension: version detection via `code --list-extensions --show-versions`
      // This is more complex and depends on the host IDE — skip for now
      // Could be detected at runtime via CDP
      info.installed = false; // Cannot reliably detect without IDE context
      info.version = null;
    }

    // Archive the version if detected
    if (info.version && archive) {
      archive.record(provider.type, info.version);
    }

    // Check testedVersions — warn if installed version is not documented
    if (info.version && info.installed) {
      const testedVersions = provider.testedVersions || [];
      if (testedVersions.length > 0 && !testedVersions.includes(info.version)) {
        info.warning = `Version ${info.version} is not in testedVersions [${testedVersions.join(', ')}]. Scripts may not work correctly.`;
      }
    }

    results.push(info);
  }

  return results;
}
