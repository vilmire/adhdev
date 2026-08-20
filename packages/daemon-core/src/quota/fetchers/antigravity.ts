/**
 * Antigravity CLI (`agy`, Google) quota fetcher.
 *
 * Auth philosophy (see CLAUDE.md): ADHDev does NOT manage provider API keys.
 * We read the OAuth credential the `agy` CLI already stored and use it for a
 * single authenticated POST. We never rotate or delete it ourselves.
 *
 * ★THIS FETCHER PERFORMS NO OAUTH TOKEN EXCHANGE. It reads the access token
 * the CLI already stored and spends it on ONE authenticated POST. When that
 * token has lapsed we report it and stop — we do NOT redeem the refresh token.
 *
 * ★WHY — a self-refresh shipped on 2026-08-20 (317debd2) and was REVERTED the
 * same day after causing an incident. To avoid hardcoding Google OAuth client
 * credentials (push protection blocks them, and a pinned pair goes stale) it
 * scraped candidate client ids/secrets out of the installed `agy` binary and
 * found the right combination BY TRIAL — POSTing each id×secret pair to
 * Google's token endpoint until one returned 200. Within minutes of the
 * rollout three machines were answered 429, 17–31s apart.
 *
 * ★The obvious reading — "same account, so it is an account-level rate limit"
 * — is WRONG and was corrected by the owner: the Mac and the Windows hosts are
 * signed in to DIFFERENT accounts. What actually indicts the trial loop is
 * that at the same moment, on the same host and endpoint, the `agy` CLI itself
 * kept working: only our requests were refused. A burst of token exchanges
 * carrying deliberately-wrong client secrets is, in shape, indistinguishable
 * from credential stuffing — so it is treated as the trigger.
 *
 * ★Consequences, all deliberate and none of them a bug to be "fixed":
 *   - There is NO refresh path, no binary scan, no client-pair discovery and
 *     no write path to the credential store. Nothing here may POST to
 *     oauth2.googleapis.com; a test pins that the token endpoint is never
 *     contacted on ANY path through this module.
 *   - The token is refreshed ONLY by the CLI, and only when the CLI RUNS —
 *     measured 2026-08-20: the keychain item's mtime tracks the last `agy`
 *     launch exactly, and the token had sat expired for ~60h on an otherwise
 *     healthy account. So the expiry message names the one action that fixes
 *     it: run `agy` once.
 *   - An expired token therefore reports `expired-token`, which is a
 *     TRANSIENT failure kind, so the shared last-good carry-forward keeps the
 *     previous numbers on screen (marked "refreshing") instead of blanking
 *     them — see the LAST-GOOD note below.
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
 * ★PLATFORM SCOPE — darwin and win32. Both were surveyed on real machines;
 * linux is the one platform that stays unsupported:
 *
 *   win32 — RESOLVED 2026-08-20 by a machine survey (recon ddd6f3df) that
 *     DISPROVED an earlier version of this note, which claimed "cmdkey /list
 *     shows no antigravity entry". It does:
 *         Target:      LegacyGeneric:target=gemini:antigravity
 *         User:        antigravity
 *         Persistence: Local machine
 *     That is the SAME go-keyring service/account pair as macOS, backed by
 *     the legacy wincred generic store — NOT the WinRT PasswordVault the old
 *     note speculated about. The credential is read with CredRead (advapi32)
 *     via a one-shot PowerShell P/Invoke, and the same go-keyring base64
 *     decode applies. Verified facts behind this: the machine's live CLI log
 *     shows `doRefreshQuota` → `retrieveUserQuotaSummary` calls, so the
 *     endpoint and the credential are both real on that host.
 *
 *     ★Two adjacent win32 facts, recorded so they are not re-derived, both
 *     OUT OF SCOPE for this fetcher:
 *       - The SAME DAY's first survey claimed there was NO `agy` binary on
 *         the machine at all; a re-survey (recon 4b78f092) disproved THAT
 *         too: `agy.exe` exists at `%LOCALAPPDATA%\agy\bin\agy.exe` and was
 *         missed only because the daemon's INHERITED PATH is stale and lacks
 *         that directory. Keep that measurement in mind for ANY future code
 *         that has to find this binary — a PATH-only lookup reports "not
 *         installed" on a machine where it plainly is. (This fetcher no
 *         longer locates the binary at all; the scan went out with the
 *         self-refresh.) Separately, the IDE's `antigravity.cmd chat` opens a
 *         GUI panel rather than a terminal TUI — a different entry point, not
 *         this CLI.
 *       - `findBinary()` (providers/version-archive.ts) consults only
 *         `provider.binary`, never the manifest's `aliases`. On win32 the CLI
 *         entry point is `antigravity` while the manifest's `binary` is `agy`,
 *         so detection can report `installed: false` with the IDE CLI present,
 *         in which case quota is never even asked for. A genuine detection
 *         gap, deliberately not fixed here.
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
 * platforms other than darwin/win32. A wrong number is far worse than an
 * honest "not supported".
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
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★THE QUOTA METHODS HAVE THEIR OWN CALL BUDGET — poll them sparingly.
 *
 * Observed 2026-08-16 while developing this fetcher: after a few dozen probes
 * the endpoint began answering 429 RESOURCE_EXHAUSTED and kept doing so for
 * ~30 minutes. It is NOT an auth problem and NOT a general outage — measured
 * with the SAME token, at the SAME moment, against the SAME host:
 *
 *     loadCodeAssist            -> 200
 *     retrieveUserQuotaSummary  -> 429 RESOURCE_EXHAUSTED
 *     retrieveUserQuota         -> 429 RESOURCE_EXHAUSTED
 *
 * So the budget is per-METHOD, and both quota methods share the exhaustion.
 * No Retry-After header is sent, so the retry delay is ours to choose.
 *
 * Consequences for anyone touching the refresh cadence:
 *   - 429 is classified `rate-limited`, which is TRANSIENT, so refresh.ts
 *     schedules a bounded exponential backoff (2m → 4m → 8m → 15m, then it
 *     stops) and carries the last good windows forward. That is the correct
 *     behaviour and should not be "fixed" into an aggressive retry.
 *   - Do NOT add a short-interval poll or a retry-until-success loop for this
 *     provider. Doing so spends the same budget the CLI's own quota view needs
 *     and can lock the user out of their own usage display.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ★LAST-GOOD SNAPSHOT — already handled upstream; do NOT add a cache here.
 *
 * Because the token only refreshes when the CLI runs, a daemon host can go
 * days without a readable one, and a fetcher that simply reported the failure
 * would drop the last known numbers to nothing. That retention is NOT this
 * fetcher's job: `carryForwardLastGoodWindows` (quota/refresh.ts) keeps the
 * previous session/weekly windows with their ORIGINAL `updatedAt` whenever a
 * fresh read fails with a TRANSIENT kind, and the snapshot is persisted across
 * restarts (quota/persist.ts). It is the same mechanism kimi's expired-token
 * ticks ride on — generic, not per-provider.
 *
 * What this fetcher must do to participate is exactly one thing: classify an
 * expired/unauthorized/network/server/429 failure with a TRANSIENT
 * `failureKind` (see TRANSIENT_QUOTA_FAILURE_KINDS). It does. A NON-transient
 * kind (`missing-credentials`, `parse`, `unsupported`) deliberately does NOT
 * carry forward — signed out or unsupported is a real state that stale numbers
 * would mask.
 *
 * ★Retained numbers are LABELLED, never passed off as current: the carry
 * marks `metadata.lastGoodWindows`, which renders as "· refreshing" in the
 * dashboards (web-core `formatQuotaWindow`) and "(refreshing)" in `adhdev
 * quota` (quota/cli.ts). Anything added here that returned an old number
 * WITHOUT that marker would be presenting stale data as a live reading.
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
/** A credential-store lookup must never hang a refresh tick. */
const CRED_STORE_TIMEOUT_MS = 5_000;

