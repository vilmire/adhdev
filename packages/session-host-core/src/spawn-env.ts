/**
 * Shared PTY spawn environment utilities.
 *
 * Centralises npm/pnpm/yarn env variable stripping, terminal colour env
 * injection, and node-pty spawn-helper permission fixing.
 *
 * Used by daemon-core (provider-cli-adapter), session-host-daemon (runtime),
 * and daemon-cloud (session-host).
 */

import * as os from 'os';
import * as path from 'path';

/**
 * Strip package-manager injected environment variables that can interfere
 * with child CLI processes and apply terminal colour defaults.
 */
export function sanitizeSpawnEnv(
    baseEnv: NodeJS.ProcessEnv,
    overrides?: Record<string, string>,
): Record<string, string> {
    const env: Record<string, string> = {};
    const source = { ...baseEnv, ...(overrides || {}) } as NodeJS.ProcessEnv;

    for (const [key, value] of Object.entries(source)) {
        if (typeof value !== 'string') continue;
        env[key] = value;
    }

    for (const key of Object.keys(env)) {
        if (
            key === 'INIT_CWD'
            || key === 'npm_command'
            || key === 'npm_execpath'
            || key === 'npm_node_execpath'
            || key.startsWith('npm_')
            || key.startsWith('npm_config_')
            || key.startsWith('npm_package_')
            || key.startsWith('npm_lifecycle_')
            || key.startsWith('PNPM_')
            || key.startsWith('YARN_')
            || key.startsWith('BUN_')
        ) {
            delete env[key];
        }
    }

    applyTerminalColorEnv(env);
    return env;
}

/**
 * Apply preferred terminal colour environment variables.
 * Ensures TERM is set to xterm-256color and enables colour on Windows.
 */
export function applyTerminalColorEnv(env: Record<string, string>): void {
    if (env.NO_COLOR) return;

    if (!env.TERM || env.TERM === 'xterm-color') {
        env.TERM = 'xterm-256color';
    }
    if (!env.COLORTERM) env.COLORTERM = 'truecolor';

    if (process.platform === 'win32') {
        if (!env.FORCE_COLOR) env.FORCE_COLOR = '1';
        if (!env.CLICOLOR) env.CLICOLOR = '1';
    }
}

/**
 * Ensure node-pty's spawn-helper binary has execute permissions.
 *
 * npm's default umask can strip +x from the prebuilt spawn-helper on macOS/Linux,
 * causing EACCES when node-pty tries to fork. Best-effort fix.
 *
 * @param logFn Optional log callback for reporting the fix.
 */
export function ensureNodePtySpawnHelperPermissions(
    logFn?: (msg: string) => void,
): void {
    if (os.platform() === 'win32') return;
    try {
        const fs = require('fs');
        const ptyDir = path.resolve(path.dirname(require.resolve('node-pty')), '..');
        const platformArch = `${os.platform()}-${os.arch()}`;
        const helper = path.join(ptyDir, 'prebuilds', platformArch, 'spawn-helper');
        if (fs.existsSync(helper)) {
            const stat = fs.statSync(helper);
            if (!(stat.mode & 0o111)) {
                fs.chmodSync(helper, stat.mode | 0o755);
                logFn?.(`Fixed spawn-helper permissions: ${helper}`);
            }
        }
    } catch {
        // best-effort: node-pty still works on most installs without this
    }
}
