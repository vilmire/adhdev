/**
 * ★RE-LOGIN RECOVERY for the quota retry budget — antigravity (keychain mdat)
 * plus kimi / grok (credential-file mtime).
 *
 * The defect: the daemon reads the `agy` token in the seconds before a
 * re-login completes, records `expired-token`, and burns the whole bounded
 * retry budget (QUOTA_FAILURE_MAX_RETRIES) on probes against the OLD token.
 * `failures` only ever resets on a success, so once spent, `isFailureRetryDue`
 * reports false and nothing re-probes until the hourly backfill — the user
 * signs back in and still stares at a stale error for up to an hour.
 *
 * The fix detects that the CREDENTIAL ITSELF changed (keychain item mtime,
 * which `agy` rewrites on every launch) and resets the budget.
 *
 * ★What these cases guard, in order of how easy each is to regress:
 *   (b) an UNCHANGED stamp must be a no-op — the dead-token provider keeps its
 *       existing backoff and earns no extra probes. This is the safety
 *       argument for the whole feature, so it is asserted explicitly rather
 *       than implied by (a) passing.
 *   (c) the gate must not leak to another provider, another failure kind, or
 *       another platform — this is a SHARED retry path.
 *   (a) a CHANGED stamp resets the budget and makes the provider immediately
 *       re-probeable.
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same module-level fetcher mocking as quota-failure-retry.test.ts: the fetcher
// modules are mocked so call counts are real assertions about WHEN a provider
// was probed, and no test can reach a live keychain or endpoint.
const fetchClaudeQuota = vi.fn()
const fetchCodexQuota = vi.fn()
const fetchCursorQuota = vi.fn()
const fetchGrokQuota = vi.fn()
const fetchKimiQuota = vi.fn()
const fetchOpencodeUsage = vi.fn()
const fetchAntigravityQuota = vi.fn()
const readAntigravityKeychainMtimeMs = vi.fn()

vi.mock('../../src/quota/fetchers/antigravity.js', () => ({
    fetchAntigravityQuota,
    readAntigravityKeychainMtimeMs,
}))
vi.mock('../../src/quota/fetchers/claude.js', () => ({ fetchClaudeQuota, STALE_AFTER_MS: 60_000 }))
vi.mock('../../src/quota/fetchers/codex.js', () => ({ fetchCodexQuota }))
vi.mock('../../src/quota/fetchers/cursor.js', () => ({ fetchCursorQuota }))
vi.mock('../../src/quota/fetchers/grok.js', () => ({ fetchGrokQuota }))
vi.mock('../../src/quota/fetchers/kimi.js', () => ({ fetchKimiQuota }))
vi.mock('../../src/quota/fetchers/opencode.js', () => ({ fetchOpencodeUsage, OPENCODE_USAGE_DAYS: 7 }))

const {
    QUOTA_FAILURE_MAX_RETRIES,
    clearQuotaCache,
    isFailureRetryDue,
    refreshQuotaCacheOnce,
    resetFailureBudgetOnCredentialRenewal,
    __resetQuotaBootRefreshForTests,
    __resetQuotaHydrationForTests,
    __setQuotaCredentialMtimeReaderForTests,
} = await import('../../src/quota/refresh.js')
const { quotaFailure } = await import('../../src/quota/types.js')

const allEnabled = () => true
const agyFetch = { provider: 'antigravity-cli' as const, fetch: fetchAntigravityQuota }

/** Drive the budget to exhausted the way the real world does: N+1 failures. */
async function exhaustBudget(
    fetcher: { provider: any; fetch: any },
    mock: ReturnType<typeof vi.fn>,
    failure: () => unknown,
): Promise<void> {
    for (let i = 0; i <= QUOTA_FAILURE_MAX_RETRIES; i += 1) {
        mock.mockResolvedValueOnce(failure())
        await refreshQuotaCacheOnce([fetcher], allEnabled)
    }
}

const expiredTokenFailure = () =>
    quotaFailure('antigravity-cli', 'error', 'token expired', { failureKind: 'expired-token' })

let home: string
let previousHome: string | undefined
let platformSpy: ReturnType<typeof vi.spyOn> | undefined

/**
 * The detector is darwin-gated, and the suite must pass on the win32/linux
 * runners too — so the platform is forced rather than assumed.
 */
