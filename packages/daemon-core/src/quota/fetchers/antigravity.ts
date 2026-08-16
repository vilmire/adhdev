/**
 * Antigravity CLI (`agy`, Google) quota fetcher.
 *
 * Auth philosophy (see CLAUDE.md): ADHDev does NOT manage provider API keys.
 * We read the OAuth access token the `agy` CLI already stored and use it for a
 * single authenticated POST. We NEVER write, refresh, rotate or delete that
 * credential — Google's refresh flow rotates the refresh token, so writing it
 * back from here would log out a live `agy` session. When the token has
 * expired we report "cannot query" and let the CLI refresh it on next run.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★CREDENTIAL SOURCE — the macOS Keychain, NOT a file.
 *
 * An earlier version of this fetcher read
 * `~/.gemini/antigravity-cli/antigravity-oauth-token` and was PERMANENTLY
 * BROKEN in the field: it reported `expired-token` on every tick while the
 * CLI itself was happily authenticated. That file is a DEAD FALLBACK. Across
 * every `agy` session log on the development machine the CLI authenticated
 * 15/15 times via the keyring (`ChainedAuth: authenticated via keyring
 * (effective: keyring)`), the file-based path was taken 0 times, and the
 * file's mtime stayed frozen weeks in the past while the keychain item was
 * rewritten on every login. `agy` only falls back to the file when a keyring
 * timeout was recorded or the caller explicitly asks for it.
 *
 * The item is a go-keyring generic password:
 *     service = "gemini", account = "antigravity"
 * read via `/usr/bin/security find-generic-password` (go-keyring's own macOS
 * backend shells out to the same binary). Reading it from another process
 * needs no user interaction — verified: exit 0, no Keychain prompt.
 *
 * ★The stored blob is NOT plain JSON. go-keyring base64-encodes any value it
 * cannot store as a clean UTF-8 string and prefixes it with the literal
 * `go-keyring-base64:`. Decoding that prefix is required; a naive JSON.parse
 * of the raw blob fails. The decoded payload has the same shape the file used
 * to have: `{ token: { access_token, token_type, refresh_token, expiry },
 * auth_method }`, where `expiry` is RFC3339 with an offset (Go time.Time).
 *
 * ★PLATFORM SCOPE — darwin only, deliberately. Both other platforms WERE
 * surveyed on real machines (2026-08-16); neither yielded a credential source
 * solid enough to build on, for DIFFERENT reasons:
 *
 *   win32 — Antigravity 1.107.0 is installed, but its credential backend is
 *     UNRESOLVED. `cmdkey /list` shows no antigravity entry, and that is not
 *     evidence of absence: cmdkey enumerates the legacy Credential Manager
 *     store and cannot see WinRT PasswordVault, which is where the token
 *     plausibly lives. A `%USERPROFILE%\.gemini\oauth_creds.json` also exists,
 *     but wiring THAT in would repeat the exact mistake this file documents
 *     above — on macOS a same-shaped on-disk token file was a DEAD FALLBACK
 *     that produced a permanent false `expired-token`. Until the backend is
 *     identified positively, there is nothing here worth trusting.
 *     ★Also note the win32 entry point is `antigravity` (bin\antigravity.cmd),
 *     NOT `agy`. That is a PROVIDER-DETECTION issue, not a quota one, and it
 *     is deliberately not fixed here. The mechanism, for whoever picks it up:
 *     `detectProviderVersion` (providers/version-archive.ts) resolves a CLI
 *     with `findBinary(provider.binary || spawn.command || cli || type)` and
 *     sets `installed` from whether that single name resolves. `findBinary`
 *     DOES try a `.cmd` suffix on win32, so `antigravity.cmd` would be found —
 *     but it is never asked for, because the manifest's `binary` is `agy` and
 *     the manifest's `aliases: ["agy"]` is not consulted by detection at all.
 *     Fixing it properly means a per-platform binary (no manifest in the repo
 *     has one today) and a `spawn` rewrite, since `spawn.command` is `bash`.
 *     Consequence meanwhile: on win32 the CLI can be installed and still
 *     report `installed: false`, in which case quota is never even asked for.
 *
 *   linux — the surveyed host is a headless SSH server, and there the Secret
 *     Service is not merely absent but STRUCTURALLY unavailable:
 *     `org.freedesktop.secrets` is not registered on the session bus, there is
 *     no keyring-unlock history, and the first unlock would require the
 *     `gcr-prompter` GUI dialog, which cannot be satisfied over SSH. So even a
 *     correct libsecret implementation would not work on this class of machine
 *     — which is precisely the class ADHDev daemons run on.
 *
 * Rather than guess at a backend and ship code that fails silently or, worse,
 * reports a wrong number, this fetcher returns an explicit `unsupported` on
 * non-darwin. A wrong number is far worse than an honest "not supported".
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★ENDPOINT PROVENANCE — established by RUNTIME OBSERVATION, not symbols.
 *
 * antigravity-cli was twice judged "quota not supportable"; both verdicts came
 * from reading `agy --help`, which lists no quota subcommand because usage is
 * a TUI view. Recording the real chain of evidence so it is not re-derived:
 *
 *   1. `~/.gemini/antigravity-cli/log/cli-*.log` shows a `quota_manager.go
 *      doRefreshQuota` loop, but NO URL line for the quota call — because
 *      `http_helpers.go` only logs SOME outbound calls in v1.1.13 (proven:
 *      `listExperiments` ran 4x and logged 0x in that build, 4/4 in v1.1.11).
 *      Absence of a URL log is therefore NOT absence of a call.
 *   2. Driving `agy` through a local CONNECT proxy that REFUSED the
 *      cloudcode host made the CLI name its own operation:
 *          `Cache(retrieveUserQuotaSummary): Singleflight refresh failed…`
 *          `quota_manager.go:57] Failed to retrieve user quota summary…`
 *      That is runtime proof that doRefreshQuota → retrieveUserQuotaSummary,
 *      and that it first needs a `loadCodeAssist` response.
 *   3. Verified live with a real 200 (see the response shape below).
 *
 * The backend is SHARED with Gemini Code Assist — `LoadCodeAssist`,
 * `FetchAvailableModels` and `QuotaSummaryBucket` all live in the same
 * `google.internal.cloud.code.v1internal` proto package, and gemini-cli
 * (open source) points at the same `cloudcode-pa` host + `v1internal` scheme.
 * So this is a Code Assist API, not an Antigravity-private one.
 *
 * ★Host: production `cloudcode-pa.googleapis.com`. The `daily-` prefixed host
 * is Google's STAGING deployment; the dev machine happened to run a build
 * pinned to it (a known Antigravity bug), and defaulting to staging here would
 * have inherited that mistake. Both hosts serve the method; the CLI itself
 * falls back between them.
 *
 * ★Request body MUST be `{}`. Verified live: adding `project` or `metadata`
 * makes the server answer 429/400. The `project` and `forceRefresh` fields
 * exist on the request proto but are not required, and sending them hurts.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★RESPONSE SHAPE — from a real 200, not inferred:
 *
 *   { groups: [ { displayName: "Gemini Models",
 *                 description: "Models within this group: …",
 *                 buckets: [ { bucketId: "gemini-weekly",
 *                              displayName: "Weekly Limit Remaining",
 *                              window: "weekly",
 *                              resetTime: "2026-08-17T16:28:23Z",
 *                              description: "…",
 *                              remainingFraction: 0.9967779 }, … ] }, … ],
 *     description: "Within each group, models share a weekly limit …" }
 *
 * ★`window` is a STRING LABEL ("weekly", "5h") — NOT a proto3 Duration
 * ("604800s"). An earlier version parsed it as a Duration, which returned null
 * for every real bucket and left BOTH fixed axes unmapped. Parsing handles the
 * label form first and still tolerates a Duration, because the field is typed
 * as one in the generated descriptors even though the server sends a label.
 *
 * ★`remainingFraction` is what is LEFT, so usedPercent = (1 - fraction) * 100.
 * Live sample: 0.9967779 → 0.32% used. Getting this backwards would report an
 * exhausted plan as untouched, so it is pinned by a test.
 *
 * ★Two shapes from ONE endpoint: the response proto carries both `groups` and
 * a top-level `buckets`, and the legacy sibling `retrieveUserQuota` returns the
 * flat form (`{buckets:[{tokenType,modelId,remainingFraction,resetTime}]}` —
 * also verified live). Both are parsed; flat buckets are named from
 * `modelId`/`tokenType` so they never collapse into an anonymous row.
 *
 * ★`remainingAmount` may be ABSENT at full quota while `remainingFraction` is
 * still present (gemini-cli issue #27363). Keying on the fraction avoids that
 * trap; a bucket with only an amount and no total cannot yield a percentage
 * and is dropped rather than shown as 0% used.
 */
