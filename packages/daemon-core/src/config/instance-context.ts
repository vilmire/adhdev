/**
 * ADHDev runtime instance context — the single typed derivation of "which
 * install instance am I" for daemon lifecycle, session-host IPC, upgrade
 * handoff, logging, and provider/mesh stores.
 *
 * Identity rule: the instance IS its config dir. `ADHDEV_CONFIG_DIR` (pinned
 * by the installer/service for preview, or set explicitly) selects it;
 * absent/blank resolves to the running build track's home config dir
 * (`<home>/.adhdev` stable, `<home>/.adhdev-preview` preview — see
 * track-identity.ts).
 * Every mutable path (config/state, providers store, mesh/runtime stores,
 * logs, pids, session-host socket/pid/state, upgrade handoff) lives under or
 * is derived from this one resolution — consumers must NOT re-derive ad hoc.
 *
 * Fail closed: an explicit `configDir` that conflicts with the environment's
 * `ADHDEV_CONFIG_DIR` throws instead of merging namespaces.
 */

import * as os from 'os';
import * as path from 'path';
import {
    canonicalizeInstancePath,
    isDefaultInstanceConfigDir,
    resolveSessionHostIpcKey,
} from '@adhdev/session-host-core';
import { resolveConfigDir } from './config-dir.js';
import { resolveSessionHostAppName } from '../session-host/app-name.js';

export interface InstanceContext {
    /**
     * Config dir as resolved from inputs (ADHDEV_CONFIG_DIR verbatim when set,
     * else `<home>/.adhdev`). Use this for filesystem paths so explicit
     * override spellings are preserved (matches getConfigDir()).
     */
    readonly configDir: string;
    /** Canonical (absolute, symlink-resolved, case-folded on win32) config dir. */
    readonly canonicalConfigDir: string;
    /** Config-dir basename — the instance token (`.adhdev`, `.adhdev-preview`, …). */
    readonly instanceDir: string;
    /** True when configDir canonicalizes to the default `<home>/.adhdev`. */
    readonly isDefault: boolean;
    /**
     * Session-host IPC namespace key: '' for the default instance (legacy
     * endpoint preserved), otherwise a stable 12-hex hash of the canonical
     * config dir. Feed into getDefaultSessionHostEndpoint(appName, { ipcKey }).
     */
    readonly ipcKey: string;
    /** Session-host namespace (app name) for this process role. */
    readonly sessionHostAppName: string;
}

export class InstanceContextConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InstanceContextConflictError';
    }
}

export interface ResolveInstanceContextOptions {
    /**
     * Explicit config dir override. When the environment ALSO pins
     * `ADHDEV_CONFIG_DIR` to a canonically different directory, resolution
     * fails closed (InstanceContextConflictError) rather than silently picking
     * one — two sources of instance identity must never be merged.
     */
    configDir?: string;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    /** Standalone daemons resolve the reserved standalone session-host namespace. */
    standalone?: boolean;
}

let cached: { key: string; context: InstanceContext } | null = null;

export function resolveInstanceContext(options: ResolveInstanceContextOptions = {}): InstanceContext {
    const env = options.env ?? process.env;
    const homeDir = options.homeDir ?? os.homedir();
    const envDir = typeof env.ADHDEV_CONFIG_DIR === 'string' ? env.ADHDEV_CONFIG_DIR.trim() : '';
    const explicitDir = typeof options.configDir === 'string' ? options.configDir.trim() : '';

    if (explicitDir && envDir
        && canonicalizeInstancePath(explicitDir) !== canonicalizeInstancePath(envDir)) {
        throw new InstanceContextConflictError(
            `Conflicting instance identity: explicit configDir "${explicitDir}" vs `
            + `ADHDEV_CONFIG_DIR "${envDir}". Refusing to merge mutable namespaces — `
            + 'fix the caller or unset one of the two.',
        );
    }

    const configDir = explicitDir || resolveConfigDir(env, homeDir);
    const trimmed = configDir.replace(/[\\/]+$/, '');
    return {
        configDir,
        canonicalConfigDir: canonicalizeInstancePath(configDir),
        instanceDir: path.basename(trimmed) || '.adhdev',
        isDefault: isDefaultInstanceConfigDir(configDir, homeDir),
        ipcKey: resolveSessionHostIpcKey(configDir, homeDir),
        sessionHostAppName: resolveSessionHostAppName({ standalone: options.standalone, env }),
    };
}

/**
 * Process-wide instance context. Cached per (env config-dir, home, role)
 * triple so repeat callers (managed-host factory methods, logging, upgrade
 * handoff) share one resolution without re-deriving. Resolution is cheap and
 * pure; the cache only exists to make the "one context per process" contract
 * explicit. Tests that mutate ADHDEV_CONFIG_DIR between cases get a fresh
 * context automatically because the cache key includes the env value.
 */
export function getProcessInstanceContext(options: Pick<ResolveInstanceContextOptions, 'standalone'> = {}): InstanceContext {
    const envDir = typeof process.env.ADHDEV_CONFIG_DIR === 'string' ? process.env.ADHDEV_CONFIG_DIR.trim() : '';
    const key = `${envDir}|${os.homedir()}|${options.standalone ? 'standalone' : 'daemon'}`;
    if (!cached || cached.key !== key) {
        cached = { key, context: resolveInstanceContext({ standalone: options.standalone }) };
    }
    return cached.context;
}

/** Test hook: drop the cached process context. */
export function resetProcessInstanceContextForTests(): void {
    cached = null;
}
