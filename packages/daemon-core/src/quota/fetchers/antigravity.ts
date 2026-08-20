/**
 * Antigravity CLI (`agy`, Google) quota fetcher.
 *
 * Auth philosophy (see CLAUDE.md): ADHDev does NOT manage provider API keys.
 * We read the OAuth credential the `agy` CLI already stored and use it for a
 * single authenticated POST. We never rotate or delete it ourselves.
 *
 * When the access token has expired we REDEEM the stored refresh token
 * against Google's token endpoint instead of waiting for the CLI's next run.
 * An earlier version refused to do that — fearing Google's refresh flow would
 * rotate the refresh token and thereby log out a live `agy` session — and
 * was effectively dead in the field: the CLI only refreshes when someone
 * launches it, so on a machine where the CLI is rarely opened (the common
 * case for a daemon host; observed 2026-08-20: token expired ~60h with the
 * keychain item untouched since the last CLI run) quota reported a permanent
 * `expired-token` while the account was fine.
 *
 * ★That rotation fear was DISPROVEN LIVE 2026-08-20: a refresh exchange with
 * the CLI's own OAuth client (discovered at runtime — see below) returned 200
 * with a new access token and NO new `refresh_token` — this client does not
 * rotate on use, so a read-only refresh leaves the CLI's stored credential
 * valid. The single write path that remains is defensive: IF Google ever
 * answers a refresh WITH a new refresh_token, the updated blob is written
 * straight back to the same store item, because failing to persist a rotated
 * token is what would actually log the session out. A rejected refresh token
 * (invalid_grant from every viable client pair) means the session is signed
 * out and is reported as such — never retried blindly.
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
 *         that directory. This is exactly why the OAuth-client discovery
 *         below searches known install paths in addition to PATH. Separately,
 *         the IDE's `antigravity.cmd chat` opens a GUI panel rather than a
 *         terminal TUI — a different entry point, not this CLI.
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
import { createReadStream, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * The OAuth client the `agy` CLI uses for its token lifecycle is NOT
 * hardcoded here — it is DISCOVERED AT RUNTIME by scanning the installed
 * `agy` binary for these patterns (see the "OAuth client discovery" section
 * below). Shipping the values in source was tried first and rejected for two
 * reasons: GitHub push protection (correctly) blocks Google OAuth client
 * credentials in a public repo, and a hardcoded pair goes stale the day
 * upstream rotates it. An installed-app client's "secret" is public by
 * design (gemini-cli ships its own the same way); reading it out of the
 * user's own installed binary keeps it out of this repository entirely.
 *
 * ★VERIFIED LIVE 2026-08-20: a refresh exchange with the discovered pair
 * returned 200 and NO new `refresh_token`, i.e. Google does NOT rotate this
 * client's refresh token on use, so redeeming it here leaves the CLI's
 * stored credential valid.
 */
const OAUTH_CLIENT_ID_PATTERN = /[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com/g;
const OAUTH_CLIENT_SECRET_PATTERN = /GOCSPX-[A-Za-z0-9_-]+/g;

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
 * true test (win32 CredRead/CredWrite P/Invoke is a well-trodden pattern).
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
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredWrite(ref CRED cred, int flags);
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

/**
 * Rotation write-back for win32 — the mirror of the read above. The new blob
 * arrives on STDIN so it never appears in the process's command line. Type 1
 * = GENERIC, Persist 2 = LOCAL_MACHINE, matching the surveyed item.
 */
const WINCRED_WRITE_PS1 = `
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
    public static extern bool CredWrite(ref CRED cred, int flags);
}
'@
Add-Type -TypeDefinition $def
$text = [Console]::In.ReadToEnd()
$buf = [Text.Encoding]::UTF8.GetBytes($text)
$c = New-Object AdhDevCred+CRED
$c.Type = 1
$c.TargetName = '${WINCRED_TARGET}'
$c.UserName = '${KEYCHAIN_ACCOUNT}'
$c.Persist = 2
$c.CredentialBlobSize = $buf.Length
$c.CredentialBlob = [Runtime.InteropServices.Marshal]::AllocHGlobal($buf.Length)
[Runtime.InteropServices.Marshal]::Copy($buf, 0, $c.CredentialBlob, $buf.Length)
try {
    if (-not [AdhDevCred]::CredWrite([ref]$c, 0)) {
        $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        [Console]::Error.Write("CredWrite failed: win32 error $err")
        exit 1
    }
} finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($c.CredentialBlob)
}
`;

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
    /** Used to redeem a new access token ourselves when this one has lapsed. */
    refreshToken: string | null;
}

