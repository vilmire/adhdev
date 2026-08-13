/**
 * kimi-workspace-trust — pre-launch folder-trust registration for kimi.
 *
 * kimi gates the first run in any folder it has not seen before behind an
 * interactive TUI "Do you trust the files in this folder?" prompt. Unlike
 * antigravity's `pre_launch_trust` (a single shared settings file holding a
 * JSON array of trusted paths — see pre-launch-trust.ts), kimi persists trust
 * as ONE FILE PER WORKSPACE under `~/.kimi-code/workspace-trust/`, named
 * `wd_<slug>_<sha256(realpath)[:12]>` and containing
 * `{"root":"<realpath>","trustedAt":<epoch-ms>}`. The array-based mechanism
 * does not fit this per-workspace-file scheme, so this is a kimi-specific
 * hook in the same spirit as kimi-pending-question.ts.
 *
 * If the prompt is left unanswered, kimi exits immediately with code 0 —
 * every fresh worktree (every delegated mesh task cloning into its own
 * directory) hits an unattended, silent session death. There is no
 * CLI flag or env var bypass (`kimi --help` has none, `--yolo`/`--auto`
 * don't skip it — the prompt is a TUI dialog rendered before the launch-args
 * autonomy mode takes effect). Pre-writing the trust file is the only way to
 * suppress the prompt.
 *
 * Key format verified against the real kimi-code source
 * (MoonshotAI/kimi-code, `_base/utils/workdir-slug.ts` `encodeWorkDirKey()`)
 * and cross-checked against 42 live trust files on disk:
 *
 *   normalized = realpath.replace(/\\/g, '/').replace(/\/+$/, '')
 *   slug       = slugify(basename(normalized))   // lowercase, [a-z0-9._-], max 40 chars
 *   hash       = sha256(normalized).hex.slice(0, 12)
 *   key        = `wd_${slug}_${hash}`
 *
 * e.g. `/Users/vilmire/Work/adhdev` -> `wd_adhdev_78117b8afba9` (confirmed
 * against the file already on disk from a manually-trusted session).
 *
 * OSS code (AGPL-3.0). Must not import from packages/ (proprietary).
 */
'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { LOG } from '../logging/logger.js';

const MAX_SLUG_LENGTH = 40;

/** kimi's config home. Mirrors the override kimi itself honors (see
 *  quota/fetchers/kimi.ts `kimiHome()`) so a customized install is matched. */
function kimiHome(env: NodeJS.ProcessEnv = process.env): string {
    const override = env.KIMI_CODE_HOME?.trim();
    return override ? override : path.join(os.homedir(), '.kimi-code');
}

/**
 * Resolve the canonical, real (symlink-followed) absolute form of the
 * workspace path. kimi hashes the realpath, so matching has to use the same
 * normalization. Falls back to the raw resolved path if the directory can't
 * be stat'd (e.g. it does not exist yet).
 */
function realWorkspacePath(workingDir: string): string {
    try {
        return fs.realpathSync(workingDir);
    } catch {
        return path.resolve(workingDir);
    }
}

/** kimi's `slugify(basename)`: lowercase, non [a-z0-9._-] chars become `-`,
 *  collapsed and trimmed of leading/trailing `-`, capped at 40 chars. */
function slugify(input: string): string {
    const lower = input.toLowerCase();
    const replaced = lower.replace(/[^a-z0-9._-]+/g, '-');
    const collapsed = replaced.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
    return collapsed.slice(0, MAX_SLUG_LENGTH);
}

/** Build kimi's `wd_<slug>_<sha256[:12]>` workspace-trust key for a realpath. */
function workspaceTrustKey(realPath: string): string {
    const normalized = realPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const slug = slugify(path.basename(normalized));
    const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12);
    return `wd_${slug}_${hash}`;
}

/**
 * Idempotently pre-trust `workingDir` for kimi so the first-run folder-trust
 * TUI prompt never appears.
 *
 * - Registers EXACTLY `workingDir`'s realpath — never a parent directory or
 *   a wildcard. A worktree's repo content (including any `.mcp.json`) is not
 *   authored by us, so trust must stay scoped to the single directory being
 *   launched into.
 * - No-ops if the trust file already exists (does not overwrite `trustedAt`
 *   or re-verify contents — presence alone is kimi's trust signal).
 * - Best-effort: any failure is logged and swallowed. A failed pre-trust
 *   must not block launch — the worst case is the pre-existing behavior (the
 *   TUI prompt appears and the session may die unattended), not a crash.
 *
 * Returns the realpath that was registered, or null if nothing changed (already
 * trusted) or an error occurred — purely so callers/tests can assert the effect.
 */
export function applyKimiWorkspaceTrust(workingDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
    const real = realWorkspacePath(workingDir);
    const key = workspaceTrustKey(real);
    const trustDir = path.join(kimiHome(env), 'workspace-trust');
    const trustFile = path.join(trustDir, key);
    try {
        if (fs.existsSync(trustFile)) {
            LOG.debug('kimi-workspace-trust', `${real} already trusted (${key}) — no change`);
            return null;
        }
        fs.mkdirSync(trustDir, { recursive: true });
        fs.writeFileSync(trustFile, JSON.stringify({ root: real, trustedAt: Date.now() }), 'utf8');
        LOG.info('kimi-workspace-trust', `pre-trusted workspace ${real} (${key})`);
        return real;
    } catch (err) {
        LOG.warn('kimi-workspace-trust', `failed to pre-trust workspace ${real}: ${(err as Error).message}`);
        return null;
    }
}

// Exposed for tests only — not part of the module's public contract.
export const __test__ = { workspaceTrustKey, slugify, realWorkspacePath, kimiHome };
