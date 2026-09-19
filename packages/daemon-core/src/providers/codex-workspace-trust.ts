/**
 * codex-workspace-trust — pre-launch folder-trust registration for codex.
 *
 * codex gates the first run in any new config root behind an interactive TUI
 * prompt. Captured live (codex 0.154.0, 80x32, through ghostty-vt):
 *
 *   > You are in /Users/vilmire/Work/adhdev
 *
 *     Do you trust the contents of this directory? Working with untrusted
 *     contents comes with higher risk of prompt injection. Trusting the
 *     directory allows project-local config, hooks, and exec policies to load.
 *
 *   › 1. Yes, continue
 *     2. No, quit
 *
 *     Press enter to continue
 *
 * ★Why this is needed even though the FSM *can* answer the modal.
 *
 * A delegated worker gets a PRIVATE `CODEX_HOME` whose directory name carries a
 * per-session hash (`…/adhdev-worker-home/codex-cli-<sha>`), so the trust store
 * is empty on EVERY launch and the prompt appears on EVERY launch. The FSM does
 * detect it and `mesh_approve` does answer it, but that makes a human approval a
 * standing precondition for automated work: a mesh task dispatched into a fresh
 * codex worker sits in `trust` with its body queued until somebody clicks. That
 * is a real throughput defect, not a cosmetic one — see the 2026-09-19 live
 * session where two tasks queued behind an unanswered trust modal.
 *
 * Granting it ahead of spawn removes the prompt entirely, which is the same
 * treatment kimi/grok/antigravity already get.
 *
 * ★Storage format — verified live, not inferred. Answering "1. Yes, continue"
 * with `CODEX_HOME` pointed at an empty directory writes exactly:
 *
 *   [projects."/Users/vilmire/Work/adhdev"]
 *   trust_level = "trusted"
 *
 * into `$CODEX_HOME/config.toml`. Note the differences from grok, which is why
 * this cannot reuse `grok_toml_file`: the table is `projects` (not `folders`),
 * the key is `trust_level = "trusted"` (not `trusted = true`), there is no
 * `decided_at`, and the file is codex's MAIN config — not a dedicated
 * trust-only store.
 *
 * ★That last difference is the one that matters for isolation. `config.toml` is
 * also where `[mcp_servers.*]` lives, so this module APPENDS one scoped table
 * and never copies, links, or templates the owner's file. Importing the owner's
 * `~/.codex/config.toml` wholesale would carry the owner's MCP server table into
 * the worker and collapse the worker-MCP isolation that
 * `delegatedWorkerIsolation` exists to enforce.
 *
 * OSS code (AGPL-3.0). Must not import from packages/ (proprietary).
 */
'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LOG } from '../logging/logger.js';

/**
 * codex's config root. Honors the `CODEX_HOME` override the binary itself
 * reads, then `env.HOME`, then `os.homedir()`.
 *
 * ★`env.HOME` is consulted before `os.homedir()` for the same reason grok's
 * resolver does it: `os.homedir()` reads the passwd entry on POSIX and so
 * returns the DAEMON's home even when the launch env redirects HOME. In codex's
 * case the primary path is `CODEX_HOME` (delegated launches always export it),
 * but the HOME fallback keeps a non-CODEX_HOME launch from silently writing the
 * worker's grant into the owner's personal store.
 */
function codexHome(env: NodeJS.ProcessEnv = process.env): string {
    const override = env.CODEX_HOME?.trim();
    if (override) return override;
    const home = env.HOME?.trim();
    return path.join(home || os.homedir(), '.codex');
}

/**
 * Resolve the canonical, real (symlink-followed) absolute form of the workspace
 * path. codex canonicalizes before keying the store — the entry written on
 * macOS for `/tmp/x` reads `/private/tmp/x` — so matching has to use the same
 * normalization. Falls back to the resolved path if the directory can't be
 * stat'd.
 */
