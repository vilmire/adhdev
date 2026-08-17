/**
 * pre_launch_trust — generic, declarative "trust this folder before spawn"
 * step for spec-backed CLI providers.
 *
 * Some agent CLIs (the canonical case is antigravity's `agy`) gate the first
 * run in any new folder behind an interactive "Do you trust the files in this
 * folder?" prompt. Under the v4 FSM spec path the daemon spawns the binary
 * directly in the worktree (`cwd = workingDir`), so every fresh worktree —
 * every delegated mesh task running in its own clone — hits that prompt and
 * stalls until something clicks through it. (The legacy bash-wrapper symlink
 * trick in provider.v1.json's `spawn` block is not used by SpecCliAdapter.)
 *
 * These CLIs persist their trusted folders in a JSON settings file as a string
 * array. If we add the workspace path to that array *before* spawning, the
 * prompt never appears. That is the most robust fix: the agent runs trusted
 * from the first frame instead of relying on the FSM to detect and auto-click
 * a modal whose wording or position could drift.
 *
 * The mechanism is intentionally data-driven and CLI-agnostic. A spec declares
 * the settings file and the array key; the engine does the rest. CLIs that do
 * not have a folder-trust gate simply omit `pre_launch_trust` and this code
 * never runs for them — so other providers (claude/codex/hermes) are untouched.
 */
'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PreLaunchTrust } from './fsm-types.js';
import { applyKimiWorkspaceTrust } from '../kimi-workspace-trust.js';
import { LOG } from '../../logging/logger.js';

/** Expand a leading `~` to the user's home directory. */
function expandHome(p: string): string {
    if (p === '~') return os.homedir();
    if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
    return p;
}

/**
 * Resolve the canonical, real (symlink-followed) absolute form of the
 * workspace path. Trust files store realpaths, and matching has to be exact, so
 * we normalise the same way the CLI does. Falls back to the raw path if the
 * directory can't be stat'd (e.g. it does not exist yet).
 */
function realWorkspacePath(workingDir: string): string {
    try {
        return fs.realpathSync(workingDir);
    } catch {
        return path.resolve(workingDir);
    }
}

/**
 * Idempotently add `workingDir` (realpath) to the trusted-folders array named
 * by `trust.key` inside the JSON settings file at `trust.settings_path`.
 *
 * - Creates the file (and parent dir) if missing.
 * - Preserves all other settings; only the trust array is touched.
 * - No-ops if the path is already present.
 * - Best-effort: any failure is logged and swallowed. A failed pre-trust must
 *   not block the launch — the worst case is the old behavior (the FSM still
 *   detects the trust modal as an approval state), not a crash.
 *
 * Returns the path that was added (realpath), or null if nothing changed /
 * an error occurred — purely so callers/tests can assert the effect.
 */
export function applyPreLaunchTrust(trust: PreLaunchTrust, workingDir: string): string | null {
    if ('scheme' in trust) {
        // Named per-workspace-file scheme (fsm-types.PreLaunchTrustScheme):
        // the trust store is one file per workspace, not an array in a
        // settings file. Same best-effort contract as below — a failure never
        // blocks launch, the FSM's trust-modal detection remains the fallback.
        if (trust.scheme === 'kimi_workspace_file') return applyKimiWorkspaceTrust(workingDir);
        return null; // unknown scheme: validator rejects at load; fail open at runtime
    }
    const settingsPath = expandHome(trust.settings_path);
    const key = trust.key;
    const real = realWorkspacePath(workingDir);
    try {
        let parsed: Record<string, unknown> = {};
        if (fs.existsSync(settingsPath)) {
            const text = fs.readFileSync(settingsPath, 'utf8');
            if (text.trim().length > 0) {
                const json = JSON.parse(text);
                if (json && typeof json === 'object' && !Array.isArray(json)) {
                    parsed = json as Record<string, unknown>;
                }
            }
        }

        const existing = parsed[key];
        const list: string[] = Array.isArray(existing)
            ? existing.filter((v): v is string => typeof v === 'string')
            : [];

        if (list.includes(real)) {
            LOG.debug('pre-launch-trust', `[${trust.settings_path}] ${real} already trusted — no change`);
            return null;
        }

        list.push(real);
        parsed[key] = list;

        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        fs.writeFileSync(settingsPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
        LOG.info('pre-launch-trust', `pre-trusted workspace in ${trust.settings_path} (key="${key}")`);
        return real;
    } catch (err) {
        LOG.warn('pre-launch-trust', `failed to pre-trust workspace in ${trust.settings_path}: ${(err as Error).message}`);
        return null;
    }
}