/** go-keyring's marker for a base64-encoded secret. */
const GO_KEYRING_BASE64_PREFIX = 'go-keyring-base64:';

const KEYCHAIN_SERVICE = 'gemini';
const KEYCHAIN_ACCOUNT = 'antigravity';

/**
 * go-keyring's wincred target is `<service>:<account>` — confirmed in
 * `cmdkey /list` on the surveyed machine as
 * `LegacyGeneric:target=gemini:antigravity` (see PLATFORM SCOPE above).
 */
const WINCRED_TARGET = `${KEYCHAIN_SERVICE}:${KEYCHAIN_ACCOUNT}`;

/**
 * One-shot CredRead (advapi32) for the go-keyring wincred item, run through
 * Windows PowerShell. Exit 44 mirrors the macOS `security` not-found code
 * (win32 ERROR_NOT_FOUND 1168 — the ordinary "not signed in" state); any
 * other failure writes the win32 error to stderr and exits 1 so the reason
 * surfaces instead of degrading into a silent "missing".
 *
 * Passed to powershell.exe via -EncodedCommand (UTF-16LE base64), which
 * sidesteps every quoting/escaping concern. NOT verifiable from the macOS
 * dev machine beyond unit tests with a stubbed spawn — the CREDENTIAL struct
 * layout is the documented advapi32 one, but first real-machine run is the
 * true test (win32 CredRead P/Invoke is a well-trodden pattern).
 *
 * ★READ ONLY, and deliberately so: `CredWrite` is not even declared here. The
 * fetcher has no write path to the credential store — the one that existed
 * (persisting a rotated refresh token) went out with the self-refresh.
 */