function forcePlatform(platform: NodeJS.Platform): void {
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue(platform) as any
}

beforeEach(() => {
    previousHome = process.env.ADHDEV_CONFIG_DIR
    home = mkdtempSync(join(tmpdir(), 'adhdev-quota-renewal-'))
    process.env.ADHDEV_CONFIG_DIR = home
})

afterEach(() => {
    vi.useRealTimers()
    platformSpy?.mockRestore()
    platformSpy = undefined
    __setQuotaCredentialMtimeReaderForTests(undefined)
    if (previousHome === undefined) delete process.env.ADHDEV_CONFIG_DIR
    else process.env.ADHDEV_CONFIG_DIR = previousHome
    rmSync(home, { recursive: true, force: true })
    clearQuotaCache()
    __resetQuotaBootRefreshForTests()
    __resetQuotaHydrationForTests()
    vi.clearAllMocks()
})

describe('credential-renewal reset — (a) a renewed keychain item revives a spent retry budget', () => {
    it('resets failures and makes the provider immediately retry-due again', async () => {
        forcePlatform('darwin')
        // The stamp the daemon saw while the OLD token kept failing.
        let mtime = 1_000_000
        __setQuotaCredentialMtimeReaderForTests(async () => mtime)

        await exhaustBudget(agyFetch, fetchAntigravityQuota, expiredTokenFailure)

        // Budget spent: the short-fuse retry has stopped scheduling, which is
        // exactly the state that used to pin the stale error for an hour.
        expect(isFailureRetryDue('antigravity-cli', Date.now() + 60 * 60 * 1000)).toBe(false)

        // The user runs `agy` / signs back in — the CLI rewrites the keychain
        // item, so its mtime moves forward.
        mtime = 2_000_000
        const reset = await resetFailureBudgetOnCredentialRenewal('antigravity-cli')

        expect(reset).toBe(true)
        // Re-probeable again on the very next scheduling decision.
        expect(isFailureRetryDue('antigravity-cli', Date.now() + 60 * 60 * 1000)).toBe(true)
    })

    it('a SECOND renewal after the first reset is detected too (the baseline advances)', async () => {
        forcePlatform('darwin')
        let mtime = 1_000_000
        __setQuotaCredentialMtimeReaderForTests(async () => mtime)

        await exhaustBudget(agyFetch, fetchAntigravityQuota, expiredTokenFailure)
        mtime = 2_000_000
        expect(await resetFailureBudgetOnCredentialRenewal('antigravity-cli')).toBe(true)

        // Fail again against the new token, then renew once more.
        await exhaustBudget(agyFetch, fetchAntigravityQuota, expiredTokenFailure)
        expect(await resetFailureBudgetOnCredentialRenewal('antigravity-cli')).toBe(false)
        mtime = 3_000_000
        expect(await resetFailureBudgetOnCredentialRenewal('antigravity-cli')).toBe(true)
    })
})

