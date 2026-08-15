/**
 * grok-workspace-trust — pre-launch folder-trust registration for grok.
 *
 * grok gates a folder behind an interactive TUI prompt the first time it is
 * opened, but ONLY when the folder carries repo-local config that can execute
 * code. The binary states the condition verbatim:
 *
 *   "This folder contains repo-local config (.mcp.json / .grok/lsp.json /
 *    hooks) that can run commands on your mac"
 *
 * so a plain directory launches with no prompt at all — which is why this went
 * unnoticed until a workspace with a `.mcp.json` was used.
 *
 * The rendered prompt (captured live from grok 1.0.4 through ghostty-vt):
 *
 *   Do you trust the contents of this directory?
 *   <abs path>
 *   Grok Build may run or modify contents in this directory,
 *   posing security risks.
 *       Yes, proceed                 y
 *       No, quit                     n
 *
 * ★Unlike kimi, grok's DEFAULT IS TRUST — the binary's help line reads
 * "Enter or y to trust", and this was verified live: a bare `\r` answers the
 * prompt affirmatively and the session proceeds. So the daemon's routine
 * auto-Enter does not kill a grok session the way it killed kimi's (whose
 * default was "Don't trust — Exit"). Answering `n` does exit(0), but nothing
 * in the daemon sends `n`. This module therefore is NOT a crash fix; it
 * removes a prompt that otherwise strands the session with no answer path,
 * since the prompt renders no radio rows and no `N/M:select` footer and so
 * cannot be driven by the spec's generic approval-modal machinery.
 *
 * Storage is a single shared TOML file, `~/.grok/trusted_folders.toml`
 * (grok's "unified folder-trust store", also the gate for repo-local MCP/LSP
 * and project hooks). Verified live — answering `y` appends exactly:
 *
 *   [folders."/abs/real/path"]
 *   trusted = true
 *   decided_at = <unix seconds>
 *
 * This differs from kimi (one file per workspace under `workspace-trust/`) and
 * from antigravity (a JSON array in a settings file), so it needs its own
 * writer rather than reusing either mechanism.
 *
 * ★Why not `--trust`: grok does accept a `--trust` launch flag, but per its own
 * docs that grant "trusts the whole folder for MCP, LSP, and hooks together,
 * and cascades to subdirectories". That is materially broader than trusting the
 * one directory being launched into, so it is deliberately not used here.
 *
 * OSS code (AGPL-3.0). Must not import from packages/ (proprietary).
 */
'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LOG } from '../logging/logger.js';

/** grok's config home. Honors the `GROK_HOME` override the binary itself reads. */
function grokHome(env: NodeJS.ProcessEnv = process.env): string {
    const override = env.GROK_HOME?.trim();
    return override ? override : path.join(os.homedir(), '.grok');
}

/**
 * Resolve the canonical, real (symlink-followed) absolute form of the
 * workspace path. grok canonicalizes before keying the trust store — the
 * entry written on macOS for `/tmp/x` reads `/private/tmp/x` — so matching
 * has to use the same normalization. Falls back to the resolved path if the
 * directory can't be stat'd.
 */
function realWorkspacePath(workingDir: string): string {
    try {
        return fs.realpathSync(workingDir);
    } catch {
        return path.resolve(workingDir);
    }
}

/**
 * grok refuses to record "an over-broad root (home, filesystem root, or
 * non-absolute path)" — mirrored here so we never write an entry grok itself
 * would reject, and never widen trust beyond a real project directory.
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
    if (normalized === grokHome(env).replace(/\/+$/, '')) return true;
    return false;
}

/** TOML basic-string escaping for the path used as the `[folders."…"]` key. */
function escapeTomlKey(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Does the store already carry a `[folders."<real>"]` table? Matches the
 * header line only — enough to stay idempotent without pulling in a TOML
 * parser, and a false negative merely rewrites an equivalent entry.
 */
function hasTrustEntry(contents: string, real: string): boolean {
    const needle = `[folders."${escapeTomlKey(real)}"]`;
    return contents.split(/\r?\n/).some((line) => line.trim() === needle);
}

/**
 * Idempotently pre-trust `workingDir` for grok so the first-run folder-trust
 * TUI prompt never appears.
 *
 * - Registers EXACTLY `workingDir`'s realpath — never a parent, never a
 *   wildcard, never `--trust`'s cascading grant. A workspace's repo content
 *   (including any `.mcp.json`) is not authored by us, so trust stays scoped
 *   to the single directory being launched into.
 * - Appends to the shared store, preserving every existing entry. Never
 *   rewrites or reorders what is already there.
 * - No-ops if an entry for that path already exists (does not refresh
 *   `decided_at`, and never flips an existing `trusted = false` to true —
 *   an explicit distrust decision by the user must survive).
 * - Best-effort: any failure is logged and swallowed. A failed pre-trust must
 *   not block launch — the worst case is the pre-existing behavior (the prompt
 *   appears), not a crash.
 *
 * Returns the realpath registered, or null if nothing changed (already
 * present, over-broad, or an error occurred) — purely so callers/tests can
 * assert the effect.
 */
export function applyGrokWorkspaceTrust(workingDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
    const real = realWorkspacePath(workingDir);
    if (isOverBroadRoot(real, env)) {
        LOG.warn('grok-workspace-trust', `refusing to pre-trust over-broad root ${real}`);
        return null;
    }
    const storePath = path.join(grokHome(env), 'trusted_folders.toml');
    try {
        let existing = '';
        try {
            existing = fs.readFileSync(storePath, 'utf8');
        } catch (err: any) {
            if (err?.code !== 'ENOENT') throw err;
        }
        if (hasTrustEntry(existing, real)) {
            LOG.debug('grok-workspace-trust', `${real} already has a trust entry — no change`);
            return null;
        }
        const decidedAt = Math.floor(Date.now() / 1000);
        const entry = `[folders."${escapeTomlKey(real)}"]\ntrusted = true\ndecided_at = ${decidedAt}\n`;
        const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
        fs.mkdirSync(path.dirname(storePath), { recursive: true });
        fs.appendFileSync(storePath, `${separator}${entry}`, { encoding: 'utf8', mode: 0o600 });
        LOG.info('grok-workspace-trust', `pre-trusted workspace ${real}`);
        return real;
    } catch (err) {
        LOG.warn('grok-workspace-trust', `failed to pre-trust workspace ${real}: ${(err as Error).message}`);
        return null;
    }
}

// Exposed for tests only — not part of the module's public contract.
export const __test__ = { realWorkspacePath, grokHome, isOverBroadRoot, hasTrustEntry, escapeTomlKey };
