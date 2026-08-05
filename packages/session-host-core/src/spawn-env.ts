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
            || key.startsWith('VSCODE_')
            || key.startsWith('ELECTRON_')
        ) {
            delete env[key];
        }
    }

    // Do not leak parent Codex session controls into child CLIs. Thread identity
    // breaks providerSessionId discovery/reconnect semantics, while the parent's
    // network-disabled sandbox flag prevents coordinator MCP children from
    // connecting back to the local ADHDev daemon.
    delete env.CODEX_THREAD_ID;
    delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
    delete env.CODEX_SANDBOX_NETWORK_DISABLED;
    delete env.NO_COLOR;
    delete env.COLOR;

    // Do not leak a parent Claude Code session identity into spawned claude-cli
    // children. CLAUDE_CODE_CHILD_SESSION makes a spawned claude run as a nested
    // child that does NOT persist its ~/.claude/projects transcript, so the
    // native-source history reader finds no file and the live dashboard renders
    // empty. This bites when the daemon itself was launched from inside a Claude
    // Code session (the markers are inherited and forwarded to every child).
    // Unconditional: originally scoped to win32 (35b462c5) because the bug had
    // only been OBSERVED there at the time — the Windows daemon that surfaced it
    // happened to have been launched from inside a Claude Code session, and
    // macOS/Linux "looked fine" only because no one had hit that same launch
    // circumstance yet, not because the platform behaves differently. The
    // marker-inheritance mechanism itself was never platform-specific — nothing
    // about how Claude Code detects a nested child session depends on OS.
    // Confirmed reproduced identically on darwin (live coordinator measurement,
    // this task): a daemon started from inside a Claude Code session inherits
    // and forwards the same markers there too. A daemon-spawned claude should
    // always be a fresh top-level session, on every platform — exactly what the
    // original commit already called out as "safe to make unconditional later."
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_CHILD_SESSION;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.CLAUDE_CODE_EXECPATH;
    // CLAUDE_CODE_BRIDGE_SESSION_ID is the same kind of parent-identity marker
    // (observed grouped with CLAUDECODE/CLAUDE_CODE_SESSION_ID/
    // CLAUDE_CODE_CHILD_SESSION/CLAUDE_CODE_EXECPATH in the installed `claude`
    // binary's own env-var table, alongside a `buildBridgeReattachEnvFromState`
    // helper) — it identifies the parent's remote bridge/reattach session. Left
    // in place, a spawned child could try to reattach to the PARENT's remote
    // session instead of starting fresh, which is a worse variant of the same
    // "not actually a fresh top-level session" bug this block exists to prevent.
    delete env.CLAUDE_CODE_BRIDGE_SESSION_ID;

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
