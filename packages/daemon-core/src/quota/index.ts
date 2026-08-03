/**
 * Provider quota fetching — public surface.
 *
 * Scope note: Kimi (OAuth GET) and codex-cli (app-server JSON-RPC) ship
 * fetchers. claude-cli does NOT, and that is a decision rather than a gap: the
 * numbers exist only as the `rate_limits` field of the JSON that Claude Code
 * pipes to a *user-configured* `statusLine` command, and `statusLine` is a
 * single-valued setting. Capturing it would mean overwriting whatever
 * statusline the user already runs — the CLI offers no second slot and no
 * outbound hook we can subscribe to. Installing ourselves there trades a
 * user's own configuration for a metric, so it stays unimplemented pending an
 * opt-in design. antigravity-cli is unresolved.
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
