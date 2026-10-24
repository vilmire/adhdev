import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHealthyManagedHostDisk } from '../helpers/managed-host-disk'

useHealthyManagedHostDisk()

const state = vi.hoisted(() => ({
    currentEntry: '', calls: 0, callsAtSpawn: 0, alive: true, replaced: false,
    resourceCode: '', instanceOwner: '', existing: null as any, budgets: [] as number[],
    disconnectCount: 0, birth: 'Sat Oct 24 06:00:00 2026', socketOwners: [54321] as number[],
    legacyUnkeyed: false, duplicateKey: false, unreadableCmd: false, unreadableBirth: false,
    healthyDiagnostics: false, runtimeCount: 2, hostStartedAt: 1000,
    delayCallbackMs: 0, connectErrorCode: '',
    spawn: vi.fn(),
}))
vi.mock('child_process', () => ({
    execFileSync: vi.fn((file: string, args?: readonly string[]) => {
        if (Array.isArray(args) && args.includes('lstart=')) {
            if (state.unreadableBirth || !state.alive) throw new Error('ps birth unavailable')
            return `${state.birth}\n`
        }
        if (String(file).endsWith('lsof')) {
            if (!state.alive || state.socketOwners.length === 0) throw new Error('no socket owner')
            return `${state.socketOwners.join('\n')}\n`
        }
        if (state.unreadableCmd || !state.alive) throw new Error('ps command unavailable')
        const key = `--instance-config-key=${createHash('sha256').update(path.resolve(state.instanceOwner || process.env.ADHDEV_CONFIG_DIR!)).digest('hex')}`
        if (state.legacyUnkeyed) return `node ${state.currentEntry} serve`
        if (state.duplicateKey) return `node ${state.currentEntry} serve ${key} --instance-config-key=${'0'.repeat(64)}`
        return `node ${state.currentEntry} serve ${key}`
    }),
    spawn: (...args: any[]) => state.spawn(...args),
}))
vi.mock('@adhdev/session-host-core', async (original) => {
    const actual = await original<typeof import('@adhdev/session-host-core')>()
    class Client {
        static findConnectedClient() { return state.existing }
        static disconnectClients() { state.disconnectCount++; state.existing = null }
        isConnected() { return true }
        async connect() {
            if (state.resourceCode) throw Object.assign(new Error(state.resourceCode), { code: state.resourceCode })
            if (state.connectErrorCode && !state.replaced) {
                throw Object.assign(new Error(`connect ${state.connectErrorCode}`), { code: state.connectErrorCode })
            }
        }
        async request(_request: unknown, options?: { timeoutMs: number }) {
            state.calls++
            const budget = options?.timeoutMs ?? 30_000
            state.budgets.push(budget)
            if (state.healthyDiagnostics || state.replaced) {
                return {
                    success: true,
                    result: {
                        hostEntryPath: state.currentEntry,
                        hostStartedAt: state.replaced ? 2000 : state.hostStartedAt,
                        runtimeCount: state.replaced ? 0 : state.runtimeCount,
                        supportedRequestTypes: ['delete_session'],
                    },
                }
            }
            if (state.delayCallbackMs > 0) {
                const lagMs = Math.max(0, state.delayCallbackMs - budget)
                await new Promise((resolve) => setTimeout(resolve, state.delayCallbackMs))
                throw Object.assign(
                    new Error('Session host request timed out after 3s (get_host_diagnostics)'),
                    {
                        code: 'SESSION_HOST_REQUEST_TIMEOUT',
                        requestType: 'get_host_diagnostics',
                        scheduledTimeoutMs: budget,
                        actualElapsedMs: state.delayCallbackMs,
                        wallElapsedMs: state.delayCallbackMs,
                        observerLagMs: lagMs,
                    },
                )
            }
            throw Object.assign(
                new Error('Session host request timed out after 3s (get_host_diagnostics)'),
                {
                    code: 'SESSION_HOST_REQUEST_TIMEOUT',
                    requestType: 'get_host_diagnostics',
                    scheduledTimeoutMs: budget,
                    actualElapsedMs: budget,
                    wallElapsedMs: budget,
                    observerLagMs: 0,
                },
            )
        }
        async close() {}
    }
    return { ...actual, SessionHostClient: Client }
})