'use strict';

import {
    SESSION_WINDOW_MINUTES,
    WEEKLY_WINDOW_MINUTES,
    clampPercent,
    quotaFailure,
    type ProviderQuota,
    type QuotaBucket,
    type QuotaWindow,
} from '../types.js';
import type { QuotaChildProcess, QuotaFetchDeps } from './deps.js';
import { resolveDeps } from './deps.js';

/** Production Cloud Code host. `daily-` is Google's staging deployment. */
const DEFAULT_BASE_URL = 'https://cloudcode-pa.googleapis.com/v1internal';
const REQUEST_TIMEOUT_MS = 10_000;
/** Refuse to spend a token that expires mid-flight. */
const EXPIRY_SKEW_MS = 5_000;
/** Keychain lookup must never hang a refresh tick. */
const KEYCHAIN_TIMEOUT_MS = 5_000;

/** go-keyring's marker for a base64-encoded secret. */
const GO_KEYRING_BASE64_PREFIX = 'go-keyring-base64:';

const KEYCHAIN_SERVICE = 'gemini';
const KEYCHAIN_ACCOUNT = 'antigravity';

function baseUrl(env: NodeJS.ProcessEnv): string {
    const override = env.ANTIGRAVITY_CLOUDCODE_BASE_URL?.trim();
    return (override ? override : DEFAULT_BASE_URL).replace(/\/+$/, '');
}