describe('credential-renewal reset — (b) ★NO-OP when the token did not change', () => {
    it('an UNCHANGED mtime leaves the exhausted budget exhausted (no extra probing of a dead token)', async () => {
        forcePlatform('darwin')
        __setQuotaCredentialMtimeReaderForTests(async () => 1_000_000)

        await exhaustBudget(agyFetch, fetchAntigravityQuota, expiredTokenFailure)
        const callsAfterExhaustion = fetchAntigravityQuota.mock.calls.length

        // Ten wakes' worth of detector runs against a token nobody renewed.
        for (let i = 0; i < 10; i += 1) {
            expect(await resetFailureBudgetOnCredentialRenewal('antigravity-cli')).toBe(false)
        }

        // The budget is still spent, so the provider is still NOT retry-due...
        expect(isFailureRetryDue('antigravity-cli', Date.now() + 60 * 60 * 1000)).toBe(false)
        // ...and the detector itself spent zero provider fetches.
        expect(fetchAntigravityQuota).toHaveBeenCalledTimes(callsAfterExhaustion)
    })

    it('an EARLIER mtime (clock skew / restored backup) is not treated as a renewal', async () => {
        forcePlatform('darwin')
        let mtime = 5_000_000
        __setQuotaCredentialMtimeReaderForTests(async () => mtime)

        await exhaustBudget(agyFetch, fetchAntigravityQuota, expiredTokenFailure)
        mtime = 4_000_000
        expect(await resetFailureBudgetOnCredentialRenewal('antigravity-cli')).toBe(false)
        expect(isFailureRetryDue('antigravity-cli', Date.now() + 60 * 60 * 1000)).toBe(false)
    })

    it('an UNREADABLE keychain (null) falls back to the existing backoff instead of resetting', async () => {
        forcePlatform('darwin')
        __setQuotaCredentialMtimeReaderForTests(async () => null)

        await exhaustBudget(agyFetch, fetchAntigravityQuota, expiredTokenFailure)
        expect(await resetFailureBudgetOnCredentialRenewal('antigravity-cli')).toBe(false)
        expect(isFailureRetryDue('antigravity-cli', Date.now() + 60 * 60 * 1000)).toBe(false)
    })

    it('a THROWING keychain probe never breaks the caller and never resets', async () => {
        forcePlatform('darwin')
        __setQuotaCredentialMtimeReaderForTests(async () => {
            throw new Error('security: keychain locked')
        })

        await exhaustBudget(agyFetch, fetchAntigravityQuota, expiredTokenFailure)
        await expect(resetFailureBudgetOnCredentialRenewal('antigravity-cli')).resolves.toBe(false)
        expect(isFailureRetryDue('antigravity-cli', Date.now() + 60 * 60 * 1000)).toBe(false)
    })
})

describe('credential-renewal reset — (c) the gate does not leak to other kinds or providers', () => {
    /**
     * ★The PLATFORM gate lives in the antigravity SOURCE, not in the shared
     * detector — the file-backed kimi/grok arms are platform-agnostic because a
     * `stat` is. So this asserts the real production source resolves null off
     * darwin (no keychain spawn), rather than injecting a reader, which would
     * bypass the very gate under test.
     */
    it('the antigravity keychain source yields no stamp off darwin', async () => {
        const { readAntigravityKeychainMtimeMs } = await vi.importActual<
            typeof import('../../src/quota/fetchers/antigravity.js')
        >('../../src/quota/fetchers/antigravity.js')

        for (const platform of ['win32', 'linux', 'freebsd']) {
            const spawn = vi.fn()
            const mtime = await readAntigravityKeychainMtimeMs({
                spawn: spawn as never,
                env: { ADHDEV_ANTIGRAVITY_PLATFORM: platform } as NodeJS.ProcessEnv,
            })
            expect(mtime, platform).toBeNull()
            // Never even reaches for the credential store.
            expect(spawn, platform).not.toHaveBeenCalled()
        }
    })

    it('does NOT fire for a NON-credential failure kind (network / rate-limited / parse)', async () => {
        forcePlatform('darwin')
        for (const failureKind of ['network', 'rate-limited', 'parse'] as const) {
            let mtime = 1_000_000
            __setQuotaCredentialMtimeReaderForTests(async () => mtime)

            await exhaustBudget(agyFetch, fetchAntigravityQuota, () =>
                quotaFailure('antigravity-cli', 'error', 'x', { failureKind }))
            mtime = 2_000_000

            expect(await resetFailureBudgetOnCredentialRenewal('antigravity-cli')).toBe(false)

            clearQuotaCache()
            vi.clearAllMocks()
        }
    })

    /**
     * ★codex-cli is deliberately absent from CREDENTIAL_MTIME_SOURCES: it reads
     * a rollout file and holds no OAuth token, so the budget-exhaustion stall
     * this detector rescues cannot occur there. A provider with no source must
     * stay a hard no-op even with a moved stamp and an expired-token failure.
     */
    it('does NOT fire for a provider with NO credential source (codex-cli)', async () => {
        forcePlatform('darwin')
        let mtime = 1_000_000
        __setQuotaCredentialMtimeReaderForTests(async () => mtime)

        const codexFetch = { provider: 'codex-cli' as const, fetch: fetchCodexQuota }
        await exhaustBudget(codexFetch, fetchCodexQuota, () =>
            quotaFailure('codex-cli', 'error', 'token expired', { failureKind: 'expired-token' }))
        mtime = 2_000_000

        expect(await resetFailureBudgetOnCredentialRenewal('codex-cli')).toBe(false)
        expect(isFailureRetryDue('codex-cli', Date.now() + 60 * 60 * 1000)).toBe(false)
    })

    it('does NOT fire when the cached entry is a SUCCESS (nothing to rescue)', async () => {
        forcePlatform('darwin')
        __setQuotaCredentialMtimeReaderForTests(async () => 2_000_000)

        fetchAntigravityQuota.mockResolvedValueOnce({
            provider: 'antigravity-cli',
            session: { usedPercent: 10, windowMinutes: 300, resetsAt: null },
            weekly: null,
            updatedAt: Date.now(),
            error: null,
            status: 'ok',
            metadata: {},
        })
        await refreshQuotaCacheOnce([agyFetch], allEnabled)

        expect(await resetFailureBudgetOnCredentialRenewal('antigravity-cli')).toBe(false)
    })
})

