/**
 * Provider quota fetching — public surface.
 *
 * Scope note: Kimi and grok-cli (OAuth GET), Cursor and antigravity-cli (OAuth
 * POST), codex-cli (app-server JSON-RPC) and claude-cli (statusline wrapper)
 * ship fetchers.
 *
 * claude-cli is the odd one out and worth understanding before touching it.
 * Claude Code exposes no outbound quota interface; the numbers exist only as
 * the `rate_limits` field of the JSON it pipes to a *user-configured*
 * `statusLine` command, and `statusLine` is a single-valued setting. So the
 * fetcher does not query anything — a wrapper installed into that slot records
 * what Claude Code hands it, calling the user's own statusline command from
 * inside so their prompt is unchanged. Because that edits a user's visible
 * configuration, install is opt-in (`adhdev quota claude install`) and must
 * never be triggered from the daemon boot path. See `./statusline/install.ts`.
 *
 * The PTY `/status` fallback for codex is deliberately out of scope — driving
 * a PTY risks the CLI FSM and completion detection that the daemon depends on.
 * The WSL-only `chatgpt.com/backend-api` HTTP path is likewise out of scope.
 */
'use strict';

export {
    MONTHLY_WINDOW_MINUTES,
    QUOTA_RATE_LIMIT_RETRY_DELAY_MS,
    QUOTA_TRANSIENT_RETRY_DELAY_MS,
    SESSION_WINDOW_MINUTES,
    TRANSIENT_QUOTA_FAILURE_KINDS,
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
    type QuotaChildProcess,
    type QuotaFetch,
    type QuotaFetchDeps,
    type QuotaFetchResponse,
    type QuotaSpawn,
} from './fetchers/deps.js';

export {
    QUOTA_ACTIVITY_WINDOW_MS,
    QUOTA_AXIS,
    QUOTA_AXIS_TTL_MS,
    QUOTA_EVENT_REFRESH_DEBOUNCE_MS,
    QUOTA_SWR_TTL_MS,
    QUOTA_FAILURE_MAX_RETRIES,
    QUOTA_REFRESH_INTERVAL_MS,
    QUOTA_ROUTABLE_MAX_AGE_MS,
    clearQuotaCache,
    forceRefreshQuota,
    hasRecentCliActivity,
    isDueByAxisTtl,
    isDueBySwrTtl,
    isFailureRetryDue,
    isQuotaRevalidateInFlight,
    isSnapshotStaleForRouting,
    quotaProviderEnabledFromLoader,
    readQuotaCache,
    // ★readQuotaCacheWithRevalidate is NOT a drop-in for readQuotaCache: it can
    // schedule a background fetch. Only low-rate, human-facing read surfaces may
    // call it — never the mesh reconcile tick or buildLocalNodeFacts. See the
    // function's own note.
    readQuotaCacheWithRevalidate,
    refreshQuotaCacheOnBoot,
    refreshQuotaCacheOnce,
    setupQuotaEventRefresh,
    setupQuotaRefreshLoop,
    startQuotaRefreshLoop,
    type QuotaAxis,
    type QuotaEventRefreshOptions,
    type QuotaForceRefreshEntry,
    type QuotaForceRefreshResult,
    type QuotaProviderEnabled,
    type QuotaRefreshLoopHandle,
    type QuotaRefreshLoopOptions,
    type RefreshQuotaCacheOptions,
} from './refresh.js';

export { fetchAntigravityQuota } from './fetchers/antigravity.js';
export { fetchGrokQuota } from './fetchers/grok.js';
export { fetchKimiQuota } from './fetchers/kimi.js';
export { fetchCodexQuota, fetchCodexQuotaFromAppServer } from './fetchers/codex.js';
export {
    fetchCodexQuotaFromRollout,
    readLatestCodexRateLimits,
    codexHome,
    codexSessionsDir,
    CODEX_ROLLOUT_STALE_AFTER_MS,
} from './fetchers/codex-rollout.js';
export { fetchClaudeQuota, STALE_AFTER_MS } from './fetchers/claude.js';

export {
    classifyStatuslineCommand,
    installClaudeStatusline,
    readStatuslineStatus,
    resolveInstallPaths,
    uninstallClaudeStatusline,
    StatuslineInstallError,
    type StatuslineCommandKind,
    type StatuslineCommandVerdict,
    type InstallResult,
    type StatuslineInstallPaths,
    type StatuslineStatus,
    type UninstallResult,
} from './statusline/install.js';

export {
    parseSnapshotFile,
    snapshotFromStatuslineInput,
    shouldWriteSnapshot,
    MAX_WRITE_INTERVAL_MS,
    MIN_WRITE_INTERVAL_MS,
    SNAPSHOT_VERSION,
    type StatuslineSnapshot,
    type StatuslineWindowRecord,
} from './statusline/snapshot.js';
