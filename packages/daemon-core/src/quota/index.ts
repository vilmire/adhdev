/**
 * Provider quota fetching — public surface.
 *
 * Scope note: only Kimi ships a fetcher today. claude-cli (statusline
 * piggyback) and codex-cli (app-server JSON-RPC) are designed for but not yet
 * implemented; antigravity-cli is unresolved. See `docs/` in the PR/report for
 * the per-provider verdicts. The PTY `/status` fallback for codex is
 * deliberately out of scope — driving a PTY risks the CLI FSM and completion
 * detection that the daemon depends on.
 */
'use strict';

export {
    MONTHLY_WINDOW_MINUTES,
    SESSION_WINDOW_MINUTES,
    WEEKLY_WINDOW_MINUTES,
    clampPercent,
    quotaFailure,
    windowFromPercent,
    windowFromUsage,
    type ProviderQuota,
    type QuotaBucket,
    type QuotaFailureKind,
    type QuotaMetadata,
    type QuotaProvider,
    type QuotaStatus,
    type QuotaWindow,
} from './types.js';

export {
    resolveDeps,
    type QuotaFetch,
    type QuotaFetchDeps,
    type QuotaFetchResponse,
} from './fetchers/deps.js';

export { fetchKimiQuota } from './fetchers/kimi.js';