const WINCRED_READ_PS1 = `
$ErrorActionPreference = 'Stop'
$def = @'
using System;
using System.Runtime.InteropServices;
public static class AdhDevCred {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CRED {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public long LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
    [DllImport("advapi32.dll")]
    public static extern void CredFree(IntPtr cred);
}
'@
Add-Type -TypeDefinition $def
$p = [IntPtr]::Zero
if (-not [AdhDevCred]::CredRead('${WINCRED_TARGET}', 1, 0, [ref]$p)) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($err -eq 1168) { exit 44 }
    [Console]::Error.Write("CredRead failed: win32 error $err")
    exit 1
}
try {
    $c = [Runtime.InteropServices.Marshal]::PtrToStructure($p, [type][AdhDevCred+CRED])
    $buf = New-Object byte[] $c.CredentialBlobSize
    [Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $buf, 0, $c.CredentialBlobSize)
    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($buf))
} finally {
    [AdhDevCred]::CredFree($p)
}
`;

function baseUrl(env: NodeJS.ProcessEnv): string {
    const override = env.ANTIGRAVITY_CLOUDCODE_BASE_URL?.trim();
    return (override ? override : DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/**
 * ★No `refreshToken` field, deliberately. The stored blob HAS one, but this
 * fetcher has no use for it — reading it into memory would only invite a
 * future edit to spend it. See the header for why redeeming it is banned.
 */
interface AntigravityCredentials {
    accessToken: string;
    /** Unix ms, or null when the payload records no parseable expiry. */
    expiresAtMs: number | null;
    /** `consumer` for a personal plan; business accounts use another API. */
    authMethod: string | null;
}

type CredentialsResult =
    | {
        kind: 'ok';
        credentials: AntigravityCredentials;
        platform: string;
    }
    | { kind: 'missing'; platform: string }
    | { kind: 'unsupported-platform'; platform: string }
    | { kind: 'invalid'; platform: string; reason: string };

/** metadata.source label for the platform's credential store. */
function storeSource(platform: string): string {
    return platform === 'win32' ? 'wincred' : 'keychain';
}

/**
 * Why this platform is not supported, in the user's words. Only linux (and
 * unrecognized platforms) land here: win32 moved to SUPPORTED after the
 * 2026-08-20 survey found the credential in the legacy wincred store — see
 * the PLATFORM SCOPE note in the header.
 */
function unsupportedPlatformReason(platform: string): string {
    if (platform === 'linux') {
        return 'Antigravity quota is not supported on Linux: the CLI credential lives in the freedesktop Secret Service, which is unavailable on a headless host (no session-bus service, and the first unlock needs a GUI prompt). Quota is currently supported on macOS and Windows.';
    }
    return `Antigravity quota is only supported on macOS and Windows (this machine reports platform "${platform}").`;
}

interface ChildResult {
    code: number | null;
    stdout: string;
    stderr: string;
}

/**
 * Spawn a credential-store helper, collect its output, resolve on exit.
 * Rejects only on a spawn failure or a timeout, so a wedged store prompt can
 * never hang a refresh tick forever. Goes through `deps.spawn` rather than
 * importing child_process directly so tests can drive every branch without
 * touching a real store — the same injection the codex fetcher uses.
 *
 * ★Takes no stdin: both callers READ. The parameter existed only to pipe a
 * new credential blob into the wincred write-back, which is gone.
 */
function runCredStoreCommand(
    deps: Required<QuotaFetchDeps>,
    command: string,
    args: string[],
): Promise<ChildResult> {
    return new Promise((resolve, reject) => {
        let child: QuotaChildProcess;
        try {
            child = deps.spawn(command, args, { env: deps.env });
        } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
        }

        let settled = false;
        let stdout = '';
        let stderr = '';
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
                reject(new Error(`Credential store command timed out (${command})`));
            });
        }, CRED_STORE_TIMEOUT_MS);
        if (typeof (timer as { unref?: () => void }).unref === 'function') {
            (timer as { unref: () => void }).unref();
        }

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.on('error', (err) => finish(() => reject(err)));
        child.on('exit', (code) => {
            finish(() => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
        });

        child.stdin.end();
    });
}

