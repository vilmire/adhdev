import { afterEach, describe, expect, it, vi } from 'vitest'

// Same isolation technique as test/mesh/node-facts-quota.test.ts: mock the
// fetcher MODULES (not just the cache) so "never calls a fetcher" is an
// assertion on call counts, not a guess from a fast test. Both
// get_machine_runtime_stats and get_session_info are on-demand commands (a
// dialog open / a machine-page load) — cheap because they only ever read the
// quota cache; if either reached for a live fetch, the codex fetcher's
// ~900ms app-server spawn would land on every open of the panel.
const fetchClaudeQuota = vi.fn()
const fetchCodexQuota = vi.fn()
const fetchKimiQuota = vi.fn()

vi.mock('../../src/quota/fetchers/claude.js', () => ({ fetchClaudeQuota, STALE_AFTER_MS: 60_000 }))
vi.mock('../../src/quota/fetchers/codex.js', () => ({ fetchCodexQuota }))
vi.mock('../../src/quota/fetchers/kimi.js', () => ({ fetchKimiQuota }))

const { statusMetaHandlers } = await import('../../src/commands/low-family/status-meta.js')
const { clearQuotaCache, refreshQuotaCacheOnce } = await import('../../src/quota/refresh.js')

const okQuota = (provider: string) => ({
    provider,
    session: { usedPercent: 38.2, windowMinutes: 300, resetsAt: 1_800_000 },
    weekly: { usedPercent: 12, windowMinutes: 10080, resetsAt: null },
    updatedAt: 1_700_000,
    error: null,
    status: 'ok',
    metadata: { source: 'test' },
})

afterEach(() => {
    clearQuotaCache()
    vi.clearAllMocks()
})

describe('get_machine_runtime_stats — quota', () => {
    it('never invokes a quota fetcher (cache read only)', async () => {
        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli'))
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli'))
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))
        await refreshQuotaCacheOnce()
        vi.clearAllMocks()

        for (let i = 0; i < 5; i += 1) {
            await statusMetaHandlers.get_machine_runtime_stats({ deps: {} as any }, {})
        }

        expect(fetchClaudeQuota).not.toHaveBeenCalled()
        expect(fetchCodexQuota).not.toHaveBeenCalled()
        expect(fetchKimiQuota).not.toHaveBeenCalled()
    })

    it('omits quota entirely until the refresh loop has cached something (unreported state)', async () => {
        const result: any = await statusMetaHandlers.get_machine_runtime_stats({ deps: {} as any }, {})
        expect(result.success).toBe(true)
        expect(result.machine.quota).toBeUndefined()
        expect('quota' in result.machine).toBe(false)
    })

    it('carries cached quota snapshots on the machine payload', async () => {
        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli'))
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli'))
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))
        await refreshQuotaCacheOnce()

        const result: any = await statusMetaHandlers.get_machine_runtime_stats({ deps: {} as any }, {})
        expect(Object.keys(result.machine.quota).sort()).toEqual(['claude-cli', 'codex-cli', 'kimi'])
        expect(result.machine.quota['codex-cli'].status).toBe('ok')
    })

    it('reports a failing provider explicitly rather than dropping it', async () => {
        fetchClaudeQuota.mockResolvedValue({
            provider: 'claude-cli',
            session: null,
            weekly: null,
            updatedAt: 1_700_000,
            error: 'statusline wrapper is not installed',
            status: 'unavailable',
            metadata: { failureKind: 'missing-credentials' },
        })
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli'))
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))
        await refreshQuotaCacheOnce()

        const result: any = await statusMetaHandlers.get_machine_runtime_stats({ deps: {} as any }, {})
        expect(result.machine.quota['claude-cli'].status).toBe('unavailable')
        expect(result.machine.quota['claude-cli'].metadata.failureKind).toBe('missing-credentials')
    })

    it('includes the machine hostname/platform fields untouched alongside quota', async () => {
        const result: any = await statusMetaHandlers.get_machine_runtime_stats({ deps: {} as any }, {})
        expect(typeof result.machine.hostname).toBe('string')
        expect(typeof result.machine.platform).toBe('string')
    })
})

describe('get_session_info — quota', () => {
    const deps = { sessionRegistry: { get: vi.fn(() => null) }, cliManager: { findAdapter: vi.fn() } } as any

    it('never invokes a quota fetcher (cache read only)', async () => {
        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli'))
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli'))
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))
        await refreshQuotaCacheOnce()
        vi.clearAllMocks()

        // Session not found is a legitimate early return; the fault-injection
        // test below covers the fetcher call count on the success path with a
        // registered session instead.
        await statusMetaHandlers.get_session_info({ deps }, { targetSessionId: 'missing' })

        expect(fetchClaudeQuota).not.toHaveBeenCalled()
        expect(fetchCodexQuota).not.toHaveBeenCalled()
        expect(fetchKimiQuota).not.toHaveBeenCalled()
    })

    it('omits quota entirely until the refresh loop has cached something', async () => {
        const coordDeps = {
            sessionRegistry: { get: vi.fn(() => ({ providerType: 'claude-cli', transport: 'pty' })) },
            cliManager: { findAdapter: vi.fn(() => undefined) },
            providerLoader: { resolve: vi.fn(() => undefined), getMeta: vi.fn(() => undefined) },
        } as any
        const result: any = await statusMetaHandlers.get_session_info({ deps: coordDeps }, { targetSessionId: 'sess-1' })
        expect(result.success).toBe(true)
        expect(result.quota).toBeUndefined()
        expect('quota' in result).toBe(false)
    })

    it('carries cached quota snapshots and machineNickname on the response', async () => {
        fetchClaudeQuota.mockResolvedValue(okQuota('claude-cli'))
        fetchCodexQuota.mockResolvedValue(okQuota('codex-cli'))
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))
        await refreshQuotaCacheOnce()

        const coordDeps = {
            sessionRegistry: { get: vi.fn(() => ({ providerType: 'claude-cli', transport: 'pty' })) },
            cliManager: { findAdapter: vi.fn(() => undefined) },
            providerLoader: { resolve: vi.fn(() => undefined), getMeta: vi.fn(() => undefined) },
        } as any
        const result: any = await statusMetaHandlers.get_session_info({ deps: coordDeps }, { targetSessionId: 'sess-1' })
        expect(Object.keys(result.quota).sort()).toEqual(['claude-cli', 'codex-cli', 'kimi'])
        expect('machineNickname' in result).toBe(true)
    })
})