type CredentialsResult =
    | {
        kind: 'ok';
        credentials: AntigravityCredentials;
        platform: string;
        /** The parsed store payload, kept so a rotation write-back preserves it. */
        rawRoot: Record<string, unknown>;
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
 */
function runCredStoreCommand(
    deps: Required<QuotaFetchDeps>,
    command: string,
    args: string[],
    stdin?: string,
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

        if (stdin !== undefined) {
            child.stdin.write(stdin);
        }
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

    const refreshRaw = token.refresh_token;
    const refreshToken = typeof refreshRaw === 'string' && refreshRaw.trim() !== ''
        ? refreshRaw.trim()
        : null;

    return {
        kind: 'ok',
        credentials: { accessToken, expiresAtMs, authMethod, refreshToken },
        platform,
        rawRoot: root,
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

// --- OAuth client discovery (runtime scan of the agy binary) --------------

interface OAuthClientCandidates {
    clientIds: string[];
    clientSecrets: string[];
}

interface OAuthClientPair {
    clientId: string;
    clientSecret: string;
}

/**
 * Where to look for the `agy` binary, in order. PATH alone is NOT enough —
 * measured 2026-08-20 on the Windows host: the daemon's INHERITED PATH was
 * stale and lacked %LOCALAPPDATA%\agy\bin, so a PATH-only lookup reported
 * "binary missing" while the binary existed and the registry PATH resolved
 * it. The per-platform fallback install paths below exist for exactly that
 * case; do not "simplify" them away.
 *
 * `ADHDEV_ANTIGRAVITY_AGY_PATH` overrides everything (tests, exotic installs).
 */
function agyBinaryCandidates(env: NodeJS.ProcessEnv, platform: string): string[] {
    const out: string[] = [];
    const override = env.ADHDEV_ANTIGRAVITY_AGY_PATH?.trim();
    if (override) {
        out.push(override);
    }
    const pathValue = env.PATH ?? env.Path ?? '';
    const names = platform === 'win32' ? ['agy.exe', 'agy.cmd', 'agy.bat', 'agy'] : ['agy'];
    for (const dir of pathValue.split(path.delimiter)) {
        if (dir.trim() === '') continue;
        for (const name of names) {
            out.push(path.join(dir, name));
        }
    }
    // $HOME is honored before os.homedir() so tests can steer the fallback.
    const home = env.HOME?.trim() || os.homedir();
    if (platform === 'win32') {
        const localAppData = env.LOCALAPPDATA?.trim() || path.join(home, 'AppData', 'Local');
        out.push(path.join(localAppData, 'agy', 'bin', 'agy.exe'));
    } else {
        out.push(path.join(home, '.local', 'bin', 'agy'));
    }
    return out;
}

function locateAgyBinary(env: NodeJS.ProcessEnv, platform: string): string | null {
    const seen = new Set<string>();
    for (const candidate of agyBinaryCandidates(env, platform)) {
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        try {
            if (statSync(candidate).isFile()) {
                return candidate;
            }
        } catch {
            // Not there — try the next candidate.
        }
    }
    return null;
}

/**
 * Extraction caches, keyed by `path:size:mtime` so an `agy` self-update
 * invalidates automatically. Bounded: a daemon accumulates at most one key
 * per CLI update, but a leak is a leak — keep the last few only. A cache hit
 * never touches the file contents (one statSync at most): the binary is
 * ~180MB and a full re-scan per quota tick would be unacceptable.
 */
const DISCOVERY_CACHE_MAX = 8;
const candidatesCache = new Map<string, OAuthClientCandidates | null>();
const pairCache = new Map<string, OAuthClientPair>();

function cachePut<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > DISCOVERY_CACHE_MAX) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
    }
}

/**
 * Stream-scan the binary for OAuth client patterns. Chunked with a carry-over
 * tail so a pattern split across a chunk boundary is still found, and the
 * whole 180MB is never held in memory at once. latin1 keeps a 1:1 byte-to-char
 * mapping, so the matches are byte-exact.
 */
