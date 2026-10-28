import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { HostUpgradeBinding } from './upgrade-lease.js';
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
export interface GuardianArtifactPins {
  packageRoot: string;
  manifestPath: string;
  manifestSha256: string;
  version: string;
  commit: string;
  nodePath: string;
  daemonEntryPath: string;
  cliEntryPath: string;
  hostEntryPath: string;
  stateDir: string;
}
/** The manifest pin must come from the supervisor's immutable artifact plan. */
export function resolveGuardianArtifact(pins: GuardianArtifactPins): HostUpgradeBinding {
  if (process.platform !== 'darwin') throw new Error('guardian_artifact_platform_unsupported');
  const root = fs.realpathSync(pins.packageRoot);
  const regular = (file: string) => {
    if (!path.isAbsolute(file) || fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()) throw new Error('guardian_artifact_path_untrusted');
    return file;
  };
  const manifestPath = regular(pins.manifestPath);
  if (path.relative(root, manifestPath).startsWith('..')) throw new Error('guardian_artifact_manifest_escape');
  const bytes = fs.readFileSync(manifestPath);
  if (!/^[a-f0-9]{64}$/.test(pins.manifestSha256) || sha(bytes) !== pins.manifestSha256) throw new Error('guardian_artifact_manifest_pin_mismatch');
  const m = JSON.parse(String(bytes));
  if (m.schema !== 1 || (m.protocol !== 1 && m.protocol !== 2) || m.platform !== 'darwin' || m.arch !== process.arch || m.version !== pins.version || m.commit !== pins.commit) throw new Error('guardian_artifact_build_mismatch');
  const packageBytes=fs.readFileSync(regular(path.join(root,'package.json')));
  if (sha(packageBytes)!==m.packageJsonSha256 || JSON.parse(String(packageBytes)).version!==pins.version) throw new Error('guardian_artifact_package_version_mismatch');
  const expected = { daemon:pins.daemonEntryPath, cli:pins.cliEntryPath, host:pins.hostEntryPath };
  for (const kind of ['daemon','cli','host','helper'] as const) {
    const entry = m.files?.[kind];
    if (typeof entry?.path !== 'string' || path.isAbsolute(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) throw new Error('guardian_artifact_entry_untrusted');
    const file = path.resolve(root, entry.path);
    if (path.relative(root,file).startsWith('..') || (kind !== 'helper' && file !== expected[kind]) || sha(fs.readFileSync(regular(file))) !== entry.sha256) throw new Error('guardian_artifact_payload_pin_mismatch');
  }
  if (sha(fs.readFileSync(regular(pins.nodePath))) !== m.nodeSha256) throw new Error('guardian_artifact_node_pin_mismatch');
  const helperStat=fs.lstatSync(path.resolve(root,m.files.helper.path));
  if (helperStat.mode & 0o222) throw new Error('guardian_artifact_helper_writable');
  return { helperFileIdentity:JSON.stringify([helperStat.dev,helperStat.ino,helperStat.uid,helperStat.mode,helperStat.size]), helperPath:path.resolve(root,m.files.helper.path), helperSha256:m.files.helper.sha256, stateDir:pins.stateDir, helperProtocol:m.protocol };
}
