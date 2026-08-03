/**
 * Provider quota fetching — public surface.
 *
 * Scope note: Kimi (OAuth GET), codex-cli (app-server JSON-RPC) and claude-cli
 * (statusline wrapper) ship fetchers. antigravity-cli is unresolved.
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
    type QuotaChildProcess,
    type QuotaFetch,
    type QuotaFetchDeps,
    type QuotaFetchResponse,
    type QuotaSpawn,
} from './fetchers/deps.js';

export { fetchKimiQuota } from './fetchers/kimi.js';
export { fetchCodexQuota } from './fetchers/codex.js';
export { fetchClaudeQuota, STALE_AFTER_MS } from './fetchers/claude.js';

export {
    installClaudeStatusline,
    readStatuslineStatus,
    resolveInstallPaths,
    uninstallClaudeStatusline,
    StatuslineInstallError,
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
