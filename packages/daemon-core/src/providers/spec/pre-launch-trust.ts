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
import { serializeGrokWorkspaceTrust } from '../grok-workspace-trust.js';
import { serializeCodexWorkspaceTrust } from '../codex-workspace-trust.js';
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
            if (trust.scheme === 'kimi_workspace_file') {
                // One file PER WORKSPACE: the file's mere existence means this
                // workspace was already decided, so existence is the idempotence key.
                if (fs.existsSync(settingsPath)) return null;
                fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
                fs.writeFileSync(settingsPath, serializeKimiWorkspaceTrust(real), 'utf8');
                return real;
            }
            if (trust.scheme === 'grok_toml_file') {
                // ★One SHARED TOML store for every folder. Existence therefore
                // proves nothing about THIS workspace (the file is already there
                // the moment any other folder was trusted), so idempotence is
                // keyed on the `[folders."<real>"]` table instead — and the write
                // must APPEND so sibling entries survive. Matching the header
                // line is enough to stay idempotent without a TOML parser; a
                // false negative merely rewrites an equivalent entry.
                //
                // An existing entry is never rewritten, which is what preserves a
                // user's explicit `trusted = false` decision.
                let existing = '';
                try {
                    existing = fs.readFileSync(settingsPath, 'utf8');
                } catch (err: any) {
                    if (err?.code !== 'ENOENT') throw err;
                }
                const header = `[folders."${real.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
                if (existing.split(/\r?\n/).some((line) => line.trim() === header)) {
                    LOG.debug('pre-launch-trust', `[${settingsPath}] ${real} already trusted — no change`);
                    return null;
                }
                const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
                fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
                fs.appendFileSync(
                    settingsPath,
                    `${separator}${serializeGrokWorkspaceTrust(real)}`,
                    { encoding: 'utf8', mode: 0o600 },
                );
                LOG.info('pre-launch-trust', `materialized ${plan.origin} grok folder trust in ${settingsPath}`);
                return real;
            }
            if (trust.scheme === 'codex_toml_file') {
                // ★Same shared-store shape as grok — append one scoped table,
                // keyed on the header for idempotence — but codex's table is
                // `[projects."<real>"]` with `trust_level = "trusted"`, and the
                // store is `config.toml`, codex's MAIN config.
                //
                // That last point is why this MUST append and must never
                // rewrite: `[mcp_servers.*]` lives in the same file, and the
                // worker's private config root exists precisely to keep the
                // owner's MCP table out of the worker. Rewriting the file — or
                // seeding it from the owner's copy — would undo the isolation
                // this grant is supposed to be orthogonal to.
                //
                // An existing entry is never rewritten, which preserves a
                // user's explicit non-trusted decision.
                let existing = '';
                try {
                    existing = fs.readFileSync(settingsPath, 'utf8');
                } catch (err: any) {
                    if (err?.code !== 'ENOENT') throw err;
                }
                const header = `[projects."${real.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
                if (existing.split(/\r?\n/).some((line) => line.trim() === header)) {
                    LOG.debug('pre-launch-trust', `[${settingsPath}] ${real} already trusted — no change`);
                    return null;
                }
                const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
                fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
                fs.appendFileSync(
                    settingsPath,
                    `${separator}${serializeCodexWorkspaceTrust(real)}`,
                    { encoding: 'utf8', mode: 0o600 },
                );
                LOG.info('pre-launch-trust', `materialized ${plan.origin} codex project trust in ${settingsPath}`);
                return real;
            }
            if (trust.scheme === 'claude_json_projects') {
                // ★`~/.claude.json`'s `projects` is an OBJECT-OF-OBJECTS keyed by
                // realpath, not an array or a per-folder TOML table — see
                // providers/claude-workspace-trust.ts for the full shape
                // (verified live). The write must be SPARSE: only the one
                // `hasTrustDialogAccepted` field is ever touched, on only the one
                // key for this workspace. A brand-new key gets exactly
                // `{ hasTrustDialogAccepted: true }`; an existing key keeps every
                // other session-history field Claude Code itself owns
                // (mcpServers, lastSessionId, allowedTools, …) byte-for-byte.
                // Idempotence is keyed on the CURRENT VALUE of that one field,
                // not mere key presence, so a second call is a true no-op.
                let root: Record<string, unknown> = {};
                try {
                    const text = fs.readFileSync(settingsPath, 'utf8');
                    if (text.trim().length > 0) {
                        const parsed = JSON.parse(text);
                        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                            root = parsed as Record<string, unknown>;
                        }
                    }
                } catch (err: any) {
                    if (err?.code !== 'ENOENT') throw err;
                }
                const projectsRaw = root.projects;
                const projects: Record<string, unknown> = (projectsRaw && typeof projectsRaw === 'object' && !Array.isArray(projectsRaw))
                    ? projectsRaw as Record<string, unknown>
                    : {};
                const existingRaw = projects[real];
                const existing: Record<string, unknown> = (existingRaw && typeof existingRaw === 'object' && !Array.isArray(existingRaw))
                    ? existingRaw as Record<string, unknown>
                    : {};
                if (existing.hasTrustDialogAccepted === true) {
                    LOG.debug('pre-launch-trust', `[${settingsPath}] ${real} already trusted — no change`);
                    return null;
                }
                projects[real] = { ...existing, hasTrustDialogAccepted: true };
                root.projects = projects;
                fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
                const tmp = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
                fs.writeFileSync(tmp, `${JSON.stringify(root, null, 2)}\n`, 'utf8');
                fs.renameSync(tmp, settingsPath);
                LOG.info('pre-launch-trust', `materialized ${plan.origin} claude project trust in ${settingsPath}`);
                return real;
            }
            return null;
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