/**
 * ★kimi / grok — the same detector, a FILE-backed source instead of a keychain.
 *
 * ★PREVENTIVE, not a fix for a live symptom. The stale kimi/grok readings
 * observed at the time of writing are NOT this stall: neither account had been
 * re-logged-in since 09-08 (kimi) / 09-04 (grok), so the tokens were simply
 * left expired. These cases exist so that WHEN the user does sign back in,
 * kimi/grok recover the way agy now does instead of sitting on a spent budget.
 *
 * Parameterized over both providers because the contract is identical — only
 * the credential path differs, and that lives in each fetcher.
 */
describe.each([
    { provider: 'kimi' as const, mock: fetchKimiQuota, label: 'kimi' },
    { provider: 'grok-cli' as const, mock: fetchGrokQuota, label: 'grok' },
])('credential-renewal reset — $label (file mtime source)', ({ provider, mock }) => {
    const fetcher = { provider, fetch: mock }
    const expired = () =>
        quotaFailure(provider, 'error', 'token expired', { failureKind: 'expired-token' })

    it('(a) a newer file mtime resets the budget and makes the provider immediately retry-due', async () => {
        let mtime = 1_000_000
        __setQuotaCredentialMtimeReaderForTests(async () => mtime)

        await exhaustBudget(fetcher, mock, expired)
        expect(isFailureRetryDue(provider, Date.now() + 60 * 60 * 1000)).toBe(false)

        // The CLI refreshes / the user re-logs in → the credentials file is
        // rewritten, so its mtime moves forward.
        mtime = 2_000_000

        expect(await resetFailureBudgetOnCredentialRenewal(provider)).toBe(true)
        expect(isFailureRetryDue(provider, Date.now() + 60 * 60 * 1000)).toBe(true)
    })

    it('(b) ★an UNCHANGED file mtime is a complete no-op — the dead token earns no extra probes', async () => {
        __setQuotaCredentialMtimeReaderForTests(async () => 1_000_000)

        await exhaustBudget(fetcher, mock, expired)
        const callsAfterExhaustion = mock.mock.calls.length

        for (let i = 0; i < 10; i += 1) {
            expect(await resetFailureBudgetOnCredentialRenewal(provider)).toBe(false)
        }

        expect(isFailureRetryDue(provider, Date.now() + 60 * 60 * 1000)).toBe(false)
        expect(mock).toHaveBeenCalledTimes(callsAfterExhaustion)
    })

    it('(b) an ABSENT or unreadable credentials file (null) keeps the existing backoff', async () => {
        __setQuotaCredentialMtimeReaderForTests(async () => null)

        await exhaustBudget(fetcher, mock, expired)
        expect(await resetFailureBudgetOnCredentialRenewal(provider)).toBe(false)
        expect(isFailureRetryDue(provider, Date.now() + 60 * 60 * 1000)).toBe(false)
    })

    it('(b) a stat that throws never breaks the caller and never resets', async () => {
        __setQuotaCredentialMtimeReaderForTests(async () => {
            throw new Error('EACCES: permission denied')
        })

        await exhaustBudget(fetcher, mock, expired)
        await expect(resetFailureBudgetOnCredentialRenewal(provider)).resolves.toBe(false)
        expect(isFailureRetryDue(provider, Date.now() + 60 * 60 * 1000)).toBe(false)
    })

    it('(c) does NOT fire for a NON-credential failure kind (network / rate-limited / parse)', async () => {
        for (const failureKind of ['network', 'rate-limited', 'parse'] as const) {
            let mtime = 1_000_000
            __setQuotaCredentialMtimeReaderForTests(async () => mtime)

            await exhaustBudget(fetcher, mock, () =>
                quotaFailure(provider, 'error', 'x', { failureKind }))
            mtime = 2_000_000

            expect(await resetFailureBudgetOnCredentialRenewal(provider), failureKind).toBe(false)

            clearQuotaCache()
            vi.clearAllMocks()
        }
    })

    it('(c) does NOT fire when the cached entry is a SUCCESS', async () => {
        __setQuotaCredentialMtimeReaderForTests(async () => 2_000_000)

        mock.mockResolvedValueOnce({
            provider,
            session: { usedPercent: 10, windowMinutes: 300, resetsAt: null },
            weekly: null,
            updatedAt: Date.now(),
            error: null,
            status: 'ok',
            metadata: {},
        })
        await refreshQuotaCacheOnce([fetcher], allEnabled)

        expect(await resetFailureBudgetOnCredentialRenewal(provider)).toBe(false)
    })
})

