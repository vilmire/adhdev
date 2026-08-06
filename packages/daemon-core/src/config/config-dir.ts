/**
 * Config-dir resolution — the single source of truth for WHERE the ADHDev home
 * directory (~/.adhdev, or ADHDEV_CONFIG_DIR when pinned) and its logs/
 * subdirectory live.
 *
 * Every consumer that needs the config dir or the logs dir must derive it from
 * here instead of re-implementing the `ADHDEV_CONFIG_DIR || ~/.adhdev` rule:
 * past copies drifted (missing mkdir, import-time snapshots freezing the env).
 *
 * Deliberately a LEAF module: node builtins only, no other daemon-core imports,
 * so cheap consumers (logger, command-log) can use it without pulling config
 * loading. Resolution is PURE (no mkdir side effect) and evaluates `env` /
 * `homedir()` at CALL time, so an ADHDEV_CONFIG_DIR assigned after module load
 * (tests, daemon boot ordering) is honored on the next call.
 *
 * Mirrors that CANNOT import this module and must stay manually in sync:
 *  - daemon-cloud/src/daemon-early-crash-guard.ts (builtin-only crash guard —
 *    importing daemon-core would load the native addon it guards against)
 *  - session-host-core/src/instance-key.ts (daemon-core depends on
 *    session-host-core, so the reverse import would be a cycle)
 */

import { homedir } from 'os';
import { join } from 'path';

export const DEFAULT_CONFIG_DIR_NAME = '.adhdev';

/**
 * Resolve the config dir WITHOUT creating it: ADHDEV_CONFIG_DIR (trimmed) when
 * set, else `<homeDir>/.adhdev`. Callers that need the dir to exist use
 * getConfigDir() (config.ts), which adds the mkdir.
 *
 * homedir() is called ONLY in the fallback branch, never as a default
 * parameter value: a default arg evaluates even when the env override wins,
 * which both wastes a syscall on every call and trips test mocks whose
 * homedir stub closes over a not-yet-initialized binding at module load.
 */
export function resolveConfigDir(
    env: NodeJS.ProcessEnv = process.env,
    homeDir?: string,
): string {
    const override = env.ADHDEV_CONFIG_DIR;
    return override && override.trim()
        ? override.trim()
        : join(homeDir ?? homedir(), DEFAULT_CONFIG_DIR_NAME);
}

/** `<configDir>/logs` — daemon log, command history, service stdio capture. */
export function resolveConfigLogsDir(
    env: NodeJS.ProcessEnv = process.env,
    homeDir?: string,
): string {
    return join(resolveConfigDir(env, homeDir), 'logs');
}