/** -EncodedCommand takes UTF-16LE base64 and sidesteps all quoting issues. */
function powershellArgs(script: string): string[] {
    return [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ];
}

/**
 * Read the raw keychain blob via `/usr/bin/security` — the same binary
 * go-keyring's macOS backend shells out to, so this reads exactly what `agy`
 * wrote. READ ONLY: `find-generic-password` cannot modify the item.
 *
 * Resolves to null when the item does not exist (`security` exits 44), which
 * is the ordinary "not signed in" state and not an error worth reporting as
 * broken. stderr is collected but not surfaced: `security` writes "could not
 * be found in the keychain" there for the not-signed-in case, which is
 * already conveyed by the exit code.
 */
async function readKeychainBlob(deps: Required<QuotaFetchDeps>): Promise<string | null> {
    const res = await runCredStoreCommand(
        deps,
        '/usr/bin/security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
    );
    return res.code === 0 && res.stdout !== '' ? res.stdout : null;
}

/**
 * Read the same go-keyring item from the Windows Credential Manager via a
 * one-shot CredRead P/Invoke. Exit 44 (ERROR_NOT_FOUND) maps to null like
 * the macOS path; any OTHER failure rejects with the win32 error so the
 * reason reaches the user instead of masquerading as "not signed in".
 */