interface AntigravityCredentials {
    accessToken: string;
    /** Unix ms, or null when the payload records no parseable expiry. */
    expiresAtMs: number | null;
    /** `consumer` for a personal plan; business accounts use another API. */
    authMethod: string | null;
}

type CredentialsResult =
    | { kind: 'ok'; credentials: AntigravityCredentials }
    | { kind: 'missing' }
    | { kind: 'unsupported-platform'; platform: string }
    | { kind: 'invalid'; reason: string };

/**
 * Why this platform is not supported, in the user's words.
 *
 * Deliberately platform-specific: on win32 the backend is merely UNIDENTIFIED
 * (a positive finding could enable support later), whereas on a headless linux
 * host the Secret Service is structurally unavailable, so no implementation
 * would help. Collapsing both into "unsupported" would hide that difference
 * from whoever picks this up next.
 */
function unsupportedPlatformReason(platform: string): string {
    if (platform === 'win32') {
        return 'Antigravity quota is not supported on Windows yet: the CLI is installed, but its credential store has not been positively identified (cmdkey cannot see the WinRT PasswordVault, so it cannot rule it out). Quota is currently macOS-only.';
    }
    if (platform === 'linux') {
        return 'Antigravity quota is not supported on Linux: the CLI credential lives in the freedesktop Secret Service, which is unavailable on a headless host (no session-bus service, and the first unlock needs a GUI prompt). Quota is currently macOS-only.';
    }
    return `Antigravity quota is only supported on macOS (this machine reports platform "${platform}").`;
}

