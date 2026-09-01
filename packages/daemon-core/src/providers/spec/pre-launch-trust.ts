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
import * as path from 'node:path';
import type { PreLaunchTrust } from './fsm-types.js';
import { serializeKimiWorkspaceTrust } from '../kimi-workspace-trust.js';
import type { ResolvedTrustPlan } from '../trust-provenance-ledger.js';
import { LOG } from '../../logging/logger.js';

/**
 * Idempotently materialize a resolved grant into the provider's native store.
 * `plan.storePath` and `plan.workspaceRealpath` were fixed by launch planning;
 * this runtime step deliberately performs no HOME or workspace path resolution.
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
export function applyPreLaunchTrust(trust: PreLaunchTrust, plan: ResolvedTrustPlan): string | null {
    const settingsPath = plan.storePath;
    const real = plan.workspaceRealpath;
    if (!path.isAbsolute(settingsPath) || !path.isAbsolute(real)) {
        LOG.warn('pre-launch-trust', 'refusing unresolved trust plan with non-absolute paths');
        return null;
    }
    try {
        if ('scheme' in trust) {
            if (trust.scheme !== 'kimi_workspace_file') return null;
            if (fs.existsSync(settingsPath)) return null;
            fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
            fs.writeFileSync(settingsPath, serializeKimiWorkspaceTrust(real), 'utf8');
            return real;
        }

        const key = trust.key;
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
            LOG.debug('pre-launch-trust', `[${settingsPath}] ${real} already trusted — no change`);
            return null;
        }

        list.push(real);
        parsed[key] = list;

        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        fs.writeFileSync(settingsPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
        LOG.info('pre-launch-trust', `materialized ${plan.origin} workspace trust in ${settingsPath} (key="${key}")`);
        return real;
    } catch (err) {
        LOG.warn('pre-launch-trust', `failed to materialize workspace trust in ${settingsPath}: ${(err as Error).message}`);
        return null;
    }
}
