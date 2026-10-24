import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'node:path';
import { resolveInstanceConfigDir } from '@adhdev/session-host-core';

const INSTANCE_ARG_PREFIX = '--instance-config-key=';

export function sessionHostInstanceArg(configDir: string): string {
  const canonical = resolveInstanceConfigDir({ ADHDEV_CONFIG_DIR: configDir });
  const digest = createHash('sha256').update(canonical).digest('hex');
  return `${INSTANCE_ARG_PREFIX}${digest}`;
}

export function isManagedSessionHostCommandLine(
  commandLine: string | null | undefined,
  configDir?: string,
): boolean {
  if (!commandLine) return false;
  const tokens: string[] = [];
  const tokenRegex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(commandLine)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  if (tokens.length === 0) return false;

  const instanceTokens = tokens.filter((token) => token.startsWith(INSTANCE_ARG_PREFIX));
  const matchesInstanceArg = (): boolean => {
    if (instanceTokens.length !== 1) return false;
    if (configDir !== undefined) {
      return instanceTokens[0] === sessionHostInstanceArg(configDir);
    }
    return /^--instance-config-key=[0-9a-f]{64}$/.test(instanceTokens[0]);
  };

  const execBase = path.basename(tokens[0].replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
  if (execBase === 'adhdev-sessiond') {
    const subcommand = tokens[1]?.toLowerCase();
    if (subcommand && subcommand !== 'serve' && !subcommand.startsWith('-')) return false;
    return configDir !== undefined || instanceTokens.length > 0 ? matchesInstanceArg() : true;
  }
  if (execBase !== 'node') return false;

  const valueFlags = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--conditions', '-C']);
  let idx = 1;
  while (idx < tokens.length) {
    const token = tokens[idx];
    if (token === '--') {
      idx += 1;
      break;
    }
    if (token === '-e' || token === '--eval' || token === '-p' || token === '--print') {
      return false;
    }
    if (valueFlags.has(token)) {
      idx += 2;
      continue;
    }
    if (token.startsWith('-')) {
      idx += 1;
      continue;
    }
    break;
  }

  const scriptToken = tokens[idx];
  if (!scriptToken) return false;
  const normalizedScript = scriptToken.replace(/\\/g, '/').toLowerCase();
  const isSessionHostEntry =
    normalizedScript.endsWith('/session-host-daemon/dist/index.js')
    || normalizedScript.endsWith('/session-host-daemon/dist/index.mjs')
    || normalizedScript.endsWith('/session-host-daemon/index.js')
    || normalizedScript.endsWith('/session-host-daemon/src/index.ts')
    || path.basename(normalizedScript) === 'adhdev-sessiond';
  if (!isSessionHostEntry) return false;

  const subcommand = tokens[idx + 1]?.toLowerCase();
  if (subcommand && subcommand !== 'serve' && !subcommand.startsWith('-')) return false;
  return matchesInstanceArg();
}

export interface SessionHostReplacementProvenance {
  expectedPid: number;
  expectedBirth: string;
  instanceConfigDir?: string;
  instanceConfigKey?: string;
  expectedEndpointInode?: bigint;
  expectedBootId?: string;
  expectedEpoch?: number;
  expectedOwner?: string;
  expectedTokenHash?: string;
  activeRuntimeCount?: number;
  isCancelled?: () => boolean;
}

interface PersistedReplacementProvenanceFile {
  schema?: 1;
  schemaVersion?: 1;
  appName: string;
  instanceConfigDir: string;
  instanceConfigKey: string;
  endpointPath: string;
  expectedEndpointInode: string | null;
  expectedPid: number;
  expectedBirth: string;
  expectedBootId: string;
  expectedEpoch: number;
  expectedOwner: string;
  expectedTokenHash: string | null;
  activeRuntimeCount: 0;
  issuedAt?: number;
  issuedAtMs?: number;
}

export function readVerifiedReplacementProvenance(options: {
  provenanceFile?: string;
  provenanceFilePath?: string;
  instanceConfigDir: string;
  appName?: string;
  endpointPath: string;
  leaseStateDir?: string;
  nowMs?: () => number;
  skipDynamicWrap?: boolean;
}): SessionHostReplacementProvenance | undefined {
  const now = options.nowMs ? options.nowMs() : Date.now();
  const provenanceFile = options.provenanceFile ?? options.provenanceFilePath;
  try {
    if (!provenanceFile || !fs.existsSync(provenanceFile)) return undefined;
    const stat = fs.lstatSync(provenanceFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
      return undefined;
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      return undefined;
    }
    const parsed = JSON.parse(fs.readFileSync(provenanceFile, 'utf8')) as Partial<PersistedReplacementProvenanceFile>;
    if (!parsed || (parsed.schemaVersion !== 1 && parsed.schema !== 1)) return undefined;
    if (options.appName !== undefined && parsed.appName !== undefined && parsed.appName !== options.appName) {
      return undefined;
    }
    const canonicalDir = resolveInstanceConfigDir({ ADHDEV_CONFIG_DIR: options.instanceConfigDir });
    if (
      typeof parsed.instanceConfigDir !== 'string'
      || resolveInstanceConfigDir({ ADHDEV_CONFIG_DIR: parsed.instanceConfigDir }) !== canonicalDir
    ) {
      return undefined;
    }
    if (fs.existsSync(canonicalDir)) {
      const provenanceFiles = fs.readdirSync(canonicalDir).filter((entry) => entry.endsWith('-session-host-replacement.json'));
      if (provenanceFiles.length > 1) return undefined;
    }
    const expectedKey = sessionHostInstanceArg(canonicalDir);
    if (parsed.instanceConfigKey !== expectedKey) return undefined;
    const canonicalEndpointDir = fs.existsSync(path.dirname(options.endpointPath))
      ? fs.realpathSync(path.dirname(options.endpointPath))
      : path.resolve(path.dirname(options.endpointPath));
    const canonicalEndpointPath = path.join(canonicalEndpointDir, path.basename(options.endpointPath));
    const parsedEndpointDir = typeof parsed.endpointPath === 'string' && fs.existsSync(path.dirname(parsed.endpointPath))
      ? fs.realpathSync(path.dirname(parsed.endpointPath))
      : typeof parsed.endpointPath === 'string'
        ? path.resolve(path.dirname(parsed.endpointPath))
        : '';
    const parsedEndpointPath = typeof parsed.endpointPath === 'string'
      ? path.join(parsedEndpointDir, path.basename(parsed.endpointPath))
      : '';
    if (parsedEndpointPath !== canonicalEndpointPath) return undefined;
    if (typeof parsed.expectedPid !== 'number' || !Number.isFinite(parsed.expectedPid) || parsed.expectedPid <= 0) {
      return undefined;
    }
    const trimmedBirth = typeof parsed.expectedBirth === 'string' ? parsed.expectedBirth.trim() : '';
    if (!trimmedBirth || trimmedBirth.toLowerCase() === 'win32' || trimmedBirth.toLowerCase() === 'unknown') {
      return undefined;
    }
    if (typeof parsed.expectedBootId !== 'string' || !parsed.expectedBootId.trim()) {
      return undefined;
    }
    if (typeof parsed.expectedEpoch !== 'number' || !Number.isFinite(parsed.expectedEpoch) || parsed.expectedEpoch < 0) {
      return undefined;
    }
    if (typeof parsed.expectedOwner !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(parsed.expectedOwner.trim())) {
      return undefined;
    }
    if (parsed.activeRuntimeCount !== 0) {
      return undefined;
    }
    const issuedAtMs = parsed.issuedAtMs ?? parsed.issuedAt;
    if (
      typeof issuedAtMs !== 'number'
      || !Number.isFinite(issuedAtMs)
      || now - issuedAtMs > 60_000
      || issuedAtMs - now > 5_000
    ) {
      return undefined;
    }
    let expectedEndpointInode: bigint | undefined;
    if (parsed.expectedEndpointInode !== null && parsed.expectedEndpointInode !== undefined) {
      if (typeof parsed.expectedEndpointInode !== 'string' || !/^\d+$/.test(parsed.expectedEndpointInode)) {
        return undefined;
      }
      expectedEndpointInode = BigInt(parsed.expectedEndpointInode);
    }

    const effectiveLeaseStateDir = options.leaseStateDir ?? path.join(canonicalDir, 'session-host');
    if (effectiveLeaseStateDir) {
      const leaseFile = path.join(effectiveLeaseStateDir, 'upgrade-lease.json');
      if (!fs.existsSync(leaseFile)) return undefined;
      if (fs.existsSync(leaseFile)) {
        const leaseStat = fs.lstatSync(leaseFile);
        if (!leaseStat.isFile() || leaseStat.isSymbolicLink() || leaseStat.nlink !== 1 || (leaseStat.mode & 0o077) !== 0) {
          return undefined;
        }
        if (typeof process.getuid === 'function' && leaseStat.uid !== process.getuid()) {
          return undefined;
        }
        const lease = JSON.parse(fs.readFileSync(leaseFile, 'utf8')) as Record<string, unknown>;
        const leaseEndpointDir = typeof lease.endpoint === 'string' && fs.existsSync(path.dirname(lease.endpoint))
          ? fs.realpathSync(path.dirname(lease.endpoint))
          : typeof lease.endpoint === 'string'
            ? path.resolve(path.dirname(lease.endpoint))
            : '';
        const leaseEndpointPath = typeof lease.endpoint === 'string'
          ? path.join(leaseEndpointDir, path.basename(lease.endpoint))
          : '';
        if (
          lease.schema !== 1
          || lease.held !== true
          || leaseEndpointPath !== canonicalEndpointPath
          || lease.epoch !== parsed.expectedEpoch
          || lease.owner !== parsed.expectedOwner
          || typeof lease.tokenHash !== 'string'
          || !/^[a-f0-9]{64}$/.test(lease.tokenHash)
        ) {
          return undefined;
        }
        if (lease.bootId !== undefined && lease.bootId !== parsed.expectedBootId) {
          return undefined;
        }
        if (lease.pid !== undefined && lease.pid !== parsed.expectedPid) {
          return undefined;
        }
        if (
          lease.expiresAt !== undefined
          && (typeof lease.expiresAt !== 'number' || !Number.isFinite(lease.expiresAt) || lease.expiresAt <= now)
        ) {
          return undefined;
        }
        if (!parsed.expectedTokenHash || parsed.expectedTokenHash !== lease.tokenHash) {
          return undefined;
        }
      }
    }

    return {
      expectedPid: parsed.expectedPid,
      expectedBirth: trimmedBirth,
      instanceConfigDir: canonicalDir,
      instanceConfigKey: expectedKey,
      expectedEndpointInode,
      expectedBootId: parsed.expectedBootId.trim(),
      expectedEpoch: parsed.expectedEpoch,
      expectedOwner: parsed.expectedOwner.trim(),
      expectedTokenHash: parsed.expectedTokenHash ?? undefined,
      activeRuntimeCount: 0,
      isCancelled: options.skipDynamicWrap
        ? undefined
        : () =>
            readVerifiedReplacementProvenance({
              ...options,
              skipDynamicWrap: true,
            }) === undefined,
    };
  } catch {
    return undefined;
  }
}
