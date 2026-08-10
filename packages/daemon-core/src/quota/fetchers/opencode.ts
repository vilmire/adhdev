/**
 * opencode usage fetcher.
 *
 * opencode is a bring-your-own-provider router: there is NO account-level
 * rate limit to report a percentage against (limits belong to whichever
 * upstream account each configured provider uses), so this fetcher reports
 * USAGE — absolute tokens/cost over a trailing window — rather than quota
 * windows. `session`/`weekly` stay null and the numbers ride
 * `metadata.usage`; the dashboards render a usage chip for entries shaped
 * this way.
 *
 * Source: `opencode stats --days N` — opencode's own supported statistics
 * surface, computed from its local session store. No credential is read and
 * no network request is made (auth philosophy: the CLI owns its accounts;
 * we only read what its own tooling prints). Output is a human box-drawing
 * table; parsing is deliberately tolerant (label→value line pairs) and fails
 * closed to a 'parse' failure when the expected labels disappear, so an
 * upstream layout change degrades to a typed error instead of wrong numbers.
 */
'use strict';

import {
    quotaFailure,
    type ProviderQuota,
} from '../types.js';
import type { QuotaChildProcess, QuotaFetchDeps } from './deps.js';
import { resolveDeps } from './deps.js';

/** Trailing window the usage summary covers. */
export const OPENCODE_USAGE_DAYS = 7;

/** Whole-operation budget: bun startup + DB scan can take a few seconds. */
const TIMEOUT_MS = 20_000;

const SOURCE = 'stats-cli';

function opencodeCommand(env: NodeJS.ProcessEnv): string {
    const override = env.ADHDEV_OPENCODE_BIN?.trim();
    return override ? override : 'opencode';
}

/** "181.5K" / "7.4M" / "42" → token count; null when unparseable. */
export function parseTokenCount(raw: string): number | null {
    const match = /^([\d,.]+)\s*([KMB])?$/i.exec(raw.trim());
    if (!match) return null;
    const base = Number(match[1].replace(/,/g, ''));
    if (!Number.isFinite(base)) return null;
    const unit = (match[2] || '').toUpperCase();
    const factor = unit === 'K' ? 1e3 : unit === 'M' ? 1e6 : unit === 'B' ? 1e9 : 1;
    return Math.round(base * factor);
}

/** "$1,234.56" → 1234.56; null when unparseable. */
export function parseDollars(raw: string): number | null {
    const match = /^\$\s*([\d,]+(?:\.\d+)?)$/.exec(raw.trim());
    if (!match) return null;
    const value = Number(match[1].replace(/,/g, ''));
    return Number.isFinite(value) ? value : null;
}

export interface OpencodeUsage {
    days: number;
    totalCostUsd: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    sessions: number | null;
    /** Structural compatibility with QuotaMetadata.usage. */
    [field: string]: number | null;
}

/**
 * Pull label→value pairs out of the box-drawing tables. A row looks like
 * `│Total Cost                       $0.00 │` — label text, a run of spaces,
 * a value, optional trailing space before the closing bar. ANSI sequences are
 * stripped first so a future colored output keeps parsing.
 */
export function parseOpencodeStats(stdout: string, days: number): OpencodeUsage | null {
    // eslint-disable-next-line no-control-regex
    const clean = stdout.replace(/\[[0-9;]*m/g, '');
    const values = new Map<string, string>();
    for (const line of clean.split('\n')) {
        const row = /^[│|]\s*(.+?)\s{2,}(\S(?:.*\S)?)\s*[│|]\s*$/.exec(line);
        if (row) values.set(row[1].trim(), row[2].trim());
    }
    const totalCost = values.get('Total Cost');
    const input = values.get('Input');
    const output = values.get('Output');
    // The overview and cost tables are the contract; if neither of the two
    // anchor labels is present the layout changed — fail closed.
    if (totalCost === undefined && input === undefined) return null;
    const sessionsRaw = values.get('Sessions');
    const sessions = sessionsRaw !== undefined ? parseTokenCount(sessionsRaw) : null;
    return {
        days,
        totalCostUsd: totalCost !== undefined ? parseDollars(totalCost) : null,
        inputTokens: input !== undefined ? parseTokenCount(input) : null,
        outputTokens: output !== undefined ? parseTokenCount(output) : null,
        cacheReadTokens: values.has('Cache Read') ? parseTokenCount(values.get('Cache Read')!) : null,
        cacheWriteTokens: values.has('Cache Write') ? parseTokenCount(values.get('Cache Write')!) : null,
        sessions,
    };
}

/**
 * Read opencode's trailing-window usage. Never throws — every failure path
 * resolves to a snapshot whose `status` is 'error' or 'unavailable', and the
 * child never outlives the call.
 */
export async function fetchOpencodeUsage(overrides: QuotaFetchDeps = {}): Promise<ProviderQuota> {
    const deps = resolveDeps(overrides);

    return new Promise<ProviderQuota>((resolve) => {
        let child: QuotaChildProcess;
        try {
            child = deps.spawn(
                opencodeCommand(deps.env),
                ['stats', '--days', String(OPENCODE_USAGE_DAYS)],
                { env: deps.env },
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            resolve(quotaFailure('opencode', 'unavailable', `opencode could not be started: ${message}`, {
                source: SOURCE,
                failureKind: 'cli-unavailable',
            }));
            return;
        }

        let settled = false;
        let stdout = '';
        let stderr = '';
        const finish = (quota: ProviderQuota) => {
            if (settled) return;
            settled = true;
            deps.clearTimeout(timeoutHandle);
            try { child.kill(); } catch { /* already gone */ }
            resolve(quota);
        };
        const timeoutHandle = deps.setTimeout(() => {
            finish(quotaFailure('opencode', 'error', `opencode stats timed out after ${TIMEOUT_MS}ms`, {
                source: SOURCE,
                failureKind: 'unknown',
            }));
        }, TIMEOUT_MS);
        timeoutHandle.unref?.();

        child.stdout.on('data', (chunk) => { stdout += String(chunk); });
        child.stderr.on('data', (chunk) => { stderr += String(chunk); });
        child.on('error', (err: Error) => {
            finish(quotaFailure('opencode', 'unavailable', `opencode could not be started: ${err.message}`, {
                source: SOURCE,
                failureKind: 'cli-unavailable',
            }));
        });
        child.on('exit', (code: number | null) => {
            if (code !== 0) {
                finish(quotaFailure('opencode', 'error', `opencode stats exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : ''}`, {
                    source: SOURCE,
                    failureKind: 'unknown',
                }));
                return;
            }
            const usage = parseOpencodeStats(stdout, OPENCODE_USAGE_DAYS);
            if (!usage) {
                finish(quotaFailure('opencode', 'error', 'opencode stats output is of an unknown layout', {
                    source: SOURCE,
                    failureKind: 'parse',
                }));
                return;
            }
            finish({
                provider: 'opencode',
                session: null,
                weekly: null,
                updatedAt: deps.now(),
                error: null,
                status: 'ok',
                metadata: { source: SOURCE, usage },
            });
        });
    });
}
