/**
 * Claude Code (claude-cli) quota fetcher.
 *
 * Auth philosophy (see CLAUDE.md): ADHDev does NOT manage provider API keys.
 * This fetcher is the purest case of that rule — it performs no network request
 * and reads no credential. Claude Code itself computes the user's plan
 * consumption and hands it to whatever `statusLine` command the user
 * configured; we read the file our wrapper wrote from that handout.
 *
 * ── Why a wrapper, and not a query ──
 * Unlike Kimi (OAuth GET) and Codex (app-server JSON-RPC), Claude Code exposes
 * no outbound quota interface: no endpoint we may call, no subcommand that
 * prints rate limits, no hook. The numbers exist only as the `rate_limits`
 * field of the JSON piped to the statusline command's stdin. `statusLine` is
 * single-valued, so capturing that field means occupying the slot and calling
 * the user's own command from inside ours — see `../statusline/install.ts`.
 * That is a change to the user's visible prompt, so it is opt-in and never
 * performed by the daemon.
 *
 * Consequence for this fetcher: quota is only as fresh as the last statusline
 * invocation, which only happens while a Claude Code session is open. A
 * reading from a session that ended hours ago is not current, so it is reported
 * as an explicit stale state rather than as a live number.
 *
 * Field facts (`rate_limits.five_hour` / `.seven_day`, each with
 * `used_percentage` and a Unix-seconds `resets_at`) are from the Claude Code
 * statusline documentation; `rate_limits` arrived in 2.1.80 and is present only
 * for subscription accounts after the session's first API response.
 */
'use strict';

import * as fs from 'node:fs';

import {
    SESSION_WINDOW_MINUTES,
    WEEKLY_WINDOW_MINUTES,
    quotaFailure,
    windowFromPercent,
    type ProviderQuota,
    type QuotaWindow,
} from '../types.js';
import { parseSnapshotFile, type StatuslineSnapshot } from '../statusline/snapshot.js';
import { readStatuslineStatus, resolveInstallPaths } from '../statusline/install.js';
import type { QuotaFetchDeps } from './deps.js';
import { resolveDeps } from './deps.js';

/**
 * How old a reading may be and still count as current.
 *
 * The wrapper re-stamps an unchanged snapshot every 30s while a session is
 * open, so anything older than this means no Claude Code session has been
 * running — not that usage stopped. 10 minutes is loose enough to survive a
 * user idling between prompts and tight enough that a closed session is
 * noticed promptly.
 */
export const STALE_AFTER_MS = 10 * 60 * 1000;

const SOURCE = 'statusline';

function toWindow(
    record: StatuslineSnapshot['fiveHour'],
    windowMinutes: number,
): QuotaWindow | null {
    if (record === null) {
        return null;
    }
    return windowFromPercent(record.usedPercent, windowMinutes, record.resetsAt);
}

/**
 * Read the quota Claude Code last reported to the statusline wrapper.
 *
 * Never throws — every failure path returns a snapshot whose `status` is
 * 'unavailable' (nothing to read yet, an ordinary state) or 'error'.
 */
export async function fetchClaudeQuota(overrides: QuotaFetchDeps = {}): Promise<ProviderQuota> {
    const deps = resolveDeps(overrides);
    const paths = resolveInstallPaths(deps.env);

    let raw: string;
    try {
        raw = fs.readFileSync(paths.snapshotFile, 'utf-8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
            return missingSnapshotFailure(deps.env);
        }
        const message = err instanceof Error ? err.message : String(err);
        return quotaFailure('claude-cli', 'error', `Unable to read Claude quota snapshot: ${message}`, {
            source: SOURCE,
            failureKind: 'unknown',
        });
    }

    const snapshot = parseSnapshotFile(raw);
    if (snapshot === null) {
        return quotaFailure('claude-cli', 'error', 'Claude quota snapshot is unreadable or of an unknown version', {
            source: SOURCE,
            failureKind: 'parse',
        });
    }

    const session = toWindow(snapshot.fiveHour, SESSION_WINDOW_MINUTES);
    const weekly = toWindow(snapshot.sevenDay, WEEKLY_WINDOW_MINUTES);
    if (!session && !weekly) {
        return quotaFailure('claude-cli', 'error', 'Claude quota snapshot contained no usable windows', {
            source: SOURCE,
            failureKind: 'parse',
        });
    }

    const age = deps.now() - snapshot.capturedAt;
    if (age > STALE_AFTER_MS) {
        // Report the windows we have, but as 'error' rather than 'ok': these
        // numbers are a historical reading, and presenting them as the current
        // state would understate consumption that happened since.
        const minutes = Math.round(age / 60_000);
        return {
            provider: 'claude-cli',
            session,
            weekly,
            updatedAt: snapshot.capturedAt,
            error: `Claude quota reading is stale (${minutes} min old) — open a Claude Code session to refresh`,
            status: 'error',
            // 'no-data' (not 'unsupported'): the channel works, the reading
            // just aged out — same ordinary wait-for-a-session state as the
            // never-captured case above.
            // lastGoodWindows: these ARE genuinely measured windows with their
            // original capture time — the same trust class as refresh.ts's
            // carry-forward — so mesh quota routing may keep gating/bonusing
            // on them until each window's own resetsAt (owner decision
            // 2026-08-24). Without the mark, routing discarded the retained
            // measurement wholesale.
            metadata: { source: SOURCE, failureKind: 'no-data', lastGoodWindows: true },
        };
    }

    return {
        provider: 'claude-cli',
        session,
        weekly,
        updatedAt: snapshot.capturedAt,
        error: null,
        status: 'ok',
        metadata: { source: SOURCE },
    };
}

/**
 * Distinguish "wrapper was never installed" from "installed but has not
 * captured anything yet" — the first needs a setup step, the second just needs
 * a Claude Code session to run.
 */
function missingSnapshotFailure(env: NodeJS.ProcessEnv): ProviderQuota {
    let installed = false;
    let danglingPath: string | null = null;
    try {
        const status = readStatuslineStatus(env);
        installed = status.installed;
        danglingPath = status.failureKind === 'wrapper-missing' ? status.danglingWrapperPath : null;
    } catch {
        // Unreadable settings — treat as not installed and say so below.
    }
    if (danglingPath !== null) {
        // The third state must not be folded into either of the other two.
        // "Open a session to record one" was actively misleading here: sessions
        // WERE open, each one running a wrapper command that exits
        // MODULE_NOT_FOUND, so no amount of opening sessions would ever produce
        // a snapshot. A live audit believed that line on 2026-08-20.
        return quotaFailure(
            'claude-cli',
            'unavailable',
            `Claude statusline wrapper is missing (${danglingPath}) — re-run \`adhdev quota claude:install\` to repair`,
            { source: SOURCE, failureKind: 'no-data' },
        );
    }
    return quotaFailure(
        'claude-cli',
        'unavailable',
        installed
            ? 'No Claude quota captured yet — open a Claude Code session to record one'
            : 'Claude quota reporting is not set up — run `adhdev quota claude:install`',
        // 'no-data', NOT 'missing-credentials': this fetcher reads no
        // credential at all (see the header), and the old label made the
        // dashboard render "(missing credentials)" for a machine that was
        // merely waiting for its first statusline capture — a live
        // coordinator misread that as a claude-cli auth failure.
        { source: SOURCE, failureKind: 'no-data' },
    );
}