/**
 * Read the raw keychain blob via `/usr/bin/security` — the same binary
 * go-keyring's macOS backend shells out to, so this reads exactly what `agy`
 * wrote. READ ONLY: `find-generic-password` cannot modify the item.
 *
 * Resolves to null when the item does not exist (`security` exits 44), which
 * is the ordinary "not signed in" state and not an error worth reporting as
 * broken. Rejects only on a timeout, so a wedged keychain prompt cannot hang a
 * refresh tick forever.
 *
 * Goes through `deps.spawn` rather than importing child_process directly so
 * tests can drive every branch without touching a real keychain — the same
 * injection the codex fetcher uses.
 */
function readKeychainBlob(deps: Required<QuotaFetchDeps>): Promise<string | null> {
    return new Promise((resolve, reject) => {
        let child: QuotaChildProcess;
        try {
            child = deps.spawn(
                '/usr/bin/security',
                ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
                { env: deps.env },
            );
        } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
        }

        let settled = false;
        let stdout = '';
        const finish = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            deps.clearTimeout(timer);
            fn();
        };

        const timer = deps.setTimeout(() => {
            finish(() => {
                try {
                    child.kill('SIGKILL');
                } catch {
                    // Already gone; nothing to clean up.
                }
                reject(new Error('Keychain lookup timed out'));
            });
        }, KEYCHAIN_TIMEOUT_MS);
        if (typeof (timer as { unref?: () => void }).unref === 'function') {
            (timer as { unref: () => void }).unref();
        }

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        // stderr is deliberately drained but not surfaced: `security` writes
        // "could not be found in the keychain" there for the not-signed-in
        // case, which is already conveyed by the exit code.
        child.stderr.on('data', () => {});
        child.on('error', (err) => finish(() => reject(err)));
        child.on('exit', (code) => {
            finish(() => resolve(code === 0 ? stdout.trim() : null));
        });
    });
}

/**
 * Decode a go-keyring secret. The `go-keyring-base64:` prefix is present
 * whenever the stored value was not clean UTF-8 — which is the case for this
 * item — so decoding it is mandatory, not optional.
 */
function decodeKeyringSecret(raw: string): string {
    if (!raw.startsWith(GO_KEYRING_BASE64_PREFIX)) {
        return raw;
    }
    return Buffer.from(raw.slice(GO_KEYRING_BASE64_PREFIX.length), 'base64').toString('utf-8');
}

/**
 * Parse the credential payload:
 *   { token: { access_token, token_type, refresh_token, expiry }, auth_method }
 * `expiry` is RFC3339 WITH an offset (Go time.Time), e.g.
 * "2026-08-16T18:58:07.255019+09:00" — NOT unix seconds. Parsing it as a
 * number would silently treat every token as never-expiring.
 */
function parseCredentials(decoded: string): CredentialsResult {
    let parsed: unknown;
    try {
        parsed = JSON.parse(decoded);
    } catch {
        return { kind: 'invalid', reason: 'Antigravity credential is not valid JSON' };
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return { kind: 'invalid', reason: 'Antigravity credential is not an object' };
    }
    const root = parsed as Record<string, unknown>;
    // Tolerate a flattened payload as well as the nested `token` object seen
    // today — the layout is the CLI's private detail, not a contract.
    const token = typeof root.token === 'object' && root.token !== null
        ? (root.token as Record<string, unknown>)
        : root;

    const accessToken = token.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
        return { kind: 'invalid', reason: 'Antigravity credential has no access token' };
    }

    const expiryRaw = token.expiry ?? token.expires_at;
    let expiresAtMs: number | null = null;
    if (typeof expiryRaw === 'string' && expiryRaw.trim() !== '') {
        const ms = new Date(expiryRaw).getTime();
        expiresAtMs = Number.isNaN(ms) ? null : ms;
    } else if (typeof expiryRaw === 'number' && Number.isFinite(expiryRaw)) {
        // Seconds vs ms is ambiguous in the raw number form; treat anything
        // below year-2001-in-ms as seconds.
        expiresAtMs = expiryRaw < 1e11 ? expiryRaw * 1000 : expiryRaw;
    }

    const authMethod = typeof root.auth_method === 'string' && root.auth_method.trim() !== ''
        ? root.auth_method.trim()
        : null;

    return { kind: 'ok', credentials: { accessToken, expiresAtMs, authMethod } };
}

