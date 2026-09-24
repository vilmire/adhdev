/**
 * claude-workspace-trust — pre-launch folder-trust registration for claude-cli.
 *
 * Claude Code gates the first run in any new folder behind an interactive
 * "Do you trust the files in this folder?" prompt. Unlike antigravity/kimi/
 * grok/codex, claude-cli has NO worker-private HOME (it is absent from
 * `WORKER_PRIVATE_HOME_SPECS` in mesh/worker-mcp-isolation.ts) — a delegated
 * worker runs with the REAL HOME, so this module always targets the owner's
 * actual trust store. There is no isolation axis to thread here: pre-trusting
 * a fresh worktree clone for claude-cli means adding that one path to the
 * SAME file the interactively-run CLI reads.
 *
 * ★Storage format — read live from this machine's own `~/.claude.json`
 * (`kjs0116@dstrict.com`'s Claude Code account, read-only, no values printed):
 * top-level key `projects`, a JSON OBJECT keyed by the ABSOLUTE real project
 * path (verified: `/Users/vilmire` and `/Users/vilmire/Work/adhdev` are both
 * present as keys), each value an object carrying (among many session-stat
 * fields) a boolean `hasTrustDialogAccepted`. The live adhdev entry reads
 * `hasTrustDialogAccepted: true`. This is NOT an array-of-strings store (the
 * generic `PreLaunchTrustSettingsArray` scheme does not fit) and NOT a
 * one-file-per-workspace or shared-TOML store (kimi/grok/codex schemes do not
 * fit either) — it is its own named scheme, `claude_json_projects`.
 *
 * ★Why APPEND-ONLY / SPARSE, never a full projected object: `projects[path]`
 * on a real install carries dozens of session-history fields (`lastCost`,
 * `lastSessionId`, `mcpServers`, `allowedTools`, …) that Claude Code itself
 * populates and reads. Writing anything beyond `{ hasTrustDialogAccepted:
 * true }` for a NEW key would be inventing state we have no authority over;
 * clobbering an EXISTING key would erase the owner's real session history for
 * that path. So this writer:
 *   - creates a new entry with ONLY `hasTrustDialogAccepted: true` when the
 *     path is not yet a key;
 *   - for an existing entry, flips `hasTrustDialogAccepted` to `true` ONLY if
 *     it is not already `true` — every other field on that entry is left
 *     byte-for-byte untouched;
 *   - never removes a key, never touches a sibling path's entry, never
 *     rewrites the rest of `~/.claude.json` (`theme`, `oauthAccount`, etc.).
 * This mirrors the array-store scheme's "preserve everything else" contract
 * one level deeper (object-of-objects instead of object-of-arrays).
 *
 * ★Never flips an explicit `false`... there isn't one to preserve: Claude Code
 * has no "explicitly distrust" state (declining the prompt exits the CLI
 * rather than persisting a negative decision), so unlike grok/codex there is
 * no "already decided, and decided no" case this writer must avoid stomping.
 * `hasTrustDialogAccepted` is monotonic — once true, a re-run of this
 * function is a no-op (idempotence key = current value, not mere presence).
 *
 * OSS code (AGPL-3.0). Must not import from packages/ (proprietary).
 */
'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { LOG } from '../logging/logger.js';

/**
 * Claude Code's config directory. Honors the same `CLAUDE_CONFIG_DIR`
 * override the CLI itself reads (verified against 2.1.220 by
 * `quota/statusline/paths.ts::claudeConfigDir` — pointing it at a temp dir
 * makes the CLI write `.claude.json` alongside `settings.json` there).
 *
 * ★`env.HOME` is consulted before `os.homedir()` for the same reason
 * codex/grok's resolvers do: `os.homedir()` reads the passwd entry on POSIX
 * and so returns the DAEMON's home even when a launch env redirects HOME.
 * claude-cli has no private-HOME axis today, so in practice this always
 * resolves to the real home — but resolving env first keeps this module
 * correct if that ever changes, exactly like codex's CODEX_HOME-first note.
 */
function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
    const override = env.CLAUDE_CONFIG_DIR?.trim();
    if (override) return override;
    const home = env.HOME?.trim();
    return path.join(home || os.homedir(), '.claude');
}

/** The store claude-cli reads project trust from — sibling of `.claude/settings.json`'s dir. */
export function claudeTrustStorePath(env: NodeJS.ProcessEnv = process.env): string {
    return path.join(path.dirname(claudeConfigDir(env)), '.claude.json');
}

/**
 * Resolve the canonical, real (symlink-followed) absolute form of the
 * workspace path — claude-cli keys `projects` by the real path (matches the
 * live-observed `/Users/vilmire/Work/adhdev` key, not any symlinked alias).
 */
function realWorkspacePath(workingDir: string): string {
    try {
        return fs.realpathSync(workingDir);
    } catch {
        return path.resolve(workingDir);
    }
}