async function scanBinaryForOAuthClients(binaryPath: string): Promise<OAuthClientCandidates> {
    const clientIds = new Set<string>();
    const clientSecrets = new Set<string>();
    let tail = '';
    const stream = createReadStream(binaryPath, { highWaterMark: 4 * 1024 * 1024 });
    for await (const chunk of stream) {
        const text = tail + (chunk as Buffer).toString('latin1');
        for (const match of text.matchAll(OAUTH_CLIENT_ID_PATTERN)) {
            clientIds.add(match[0]);
        }
        for (const match of text.matchAll(OAUTH_CLIENT_SECRET_PATTERN)) {
            // ★Adjacent string constants in the binary's string blob can
            // concatenate several secrets into ONE run — verified in the
            // wild (agy 1.1.13): two secrets sit back-to-back and a greedy
            // match swallows both, yielding one unusable monster candidate.
            // Split them back apart on the prefix boundary.
            for (const part of match[0].split('GOCSPX-')) {
                if (part !== '') {
                    clientSecrets.add(`GOCSPX-${part}`);
                }
            }
        }
        tail = text.slice(-512);
    }
    return { clientIds: [...clientIds], clientSecrets: [...clientSecrets] };
}

type CandidatesResult =
    | { kind: 'ok'; statKey: string; candidates: OAuthClientCandidates }
    | { kind: 'unavailable'; reason: string };

async function oauthClientCandidates(
    deps: Required<QuotaFetchDeps>,
    platform: string,
): Promise<CandidatesResult> {
    const binaryPath = locateAgyBinary(deps.env, platform);
    if (binaryPath === null) {
        return {
            kind: 'unavailable',
            reason: 'the agy binary could not be located (searched PATH and the known install paths) — run `agy` once to refresh the session',
        };
    }
    let statKey: string;
    try {
        const stat = statSync(binaryPath);
        statKey = `${binaryPath}:${stat.size}:${stat.mtimeMs}`;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { kind: 'unavailable', reason: `unable to stat the agy binary at ${binaryPath}: ${message}` };
    }
    if (candidatesCache.has(statKey)) {
        const hit = candidatesCache.get(statKey);
        if (hit) {
            return { kind: 'ok', statKey, candidates: hit };
        }
        return {
            kind: 'unavailable',
            reason: `no Google OAuth client pattern was found in the agy binary at ${binaryPath} — it may have changed how it stores credentials; run \`agy\` once to refresh the session`,
        };
    }
    let candidates: OAuthClientCandidates;
    try {
        candidates = await scanBinaryForOAuthClients(binaryPath);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { kind: 'unavailable', reason: `unable to read the agy binary at ${binaryPath}: ${message}` };
    }
    if (candidates.clientIds.length === 0 || candidates.clientSecrets.length === 0) {
        cachePut(candidatesCache, statKey, null);
        return {
            kind: 'unavailable',
            reason: `no Google OAuth client pattern was found in the agy binary at ${binaryPath} — it may have changed how it stores credentials; run \`agy\` once to refresh the session`,
        };
    }
    cachePut(candidatesCache, statKey, candidates);
    return { kind: 'ok', statKey, candidates };
}

// --- token refresh --------------------------------------------------------

type RefreshFailureKind = 'network' | 'server' | 'rate-limited' | 'unauthorized' | 'parse' | 'expired-token';

type RefreshResult =
    | {
        kind: 'ok';
        accessToken: string;
        /** Present only when Google rotated the refresh token — must be persisted. */
        rotatedRefreshToken: string | null;
        expiresInSec: number | null;
    }
    /** invalid_grant from every viable client pair — the session is signed out. */
    | { kind: 'rejected' }
    | { kind: 'failed'; failureKind: RefreshFailureKind; reason: string };

type RefreshAttempt =
    | Extract<RefreshResult, { kind: 'ok' }>
    /** The pair itself is wrong (invalid_client / unauthorized_client). */
    | { kind: 'wrong-client' }
    /**
     * invalid_grant. Ambiguous DURING pairing: a valid pair whose client did
     * not issue this refresh token also answers invalid_grant, so it only
     * means "signed out" once every pair has failed — see refreshAccessToken.
     */
    | { kind: 'invalid-grant' }
    | Extract<RefreshResult, { kind: 'failed' }>;

