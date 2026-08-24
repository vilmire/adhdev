import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same isolation technique as test/mesh/node-facts-quota.test.ts: mock the
// fetcher MODULES (not just the cache) so "never calls a fetcher" is an
// assertion on call counts, not a guess from a fast test. Both
// get_machine_runtime_stats and get_session_info are on-demand commands (a
// dialog open / a machine-page load) — cheap because they only ever read the
// quota cache; if either reached for a live fetch, the codex fetcher's
// ~900ms app-server spawn would land on every open of the panel.
const fetchClaudeQuota = vi.fn()
const fetchCodexQuota = vi.fn()
const fetchCursorQuota = vi.fn()
const fetchGrokQuota = vi.fn()
const fetchKimiQuota = vi.fn()
const fetchOpencodeUsage = vi.fn()
const fetchAntigravityQuota = vi.fn()

vi.mock('../../src/quota/fetchers/antigravity.js', () => ({ fetchAntigravityQuota }))
vi.mock('../../src/quota/fetchers/claude.js', () => ({ fetchClaudeQuota, STALE_AFTER_MS: 60_000 }))
vi.mock('../../src/quota/fetchers/codex.js', () => ({ fetchCodexQuota }))
vi.mock('../../src/quota/fetchers/cursor.js', () => ({ fetchCursorQuota }))
vi.mock('../../src/quota/fetchers/grok.js', () => ({ fetchGrokQuota }))
vi.mock('../../src/quota/fetchers/kimi.js', () => ({ fetchKimiQuota }))
vi.mock('../../src/quota/fetchers/opencode.js', () => ({ fetchOpencodeUsage, OPENCODE_USAGE_DAYS: 7 }))

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
        fetchCursorQuota.mockResolvedValue(okQuota('cursor-cli'))
        fetchGrokQuota.mockResolvedValue(okQuota('grok-cli'))
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
        fetchGrokQuota.mockResolvedValue(okQuota('grok-cli'))
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))
        await refreshQuotaCacheOnce()

        const result: any = await statusMetaHandlers.get_machine_runtime_stats({ deps: {} as any }, {})
        expect(Object.keys(result.machine.quota).sort()).toEqual(['antigravity-cli', 'claude-cli', 'codex-cli', 'cursor-cli', 'grok-cli', 'kimi', 'opencode'])
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
        fetchCursorQuota.mockResolvedValue(okQuota('cursor-cli'))
        fetchGrokQuota.mockResolvedValue(okQuota('grok-cli'))
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
        fetchCursorQuota.mockResolvedValue(okQuota('cursor-cli'))
        fetchGrokQuota.mockResolvedValue(okQuota('grok-cli'))
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
        fetchCursorQuota.mockResolvedValue(okQuota('cursor-cli'))
        fetchGrokQuota.mockResolvedValue(okQuota('grok-cli'))
        fetchKimiQuota.mockResolvedValue(okQuota('kimi'))
        await refreshQuotaCacheOnce()

        const coordDeps = {
            sessionRegistry: { get: vi.fn(() => ({ providerType: 'claude-cli', transport: 'pty' })) },
            cliManager: { findAdapter: vi.fn(() => undefined) },
            providerLoader: { resolve: vi.fn(() => undefined), getMeta: vi.fn(() => undefined) },
        } as any
        const result: any = await statusMetaHandlers.get_session_info({ deps: coordDeps }, { targetSessionId: 'sess-1' })
        expect(Object.keys(result.quota).sort()).toEqual(['antigravity-cli', 'claude-cli', 'codex-cli', 'cursor-cli', 'grok-cli', 'kimi', 'opencode'])
        expect('machineNickname' in result).toBe(true)
    })
})

describe('get_session_info — coordinator-spawn linkage (meshWorker)', () => {
    // registerMeshCoordinator persists to $ADHDEV_CONFIG_DIR — pin it to a tmp
    // dir so this suite never rewrites the live registry (same guard as
    // mesh-coordinator.test.ts).
    let previousConfigDir: string | undefined
    let tmpConfigDir: string
    beforeEach(async () => {
        const { mkdtempSync } = await import('node:fs')
        const { tmpdir } = await import('node:os')
        const { join } = await import('node:path')
        tmpConfigDir = mkdtempSync(join(tmpdir(), 'adhdev-mesh-worker-test-'))
        previousConfigDir = process.env.ADHDEV_CONFIG_DIR
        process.env.ADHDEV_CONFIG_DIR = tmpConfigDir
    })
    afterEach(async () => {
        if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
        else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
        const { rmSync } = await import('node:fs')
        rmSync(tmpConfigDir, { recursive: true, force: true })
    })

    function workerDeps(settings: Record<string, unknown>, extra: Record<string, unknown> = {}) {
        return {
            sessionRegistry: { get: vi.fn((id: string) => (id === 'worker-1' || id === 'coord-1') ? { providerType: 'codex-cli' } : null) },
            cliManager: { findAdapter: vi.fn(() => undefined) },
            instanceManager: { getInstance: vi.fn(() => ({ getState: () => ({ settings }) })) },
            providerLoader: { getMeta: vi.fn(() => undefined) },
            ...extra,
        } as any
    }

    it('joins the worker session stamps with the mesh coordinator registry', async () => {
        const { registerMeshCoordinator, unregisterMeshCoordinator } = await import('../../src/mesh/coordinator-registry.js')
        registerMeshCoordinator({ meshId: 'mesh_x', sessionId: 'coord-1', startedAt: 111, cliType: 'claude-cli' })
        try {
            const res = await statusMetaHandlers.get_session_info(
                { deps: workerDeps({ meshNodeFor: 'mesh_x', meshNodeId: 'node_1', meshActiveTaskId: 'task_9' }) },
                { targetSessionId: 'worker-1' },
            ) as any
            expect(res.success).toBe(true)
            expect(res.meshWorker).toMatchObject({
                meshId: 'mesh_x',
                nodeId: 'node_1',
                taskId: 'task_9',
                coordinatorSessionId: 'coord-1',
                coordinatorCliType: 'claude-cli',
                coordinatorAlive: true,
            })
        } finally {
            unregisterMeshCoordinator('coord-1')
        }
    })

    it('marks the coordinator dead when its session record is gone', async () => {
        const { registerMeshCoordinator, unregisterMeshCoordinator } = await import('../../src/mesh/coordinator-registry.js')
        registerMeshCoordinator({ meshId: 'mesh_y', sessionId: 'coord-gone', startedAt: 5, cliType: 'claude-cli' })
        try {
            const res = await statusMetaHandlers.get_session_info(
                { deps: workerDeps({ meshNodeFor: 'mesh_y' }) },
                { targetSessionId: 'worker-1' },
            ) as any
            expect(res.meshWorker).toMatchObject({ meshId: 'mesh_y', coordinatorSessionId: 'coord-gone', coordinatorAlive: false })
        } finally {
            unregisterMeshCoordinator('coord-gone')
        }
    })

    it('stays null for a session with no mesh stamps', async () => {
        const res = await statusMetaHandlers.get_session_info(
            { deps: workerDeps({}) },
            { targetSessionId: 'worker-1' },
        ) as any
        expect(res.success).toBe(true)
        expect(res.meshWorker).toBeNull()
    })
})