async function readCredentials(deps: Required<QuotaFetchDeps>): Promise<CredentialsResult> {
    // `ADHDEV_ANTIGRAVITY_PLATFORM` is a test seam so the non-darwin branch is
    // exercisable from a macOS test run; it is never set in production.
    const platform = deps.env.ADHDEV_ANTIGRAVITY_PLATFORM?.trim() || process.platform;
    if (platform !== 'darwin') {
        return { kind: 'unsupported-platform', platform };
    }

    let raw: string | null;
    try {
        raw = await readKeychainBlob(deps);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { kind: 'invalid', reason: `Unable to read the Antigravity credential: ${message}` };
    }
    if (raw === null || raw === '') {
        return { kind: 'missing' };
    }
    return parseCredentials(decodeKeyringSecret(raw));
}

function isExpired(credentials: AntigravityCredentials, nowMs: number): boolean {
    if (credentials.expiresAtMs === null) {
        // No expiry recorded — let the server be the judge rather than
        // refusing to ask. A 401 is classified below.
        return false;
    }
    return credentials.expiresAtMs - nowMs <= EXPIRY_SKEW_MS;
}

// --- response shape -------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function toNumber(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function toResetMs(value: unknown): number | null {
    if (typeof value !== 'string' || value.trim() === '') {
        return null;
    }
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? null : ms;
}

/**
 * Window length in minutes.
 *
 * ★The live server sends a LABEL — "weekly", "5h" — even though the generated
 * descriptors type this field as a Duration. Label parsing therefore comes
 * first; the Duration form ("604800s") is still accepted so a server-side
 * change to the documented type does not break this. Returns null when the
 * value is absent or unrecognized, in which case the bucket is still reported
 * but maps to no fixed axis.
 */
function windowMinutes(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value / 60;
    }
    if (typeof value !== 'string') {
        return null;
    }
    const raw = value.trim().toLowerCase();
    if (raw === '') {
        return null;
    }
    if (raw === 'weekly' || raw === 'week') {
        return WEEKLY_WINDOW_MINUTES;
    }
    if (raw === 'daily' || raw === 'day') {
        return 24 * 60;
    }
    if (raw === 'monthly' || raw === 'month') {
        return 30 * 24 * 60;
    }
    // "5h" / "90m" / "30s" style labels.
    const shorthand = /^(\d+(?:\.\d+)?)\s*([hms])$/.exec(raw);
    if (shorthand) {
        const amount = Number(shorthand[1]);
        if (!Number.isFinite(amount)) {
            return null;
        }
        if (shorthand[2] === 'h') return amount * 60;
        if (shorthand[2] === 'm') return amount;
        return amount / 60;
    }
    // proto3 Duration JSON: seconds with an `s` suffix.
    const duration = /^(\d+(?:\.\d+)?)s$/.exec(raw);
    if (duration) {
        const seconds = Number(duration[1]);
        return Number.isFinite(seconds) ? seconds / 60 : null;
    }
    return null;
}

/**
 * A bucket's consumed percentage.
 *
 * `remainingFraction` (0..1) and `remainingAmount` are a protobuf `oneof`
 * named `remaining`; proto3 JSON serializes oneof members FLAT, so the wire
 * key is `remainingFraction`, never a nested `remaining` object. Both express
 * what is LEFT, hence the inversion. `remainingAmount` alone cannot produce a
 * percentage (no total is reported), so it yields null and the bucket is
 * dropped rather than shown as 0% used, which would claim full headroom.
 */
function bucketUsedPercent(bucket: Record<string, unknown>): number | null {
    const fraction = toNumber(bucket.remainingFraction);
    if (fraction !== null) {
        return clampPercent((1 - fraction) * 100);
    }
    return null;
}

/** Human label for a bucket, preferring the server's own display name. */
function bucketName(bucket: Record<string, unknown>): string {
    const candidates = [
        bucket.displayName,
        // Present on some variants of the summary proto; used before falling
        // back to the opaque id so a mapping-key bucket is not anonymous.
        bucket.displayNameMappingKey,
        bucket.bucketId,
        // Flat (`retrieveUserQuota`) shape identifies buckets per model.
        bucket.modelId,
        bucket.tokenType,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim() !== '') {
            return candidate.trim();
        }
    }
    return 'quota';
}