import { createManagedSessionHost } from '../../src/session-host/managed-host.js'
import { SessionHostClient } from '@adhdev/session-host-core'

describe('managed host bounded recovery including the foreign-entry preflight', () => {
    let configDir: string
    let oldConfig: string | undefined
    let platformDescriptor: PropertyDescriptor | undefined
    beforeEach(() => {
        platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
        Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
        oldConfig = process.env.ADHDEV_CONFIG_DIR
        configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-probe-r2-'))
        process.env.ADHDEV_CONFIG_DIR = configDir
        state.currentEntry = path.join(configDir, 'session-host-daemon', 'index.js')
        fs.mkdirSync(path.dirname(state.currentEntry))
        fs.writeFileSync(state.currentEntry, '')
        Object.assign(state, {
            calls: 0, callsAtSpawn: 0, alive: true, replaced: false,
            resourceCode: '', instanceOwner: '', existing: null, budgets: [],
            disconnectCount: 0, birth: 'Sat Oct 24 06:00:00 2026', socketOwners: [54321],
            legacyUnkeyed: false, duplicateKey: false, unreadableCmd: false, unreadableBirth: false,
            healthyDiagnostics: false, runtimeCount: 2, hostStartedAt: 1000,
            delayCallbackMs: 0, connectErrorCode: '',
        })
        state.spawn.mockReset().mockImplementation(() => {
            state.callsAtSpawn = state.calls
            expect(state.alive).toBe(false)
            state.replaced = true
            return { pid: 4242, unref() {}, on() {} }
        })
        vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal: any) => {
            if (signal === 0) {
                if (state.alive) return true
                throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
            }
            state.alive = false
            return true
        }) as any)
    })
    afterEach(() => {
        vi.restoreAllMocks()
        vi.useRealTimers()
        if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
        if (oldConfig === undefined) delete process.env.ADHDEV_CONFIG_DIR
        else process.env.ADHDEV_CONFIG_DIR = oldConfig
        fs.rmSync(configDir, { recursive: true, force: true })
    })
    function managed(overrides: Record<string, unknown> = {}) {
        const host = createManagedSessionHost({
            appName: path.basename(configDir),
            resolveEntryOverride: () => state.currentEntry,
            requiredRequestTypes: ['delete_session'],
            timeoutMs: 15_000,
            isManagedPid: () => true,
            identifiesPid: () => !state.unreadableCmd,
            ...overrides,
        } as any)
        fs.writeFileSync(host.getPidFile(), '54321')
        return host
    }

    it.each([false, true])('never evicts or disconnects a live host with synthetic PTYs across >=3 timeouts, >=2 calls, >=30s span and 28-31s observer starvation (controller=%s)', async (hasController) => {
        vi.useFakeTimers()
        if (hasController) state.existing = new SessionHostClient({ endpoint: { kind: 'unix', path: '/tmp/unused.sock' } })
        const host = managed({ timeoutMs: 15_000 })
        fs.writeFileSync(host.endpoint.path, 'live-socket')
        const initialIno = fs.lstatSync(host.endpoint.path, { bigint: true }).ino
        try {
            // Invocation 1: preflight + ensure probes time out (>=2 connected timeouts recorded in call 1)
            const firstCall = host.ensureReady().then((r) => ({ r }), (e) => ({ e }))
            await vi.advanceTimersByTimeAsync(1_000)
            expect(await firstCall).toMatchObject({ e: { code: 'session_host_unavailable_transient' } })
            expect(state.calls).toBeGreaterThanOrEqual(2)
            expect(state.spawn).not.toHaveBeenCalled()

            // Advance 30s and simulate observer starvation on the preflight callback while budget remains in call 2
            await vi.advanceTimersByTimeAsync(30_000)
            const secondCall = host.ensureReady().then((r) => ({ r }), (e) => ({ e }))
            await vi.advanceTimersByTimeAsync(1_000)
            expect(await secondCall).toMatchObject({ e: { code: 'session_host_unavailable_transient' } })
            expect(state.calls).toBeGreaterThanOrEqual(3)
            expect(state.alive).toBe(true)
            expect(state.disconnectCount).toBe(0)
            expect(state.spawn).not.toHaveBeenCalled()
            expect(process.kill).not.toHaveBeenCalledWith(54321, 'SIGTERM')
            expect(process.kill).not.toHaveBeenCalledWith(54321, 'SIGKILL')
            expect(fs.existsSync(host.endpoint.path)).toBe(true)
            expect(fs.lstatSync(host.endpoint.path, { bigint: true }).ino).toBe(initialIno)
        } finally {
            fs.rmSync(host.endpoint.path, { force: true })
        }
    })

    it('never spawns when a single 30s scheduling stall exhausts the 15s ensure deadline', async () => {
        vi.useFakeTimers()
        state.delayCallbackMs = 30_000
        const host = managed({ timeoutMs: 15_000 })
        fs.writeFileSync(host.endpoint.path, 'live-socket')
        try {
            const p = host.ensureReady().then((r) => ({ r }), (e) => ({ e }))
            await vi.advanceTimersByTimeAsync(65_000)
            const outcome = await p
            expect(outcome).toMatchObject({ e: { code: 'session_host_unavailable_transient' } })
            expect(state.spawn).not.toHaveBeenCalled()
            expect(process.kill).not.toHaveBeenCalledWith(54321, 'SIGTERM')
        } finally {
            fs.rmSync(host.endpoint.path, { force: true })
        }
    })

    it('reuses a healthy unkeyed legacy host without stopping or respawning it', async () => {
        state.legacyUnkeyed = true
        state.healthyDiagnostics = true
        const host = managed({ timeoutMs: 1_000 })
        fs.writeFileSync(host.endpoint.path, 'legacy-socket')
        try {
            await expect(host.ensureReady()).resolves.toEqual(host.endpoint)
            expect(state.spawn).not.toHaveBeenCalled()
            expect(process.kill).not.toHaveBeenCalledWith(54321, 'SIGTERM')
        } finally {
            fs.rmSync(host.endpoint.path, { force: true })
        }
    })

    it('recovers once when the prior same-generation owner is genuinely dead and stale socket inode is unchanged', async () => {
        state.alive = false
        state.connectErrorCode = 'ECONNREFUSED'
        state.socketOwners = []
        const host = managed({ timeoutMs: 1_000 })
        fs.writeFileSync(host.endpoint.path, 'stale-socket')
        try {
            await expect(host.ensureReady()).resolves.toEqual(host.endpoint)
            expect(state.spawn).toHaveBeenCalledTimes(1)
            expect(process.kill).not.toHaveBeenCalledWith(54321, 'SIGTERM')
        } finally {
            fs.rmSync(host.endpoint.path, { force: true })
        }
    })

    it.each(['missing-pidfile', 'corrupt-pidfile', 'unreadable-cmd', 'unreadable-birth', 'foreign-socket-owner'] as const)(
        'refuses replacement with transient error when native ownership is unknown (%s)',
        async (fault) => {
            state.connectErrorCode = 'ECONNREFUSED'
            const host = managed({ timeoutMs: 500 })
            fs.writeFileSync(host.endpoint.path, 'unknown-owner-socket')
            if (fault === 'missing-pidfile') fs.unlinkSync(host.getPidFile())
            if (fault === 'corrupt-pidfile') fs.writeFileSync(host.getPidFile(), 'not-a-pid')
            if (fault === 'unreadable-cmd') state.unreadableCmd = true
            if (fault === 'unreadable-birth') state.unreadableBirth = true
            if (fault === 'foreign-socket-owner') state.socketOwners = [98765]
            try {
                await expect(host.ensureReady()).rejects.toMatchObject({ code: 'session_host_unavailable_transient' })
                expect(state.spawn).not.toHaveBeenCalled()
                expect(process.kill).not.toHaveBeenCalledWith(54321, 'SIGTERM')
                expect(process.kill).not.toHaveBeenCalledWith(54321, 'SIGKILL')
            } finally {
                fs.rmSync(host.endpoint.path, { force: true })
            }
        },
    )

    it('succeeds on explicit authorized idle replacement and escalates to SIGKILL only while PID, instance key, and native birth match', async () => {
        const host = managed({
            evictGraceMs: 0,
            timeoutMs: 1_000,
            replacementAuthority: () => ({
                expectedPid: 54321,
                expectedBirth: state.birth,
                expectedInstanceConfigDir: configDir,
                expectedBootId: 'boot-idle-1',
                expectedEpoch: 3,
                expectedOwner: 'rollout_owner_01',
                activeRuntimeCount: 0,
            }),
        })
        fs.writeFileSync(host.endpoint.path, 'authorized-idle-socket')
        vi.mocked(process.kill).mockImplementation(((_pid: number, signal: any) => {
            if (signal === 0 && !state.alive) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
            if (signal === 'SIGKILL') state.alive = false
            return true
        }) as any)
        try {
            await expect(host.ensureReady()).resolves.toEqual(host.endpoint)
            expect(process.kill).toHaveBeenCalledWith(54321, 'SIGTERM')
            expect(process.kill).toHaveBeenCalledWith(54321, 'SIGKILL')
            expect(state.spawn).toHaveBeenCalledTimes(1)
        } finally {
            fs.rmSync(host.endpoint.path, { force: true })
        }
    })

    it.each(['instance-change', 'birth-change', 'active-pty', 'cancelled-epoch', 'wrong-instance-auth'] as const)(
        'refuses authorized replacement or SIGKILL escalation on %s',
        async (fault) => {
            let cancelled = fault === 'cancelled-epoch'
            const host = managed({
                evictGraceMs: 0,
                timeoutMs: 1_000,
                replacementAuthority: () => ({
                    expectedPid: 54321,
                    expectedBirth: state.birth,
                    expectedInstanceConfigDir: fault === 'wrong-instance-auth' ? path.join(configDir, 'other') : configDir,
                    expectedBootId: 'boot-idle-1',
                    expectedEpoch: 3,
                    expectedOwner: 'rollout_owner_01',
                    activeRuntimeCount: fault === 'active-pty' ? 2 : 0,
                    isCancelled: () => cancelled,
                }),
            })
            fs.writeFileSync(host.endpoint.path, 'fenced-socket')
            vi.mocked(process.kill).mockImplementation(((_pid: number, signal: any) => {
                if (signal === 'SIGTERM') {
                    if (fault === 'instance-change') state.instanceOwner = path.join(configDir, 'stable')
                    if (fault === 'birth-change') state.birth = 'Sat Oct 24 06:05:00 2026'
                }
                return true
            }) as any)
            try {
                await expect(host.ensureReady()).rejects.toMatchObject({ code: 'session_host_unavailable_transient' })
                if (fault === 'active-pty' || fault === 'cancelled-epoch' || fault === 'wrong-instance-auth') {
                    expect(process.kill).not.toHaveBeenCalledWith(54321, 'SIGTERM')
                } else {
                    expect(process.kill).toHaveBeenCalledWith(54321, 'SIGTERM')
                }
                expect(process.kill).not.toHaveBeenCalledWith(54321, 'SIGKILL')
                expect(state.spawn).not.toHaveBeenCalled()
            } finally {
                fs.rmSync(host.endpoint.path, { force: true })
            }
        },
    )

    it.each(['ENFILE', 'EMFILE', 'EAGAIN', 'ENOBUFS'])('preserves a live host on %s during foreign-entry connect', async (code) => {
        state.resourceCode = code
        const host = managed()
        await expect(host.ensureReady()).rejects.toMatchObject({ code: 'session_host_unavailable_transient', causeError: { code } })
        expect(state.alive).toBe(true)
        expect(state.spawn).not.toHaveBeenCalled()
        expect(state.calls).toBe(0)
    })
})