/** Never record an over-broad root — mirrors codex/grok's guard. */
function isOverBroadRoot(real: string, env: NodeJS.ProcessEnv = process.env): boolean {
    if (!path.isAbsolute(real)) return true;
    const normalized = real.replace(/\/+$/, '') || '/';
    if (normalized === '/' || path.dirname(normalized) === normalized) return true;
    const home = (() => {
        try {
            return fs.realpathSync(os.homedir());
        } catch {
            return os.homedir();
        }
    })();
    if (normalized === home.replace(/\/+$/, '')) return true;
    return false;
}

/** Read `~/.claude.json` as a plain object; tolerant of a missing/malformed file. */
function readJsonObject(storePath: string): Record<string, unknown> {
    try {
        const text = fs.readFileSync(storePath, 'utf8');
        if (!text.trim()) return {};
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
        return {};
    } catch (err: any) {
        if (err?.code === 'ENOENT') return {};
        throw err;
    }
}

/** Atomic write — write-temp-then-rename so a crash mid-write can't corrupt the owner's real config. */
function writeJsonObjectAtomic(storePath: string, data: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const tmp = `${storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, storePath);
}

/**
 * Idempotently pre-trust `workingDir` for claude-cli so the first-run folder
 * -trust prompt never appears.
 *
 * - Registers EXACTLY `workingDir`'s realpath as a `projects` key — never a
 *   parent, never a wildcard.
 * - Sparse write: a brand-new key gets `{ hasTrustDialogAccepted: true }` and
 *   nothing else; an EXISTING key has only `hasTrustDialogAccepted` set,
 *   every other field left untouched.
 * - No-ops (returns null) when the entry already reads
 *   `hasTrustDialogAccepted: true` — idempotent, no rewrite, no file touch.
 * - Best-effort: any failure is logged and swallowed. A failed pre-trust must
 *   not block the launch — the worst case is the pre-existing behavior (the
 *   prompt appears and the FSM's reactive auto-approve handles it), not a
 *   crash.
 *
 * Returns the realpath registered, or null if nothing changed (already
 * trusted, over-broad, or an error occurred) — purely so callers/tests can
 * assert the effect.
 */
export function applyClaudeWorkspaceTrust(workingDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
    const real = realWorkspacePath(workingDir);
    if (isOverBroadRoot(real, env)) {
        LOG.warn('claude-workspace-trust', `refusing to pre-trust over-broad root ${real}`);
        return null;
    }
    const storePath = claudeTrustStorePath(env);
    try {
        const root = readJsonObject(storePath);
        const projectsRaw = root.projects;
        const projects: Record<string, unknown> = (projectsRaw && typeof projectsRaw === 'object' && !Array.isArray(projectsRaw))
            ? projectsRaw as Record<string, unknown>
            : {};

        const existingRaw = projects[real];
        const existing: Record<string, unknown> = (existingRaw && typeof existingRaw === 'object' && !Array.isArray(existingRaw))
            ? existingRaw as Record<string, unknown>
            : {};

        if (existing.hasTrustDialogAccepted === true) {
            LOG.debug('claude-workspace-trust', `${real} already trusted — no change`);
            return null;
        }

        // Sparse merge: only ever touch this ONE field on this ONE entry.
        projects[real] = { ...existing, hasTrustDialogAccepted: true };
        root.projects = projects;

        writeJsonObjectAtomic(storePath, root);
        LOG.info('claude-workspace-trust', `pre-trusted workspace ${real}`);
        return real;
    } catch (err) {
        LOG.warn('claude-workspace-trust', `failed to pre-trust workspace ${real}: ${(err as Error).message}`);
        return null;
    }
}

/**
 * FsmDriver.start() entry point for the `claude_json_projects` scheme.
 *
 * ★claude-cli has NO worker-private HOME (absent from `WORKER_PRIVATE_HOME_
 * SPECS` in mesh/worker-mcp-isolation.ts), so `cli-delegated-launch` never
 * resolves a trust plan for it — the driver's `resolvedTrustPlan` is always
 * undefined for this scheme, delegated launch or not. There is therefore only
 * ONE path, not a delegated/non-delegated split like codex/grok's own
 * `apply*WorkspaceTrust` entry points: this always targets whatever HOME the
 * launch actually runs with. For a delegated worker that is the REAL HOME
 * (claude-cli workers are not HOME-redirected), so the grant lands in the
 * owner's own `~/.claude.json` — which is correct here, not a leak, because
 * that IS the file the worker process will read.
 *
 * Kept here rather than inlined in fsm-driver.ts to keep that file under the
 * repo's file-size gate (`npm run check:file-sizes`) — the merge logic itself
 * lives in `applyClaudeWorkspaceTrust` above; this is just the env assembly
 * the driver would otherwise repeat inline.
 */
export function applyPreLaunchTrustForClaude(workingDir: string, extraEnv?: Record<string, string>): string | null {
    return applyClaudeWorkspaceTrust(workingDir, { ...process.env, ...(extraEnv || {}) });
}

// Exposed for tests only — not part of the module's public contract.
export const __test__ = { realWorkspacePath, claudeConfigDir, isOverBroadRoot };