/** One refresh exchange against Google's token endpoint. */
async function attemptRefresh(
    deps: Required<QuotaFetchDeps>,
    pair: OAuthClientPair,
    refreshToken: string,
): Promise<RefreshAttempt> {
    let response: Awaited<ReturnType<Required<QuotaFetchDeps>['fetch']>>;
    try {
        response = await deps.fetch(OAUTH_TOKEN_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json',
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: pair.clientId,
                client_secret: pair.clientSecret,
                refresh_token: refreshToken,
            }).toString(),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { kind: 'failed', failureKind: 'network', reason: `Antigravity token refresh failed: ${message}` };
    }

    if (response.status === 400 || response.status === 401) {
        let errorField = '';
        try {
            const body = asRecord(await response.json());
            errorField = typeof body?.error === 'string' ? body.error : '';
        } catch {
            // No parseable body; the status alone still classifies below.
        }
        // Google answers an expired/revoked/replaced refresh token with
        // invalid_grant — see the RefreshAttempt note for why that is not
        // immediately "signed out" while pairing.
        if (errorField === 'invalid_grant') {
            return { kind: 'invalid-grant' };
        }
        if (errorField === 'invalid_client' || errorField === 'unauthorized_client') {
            return { kind: 'wrong-client' };
        }
        return {
            kind: 'failed',
            failureKind: 'unauthorized',
            reason: `Antigravity token refresh was rejected (HTTP ${response.status}${errorField ? `: ${errorField}` : ''})`,
        };
    }
    if (response.status === 429) {
        return { kind: 'failed', failureKind: 'rate-limited', reason: 'Antigravity token refresh was rate limited' };
    }
    if (!response.ok) {
        return {
            kind: 'failed',
            failureKind: response.status >= 500 ? 'server' : 'unauthorized',
            reason: `Antigravity token refresh failed (HTTP ${response.status})`,
        };
    }

    const body = asRecord(await response.json().catch(() => null));
    const accessToken = body?.access_token;
    if (typeof accessToken !== 'string' || accessToken === '') {
        return {
            kind: 'failed',
            failureKind: 'parse',
            reason: 'Antigravity token refresh response had no access token',
        };
    }
    const rotated = body?.refresh_token;
    return {
        kind: 'ok',
        accessToken,
        rotatedRefreshToken: typeof rotated === 'string' && rotated !== '' ? rotated : null,
        expiresInSec: toNumber(body?.expires_in),
    };
}

/**
 * Redeem the stored refresh token for a new access token. READ-ONLY against
 * the CLI's session in the normal case: verified live 2026-08-20 that this
 * OAuth client's refresh response carries no new `refresh_token`, so the
 * stored credential stays valid and nothing is written back. See the header
 * for the field failure that motivated this (a daemon host where the CLI is
 * rarely launched otherwise reports `expired-token` forever).
 *
 * The OAuth client pair is discovered from the agy binary (see above). The
 * binary carries more than one client id and secret, and their layout gives
 * NO reliable pairing anchor, so the pair is found by trial: each candidate
 * combination is attempted, a `wrong-client` answer moves to the next, and
 * the first 200 wins and is cached per binary version. ★An `invalid_grant`
 * mid-pairing is NOT yet "signed out" — a valid pair that did not issue this
 * token answers the same way — so every pair is tried before concluding the
 * session is dead.
 */
async function refreshAccessToken(
    deps: Required<QuotaFetchDeps>,
    refreshToken: string,
    platform: string,
): Promise<RefreshResult> {
    const found = await oauthClientCandidates(deps, platform);
    if (found.kind === 'unavailable') {
        return {
            kind: 'failed',
            failureKind: 'expired-token',
            reason: `Antigravity access token expired and could not be refreshed: ${found.reason}`,
        };
    }

    const cached = pairCache.get(found.statKey);
    if (cached) {
        const attempt = await attemptRefresh(deps, cached, refreshToken);
        if (attempt.kind === 'ok') {
            return attempt;
        }
        if (attempt.kind === 'invalid-grant') {
            // This pair redeemed before, so the token itself is dead.
            return { kind: 'rejected' };
        }
        if (attempt.kind !== 'wrong-client') {
            return attempt;
        }
        // The cached pair stopped being accepted (upstream rotated clients?)
        // — fall through and re-pair from scratch.
        pairCache.delete(found.statKey);
    }

    let sawInvalidGrant = false;
    for (const clientId of found.candidates.clientIds) {
        for (const clientSecret of found.candidates.clientSecrets) {
            const attempt = await attemptRefresh(deps, { clientId, clientSecret }, refreshToken);
            if (attempt.kind === 'ok') {
                cachePut(pairCache, found.statKey, { clientId, clientSecret });
                return attempt;
            }
            if (attempt.kind === 'wrong-client') {
                continue;
            }
            if (attempt.kind === 'invalid-grant') {
                // Inconclusive while other pairs remain — see the doc comment.
                sawInvalidGrant = true;
                continue;
            }
            // Transport/HTTP failures: more combinations cannot help.
            return attempt;
        }
    }
    if (sawInvalidGrant) {
        // Every pair failed and at least one viable pair said invalid_grant —
        // the session is signed out; only the user can fix it.
        return { kind: 'rejected' };
    }
    return {
        kind: 'failed',
        failureKind: 'parse',
        reason: 'no OAuth client pair extracted from the agy binary could redeem the refresh token — run `agy` once to refresh the session',
    };
}