/**
 * The file-mtime source itself: metadata only, and fail-safe. Uses the REAL
 * implementation (the module under test is mocked at the top of this file for
 * the scheduling cases, so these import the actual one).
 */
describe('credentialFileMtimeMs — stat only, never opens the file', () => {
    it('returns the mtime of an existing file and null for a missing one', async () => {
        const { credentialFileMtimeMs } = await vi.importActual<
            typeof import('../../src/quota/fetchers/deps.js')
        >('../../src/quota/fetchers/deps.js')

        const dir = mkdtempSync(join(tmpdir(), 'adhdev-cred-mtime-'))
        const file = join(dir, 'auth.json')
        // Content is irrelevant — it is never read — but a real token-shaped
        // body makes the "we only stat it" claim concrete.
        writeFileSync(file, JSON.stringify({ access_token: 'SECRET-MUST-NOT-BE-READ' }))

        const mtime = await credentialFileMtimeMs(file)
        expect(typeof mtime).toBe('number')
        expect(mtime).toBeGreaterThan(0)
        expect(mtime).toBe(statSync(file).mtimeMs)

        // Absent file → null, the ordinary signed-out state. Never throws.
        await expect(credentialFileMtimeMs(join(dir, 'nope.json'))).resolves.toBeNull()
        // A directory path / unreadable target also degrades to null.
        await expect(credentialFileMtimeMs(join(file, 'not-a-dir'))).resolves.toBeNull()

        rmSync(dir, { recursive: true, force: true })
    })
})

describe('keychain mdat parsing — attributes only, never the secret', () => {
    it('parses the mdat timedate that `security find-generic-password` prints without -w', async () => {
        // Verbatim shape of a real `/usr/bin/security find-generic-password
        // -s gemini -a antigravity` dump (no -w ⇒ no password line at all).
        const real = [
            'keychain: "/Users/someone/Library/Keychains/login.keychain-db"',
            'version: 512',
            'class: "genp"',
            'attributes:',
            '    "acct"<blob>="antigravity"',
            '    "cdat"<timedate>=0x32303236303532303033323431335A00  "20260520032413Z\\000"',
            '    "mdat"<timedate>=0x32303236303931323036353434325A00  "20260912065442Z\\000"',
            '    "svce"<blob>="gemini"',
        ].join('\n')

        const { parseKeychainMdatMs } = await vi.importActual<
            typeof import('../../src/quota/fetchers/antigravity.js')
        >('../../src/quota/fetchers/antigravity.js')

        expect(parseKeychainMdatMs(real)).toBe(Date.parse('2026-09-12T06:54:42Z'))
        // cdat must not be mistaken for mdat.
        expect(parseKeychainMdatMs(real)).not.toBe(Date.parse('2026-05-20T03:24:13Z'))
        // No mdat present (item missing, or an unexpected dump) → null, which
        // the caller reads as "no evidence of renewal".
        expect(parseKeychainMdatMs('')).toBeNull()
        expect(parseKeychainMdatMs('security: SecKeychainSearchCopyNext: not found')).toBeNull()
    })
})