/**
 * Flatten `groups[].buckets[]` plus any top-level `buckets[]` into named
 * buckets. The group's display name prefixes the bucket's so two same-named
 * buckets from different pools stay distinguishable ("Gemini Models · Weekly
 * Limit Remaining"), which is exactly how the live response is shaped.
 */
function collectBuckets(data: Record<string, unknown>): QuotaBucket[] {
    const out: QuotaBucket[] = [];

    const pushBucket = (raw: unknown, groupLabel: string | null): void => {
        const bucket = asRecord(raw);
        if (!bucket) return;
        // A disabled bucket is not part of this account's plan; reporting it
        // as 0%-used would invent headroom that does not exist. (Not seen in
        // live responses, but the field exists on the proto.)
        if (bucket.disabled === true) return;
        const usedPercent = bucketUsedPercent(bucket);
        if (usedPercent === null) return;
        const own = bucketName(bucket);
        out.push({
            name: groupLabel ? `${groupLabel} · ${own}` : own,
            usedPercent,
            windowMinutes: windowMinutes(bucket.window) ?? 0,
            resetsAt: toResetMs(bucket.resetTime),
        });
    };

    for (const rawGroup of asArray(data.groups)) {
        const group = asRecord(rawGroup);
        if (!group) continue;
        const label = typeof group.displayName === 'string' && group.displayName.trim() !== ''
            ? group.displayName.trim()
            : null;
        for (const bucket of asArray(group.buckets)) pushBucket(bucket, label);
    }
    for (const bucket of asArray(data.buckets)) pushBucket(bucket, null);

    return out;
}

/**
 * Map buckets onto a fixed axis by their own reported window.
 *
 * Antigravity reports one bucket PER GROUP per window (Gemini vs Claude/GPT
 * both have a weekly and a 5h bucket), so several buckets can match one axis.
 * The WORST (highest used) is chosen: the axis is a single headline number and
 * under-reporting consumption is the dangerous direction — a caller deciding
 * whether to route work here must not be told 0% when one pool is exhausted.
 * A mismatch leaves the axis null and the buckets carry the detail.
 */
function axisWindow(buckets: QuotaBucket[], targetMinutes: number): QuotaWindow | null {
    // Allow 10% slack so a 7d/30d window reported slightly off still matches.
    const tolerance = targetMinutes * 0.1;
    const matches = buckets.filter(
        (b) => b.windowMinutes > 0 && Math.abs(b.windowMinutes - targetMinutes) <= tolerance,
    );
    if (matches.length === 0) return null;
    const worst = matches.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
    return {
        usedPercent: worst.usedPercent,
        windowMinutes: worst.windowMinutes,
        resetsAt: worst.resetsAt,
    };
}

function mapQuotaSummary(data: unknown): ProviderQuota {
    const root = asRecord(data);
    if (!root) {
        return quotaFailure('antigravity-cli', 'error', 'Antigravity quota response was not an object', {
            source: 'oauth',
            failureKind: 'parse',
        });
    }

    const buckets = collectBuckets(root);
    if (buckets.length === 0) {
        // Distinct from a transport failure: the call worked, the account just
        // has no readable quota bucket. 'no-data' is the kind for "channel
        // fine, no current reading".
        return quotaFailure(
            'antigravity-cli',
            'unavailable',
            'Antigravity reported no quota buckets for this account',
            { source: 'oauth', failureKind: 'no-data' },
        );
    }

    return {
        provider: 'antigravity-cli',
        session: axisWindow(buckets, SESSION_WINDOW_MINUTES),
        weekly: axisWindow(buckets, WEEKLY_WINDOW_MINUTES),
        buckets,
        updatedAt: Date.now(),
        error: null,
        status: 'ok',
        metadata: { source: 'oauth' },
    };
}