function realWorkspacePath(workingDir: string): string {
    try {
        return fs.realpathSync(workingDir);
    } catch {
        return path.resolve(workingDir);
    }
}

/**
 * Never record an over-broad root. Mirrors the guard grok's writer applies: a
 * grant on `/`, on the user's home, or on the codex config root itself would
 * trust far more than the one directory being launched into.
 */
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
    if (normalized === codexHome(env).replace(/\/+$/, '')) return true;
    return false;
}

/** TOML basic-string escaping for the path used as the `[projects."…"]` key. */
function escapeTomlKey(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Does the store already carry a `[projects."<real>"]` table? Matches the
 * header line only — enough to stay idempotent without pulling in a TOML
 * parser, and a false negative merely rewrites an equivalent entry.
 *
 * ★Matching the HEADER rather than the trust value is deliberate: it means an
 * existing entry is never rewritten, which is what preserves a user's explicit
 * non-trusted decision instead of silently flipping it to trusted.
 */
function hasTrustEntry(contents: string, real: string): boolean {
    const needle = `[projects."${escapeTomlKey(real)}"]`;
    return contents.split(/\r?\n/).some((line) => line.trim() === needle);
}

/** Native codex TOML projection bytes, separated from HOME/store resolution. */
export function serializeCodexWorkspaceTrust(real: string): string {
    return `[projects."${escapeTomlKey(real)}"]\ntrust_level = "trusted"\n`;
}

/** The store file codex reads its project trust from, under the resolved root. */
export function codexTrustStorePath(env: NodeJS.ProcessEnv = process.env): string {
    return path.join(codexHome(env), 'config.toml');
}

/**
 * Idempotently pre-trust `workingDir` for codex so the first-run folder-trust
 * TUI prompt never appears.
 *
 * - Registers EXACTLY `workingDir`'s realpath — never a parent, never a
 *   wildcard. A workspace's repo content is not authored by us, so trust stays
 *   scoped to the single directory being launched into.
 * - APPENDS to `config.toml`, preserving every existing key and table. This
 *   file also holds `[mcp_servers.*]`, so a rewrite would be a correctness AND
 *   an isolation hazard; only the one new table is added.
 * - No-ops if a `[projects."<real>"]` table already exists, so an explicit
 *   user decision is never overwritten.
 * - Best-effort: any failure is logged and swallowed. A failed pre-trust must
 *   not block launch — the worst case is the pre-existing behavior (the prompt
 *   appears and the FSM detects it), not a crash.
 *
 * Returns the realpath registered, or null if nothing changed (already present,
 * over-broad, or an error occurred) — purely so callers/tests can assert the
 * effect.
 */
export function applyCodexWorkspaceTrust(workingDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
    const real = realWorkspacePath(workingDir);
    if (isOverBroadRoot(real, env)) {
        LOG.warn('codex-workspace-trust', `refusing to pre-trust over-broad root ${real}`);
        return null;
    }
    const storePath = codexTrustStorePath(env);
    try {
        let existing = '';
        try {
            existing = fs.readFileSync(storePath, 'utf8');
        } catch (err: any) {
            if (err?.code !== 'ENOENT') throw err;
        }
        if (hasTrustEntry(existing, real)) {
            LOG.debug('codex-workspace-trust', `${real} already has a trust entry — no change`);
            return null;
        }
        const entry = serializeCodexWorkspaceTrust(real);
        const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
        fs.mkdirSync(path.dirname(storePath), { recursive: true });
        fs.appendFileSync(storePath, `${separator}${entry}`, { encoding: 'utf8', mode: 0o600 });
        LOG.info('codex-workspace-trust', `pre-trusted workspace ${real}`);
        return real;
    } catch (err) {
        LOG.warn('codex-workspace-trust', `failed to pre-trust workspace ${real}: ${(err as Error).message}`);
        return null;
    }
}

// Exposed for tests only — not part of the module's public contract.
export const __test__ = { realWorkspacePath, codexHome, isOverBroadRoot, hasTrustEntry, escapeTomlKey };