/**
 * Persist a ROTATED credential back to the same store item — the fetcher's
 * ONLY write path, taken iff Google answered a refresh with a new
 * `refresh_token`. Not persisting a rotated token is what would actually log
 * the CLI's session out, so this write is protective. The full payload is
 * rewritten (fresh access token and expiry too) and re-encoded with the
 * go-keyring prefix exactly as the CLI's own write produced it.
 */
async function persistRotatedCredential(
    deps: Required<QuotaFetchDeps>,
    platform: string,
    rawRoot: Record<string, unknown>,
    refresh: Extract<RefreshResult, { kind: 'ok' }>,
): Promise<void> {
    const root: Record<string, unknown> = { ...rawRoot };
    const nested = typeof root.token === 'object' && root.token !== null;
    const token: Record<string, unknown> = nested
        ? { ...(root.token as Record<string, unknown>) }
        : root;
    token.access_token = refresh.accessToken;
    token.refresh_token = refresh.rotatedRefreshToken;
    if (refresh.expiresInSec !== null) {
        // Go's time.Time unmarshals any RFC3339 form, so UTC `Z` is fine.
        token.expiry = new Date(deps.now() + refresh.expiresInSec * 1000).toISOString();
    }
    if (nested) {
        root.token = token;
    }
    const blob = GO_KEYRING_BASE64_PREFIX + Buffer.from(JSON.stringify(root), 'utf-8').toString('base64');

    if (platform === 'win32') {
        const res = await runCredStoreCommand(deps, 'powershell.exe', powershellArgs(WINCRED_WRITE_PS1), blob);
        if (res.code !== 0) {
            throw new Error(res.stderr !== '' ? res.stderr : `CredWrite exited with code ${res.code}`);
        }
        return;
    }
    // NOTE: `security` accepts the new password only via argv, so the blob is
    // briefly visible in the local process table. Accepted for this rare,
    // defensive, single-user-machine write; the alternative (Security
    // framework bindings) is a native dependency we do not have.
    const res = await runCredStoreCommand(
        deps,
        '/usr/bin/security',
        ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w', blob],
    );
    if (res.code !== 0) {
        throw new Error(res.stderr !== '' ? res.stderr : `security add-generic-password exited with code ${res.code}`);
    }
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

    let credentials = credentialsResult.credentials;
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
        // The CLI only refreshes its token when someone LAUNCHES it, so a
        // daemon host where the CLI sits idle would report this forever.
        // Redeem the stored refresh token ourselves instead — verified live
        // (see the header) to leave the CLI's session intact.
        if (credentials.refreshToken === null) {
            return quotaFailure(
                'antigravity-cli',
                'error',
                'Antigravity access token expired and the stored credential has no refresh token — run `agy` once to sign in again.',
                { source, failureKind: 'expired-token' },
            );
        }
        const refresh = await refreshAccessToken(deps, credentials.refreshToken, credentialsResult.platform);
        if (refresh.kind === 'rejected') {
            // invalid_grant: the session is signed out. Persistent — retrying
            // re-hears the same answer until the user signs in again.
            return quotaFailure(
                'antigravity-cli',
                'unavailable',
                'Antigravity refresh token was rejected (invalid_grant) — the session is signed out; run `agy` once to sign in again.',
                { source, failureKind: 'missing-credentials' },
            );
        }
        if (refresh.kind === 'failed') {
            return quotaFailure('antigravity-cli', 'error', refresh.reason, {
                source,
                failureKind: refresh.failureKind,
            });
        }
        credentials = { ...credentials, accessToken: refresh.accessToken };
        if (refresh.rotatedRefreshToken !== null) {
            // Defensive write — see persistRotatedCredential. Best-effort: the
            // fresh access token still serves this tick if the write fails,
            // and a lost rotated token surfaces on the NEXT tick as an honest
            // invalid_grant signed-out error rather than a silent desync.
            try {
                await persistRotatedCredential(deps, credentialsResult.platform, credentialsResult.rawRoot, refresh);
            } catch {
                // Surfaced on the next tick via invalid_grant; see above.
            }
        }
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