async function readWinCredBlob(deps: Required<QuotaFetchDeps>): Promise<string | null> {
    const res = await runCredStoreCommand(deps, 'powershell.exe', powershellArgs(WINCRED_READ_PS1));
    if (res.code === 0) {
        return res.stdout === '' ? null : res.stdout;
    }
    if (res.code === 44) {
        return null;
    }
    throw new Error(res.stderr !== '' ? res.stderr : `CredRead exited with code ${res.code}`);
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
function parseCredentials(
    decoded: string,
    platform: string,
): CredentialsResult {
    let parsed: unknown;
    try {
        parsed = JSON.parse(decoded);
    } catch {
        return { kind: 'invalid', platform, reason: 'Antigravity credential is not valid JSON' };
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return { kind: 'invalid', platform, reason: 'Antigravity credential is not an object' };
    }
    const root = parsed as Record<string, unknown>;
    // Tolerate a flattened payload as well as the nested `token` object seen
    // today — the layout is the CLI's private detail, not a contract.
    const token = typeof root.token === 'object' && root.token !== null
        ? (root.token as Record<string, unknown>)
        : root;

    const accessToken = token.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
        return { kind: 'invalid', platform, reason: 'Antigravity credential has no access token' };
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

    // `token.refresh_token` is deliberately NOT read — see AntigravityCredentials.
    return {
        kind: 'ok',
        credentials: { accessToken, expiresAtMs, authMethod },
        platform,
    };
}

async function readCredentials(deps: Required<QuotaFetchDeps>): Promise<CredentialsResult> {
    // `ADHDEV_ANTIGRAVITY_PLATFORM` is a test seam so the win32 and
    // unsupported-platform branches are exercisable from a macOS test run;
    // it is never set in production.
    const platform = deps.env.ADHDEV_ANTIGRAVITY_PLATFORM?.trim() || process.platform;
    if (platform !== 'darwin' && platform !== 'win32') {
        return { kind: 'unsupported-platform', platform };
    }

    let raw: string | null;
    try {
        raw = platform === 'darwin' ? await readKeychainBlob(deps) : await readWinCredBlob(deps);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { kind: 'invalid', platform, reason: `Unable to read the Antigravity credential: ${message}` };
    }
    if (raw === null || raw === '') {
        return { kind: 'missing', platform };
    }
    return parseCredentials(decodeKeyringSecret(raw), platform);
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
            { source: storeSource(credentialsResult.platform), failureKind: 'unsupported' },
        );
    }
    if (credentialsResult.kind === 'missing') {
        return quotaFailure('antigravity-cli', 'unavailable', 'Not signed in to Antigravity', {
            source: storeSource(credentialsResult.platform),
            failureKind: 'missing-credentials',
        });
    }
    if (credentialsResult.kind === 'invalid') {
        return quotaFailure('antigravity-cli', 'error', credentialsResult.reason, {
            source: storeSource(credentialsResult.platform),
            failureKind: 'parse',
        });
    }

    // `const`: nothing may swap in a token this fetcher obtained itself.
    const credentials = credentialsResult.credentials;
    const source = storeSource(credentialsResult.platform);

    // Business/enterprise accounts are served by a DIFFERENT API
    // (`businessaicode.googleapis.com` / FetchQuotaStatus). No such account was
    // available to verify against, so rather than aim the consumer endpoint at
    // one and mis-report, say plainly that it is not supported.
    if (credentials.authMethod !== null && credentials.authMethod !== 'consumer') {
        return quotaFailure(
            'antigravity-cli',
            'unavailable',
            `Antigravity quota is only supported for personal (consumer) accounts; this machine is signed in as "${credentials.authMethod}"`,
            { source, failureKind: 'unsupported' },
        );
    }

    if (isExpired(credentials, deps.now())) {
        // ★We do NOT redeem the stored refresh token — see the header for the
        // incident that removed that path. The CLI owns the token lifecycle,
        // and it only refreshes on LAUNCH, so the message names that action
        // explicitly rather than describing the mechanism: the earlier wording
        // ("the agy CLI refreshes it on next use") stated a fact about the CLI
        // and left the reader with nothing to do. `expired-token` is transient,
        // so the last good numbers stay on screen marked "refreshing" while
        // this shows.
        return quotaFailure(
            'antigravity-cli',
            'error',
            'Antigravity access token expired — run `agy` once to refresh it, then quota will report again.',
            { source, failureKind: 'expired-token' },
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