function retryAfterMs(header: string | null, nowMs: number): number | undefined {
    if (!header) {
        return undefined;
    }
    const seconds = Number(header);
    if (Number.isFinite(seconds)) {
        return nowMs + seconds * 1000;
    }
    const at = new Date(header).getTime();
    return Number.isNaN(at) ? undefined : at;
}

/**
 * Fetch Antigravity subscription quota. Never throws — every failure path
 * resolves to a snapshot whose `status` is 'error' or 'unavailable', so a quota
 * problem can never exclude the provider from routing (fail-open).
 */
export async function fetchAntigravityQuota(overrides: QuotaFetchDeps = {}): Promise<ProviderQuota> {
    const deps = resolveDeps(overrides);

    const credentialsResult = await readCredentials(deps);
    if (credentialsResult.kind === 'unsupported-platform') {
        // Explicit, not silent — and specific about WHY per platform, because
        // "unverified" and "structurally impossible" call for different
        // follow-ups. See the PLATFORM SCOPE note in the header for the
        // survey these messages summarize.
        return quotaFailure(
            'antigravity-cli',
            'unavailable',
            unsupportedPlatformReason(credentialsResult.platform),
            { source: 'keychain', failureKind: 'unsupported' },
        );
    }
    if (credentialsResult.kind === 'missing') {
        return quotaFailure('antigravity-cli', 'unavailable', 'Not signed in to Antigravity', {
            source: 'keychain',
            failureKind: 'missing-credentials',
        });
    }
    if (credentialsResult.kind === 'invalid') {
        return quotaFailure('antigravity-cli', 'error', credentialsResult.reason, {
            source: 'keychain',
            failureKind: 'parse',
        });
    }

    const credentials = credentialsResult.credentials;

    // Business/enterprise accounts are served by a DIFFERENT API
    // (`businessaicode.googleapis.com` / FetchQuotaStatus). No such account was
    // available to verify against, so rather than aim the consumer endpoint at
    // one and mis-report, say plainly that it is not supported.
    if (credentials.authMethod !== null && credentials.authMethod !== 'consumer') {
        return quotaFailure(
            'antigravity-cli',
            'unavailable',
            `Antigravity quota is only supported for personal (consumer) accounts; this machine is signed in as "${credentials.authMethod}"`,
            { source: 'keychain', failureKind: 'unsupported' },
        );
    }

    if (isExpired(credentials, deps.now())) {
        // Deliberately do not refresh: the CLI owns the token lifecycle.
        return quotaFailure(
            'antigravity-cli',
            'error',
            'Antigravity access token expired — the agy CLI refreshes it on next use; quota will report again after that.',
            { source: 'keychain', failureKind: 'expired-token' },
        );
    }

    try {
        const response = await deps.fetch(`${baseUrl(deps.env)}:retrieveUserQuotaSummary`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${credentials.accessToken}`,
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            // ★MUST stay `{}` — verified live that sending `project` or
            // `metadata` makes the server answer 429/400.
            body: '{}',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (response.status === 401 || response.status === 403) {
            return quotaFailure(
                'antigravity-cli',
                'error',
                `Antigravity quota request was rejected (HTTP ${response.status})`,
                { source: 'oauth', failureKind: 'unauthorized' },
            );
        }
        if (response.status === 429) {
            return quotaFailure('antigravity-cli', 'error', 'Antigravity quota request was rate limited', {
                source: 'oauth',
                failureKind: 'rate-limited',
                retryAtMs: retryAfterMs(response.headers?.get?.('retry-after') ?? null, deps.now()),
            });
        }
        if (!response.ok) {
            return quotaFailure(
                'antigravity-cli',
                'error',
                `Antigravity quota request failed (HTTP ${response.status})`,
                { source: 'oauth', failureKind: response.status >= 500 ? 'server' : 'unknown' },
            );
        }

        return mapQuotaSummary(await response.json());
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return quotaFailure('antigravity-cli', 'error', `Antigravity quota request failed: ${message}`, {
            source: 'oauth',
            failureKind: 'network',
        });
    }
}
