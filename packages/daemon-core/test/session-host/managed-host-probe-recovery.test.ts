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
    disconnectCount: 0, birth: 'Sat Oct 24 06:00:00 2026', socketOwners: [54321] as number[] | null,
    legacyUnkeyed: false, duplicateKey: false, unreadableCmd: false, unreadableBirth: false,
    healthyDiagnostics: false, runtimeCount: 2, hostStartedAt: 1000,
    delayCallbackMs: 0, connectErrorCode: '',
    spawn: vi.fn(), diagHook: null as (() => Promise<void>) | null, childDone: null as Promise<void> | null, prelisten: vi.fn(),
}))
vi.mock('child_process', () => ({
    execFileSync: vi.fn((file: string, args?: readonly string[]) => {
        if (Array.isArray(args) && args.includes('lstart=')) {
            if (state.unreadableBirth || !state.alive) throw new Error('ps birth unavailable')
            return `${state.birth}\n`
        }
        if (String(file).endsWith('lsof')) {
            if (state.socketOwners === null) {
                throw Object.assign(new Error('lsof timed out under CPU starvation'), { code: 'ETIMEDOUT' })
            }
            if (!state.alive || state.socketOwners.length === 0) {
                throw Object.assign(new Error('no socket owner'), { status: 1, stdout: '' })
            }
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
vi.mock('net', async (original) => ({ ...await original<any>(), createServer: () => {
    state.prelisten()
    throw new Error('fixture_prelisten_boundary')
} }))
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
        constructor(public options?: any) {}
        async request(request: any, options?: { timeoutMs: number }) {
            if (request?.type === 'get_upgrade_lease') {
                return {
                    success: true,
                    result: {
                        bootId: 'boot-idle-1',
                        pid: 54321,
                        endpoint: this.options?.endpoint?.path ?? '',
                        epoch: 4,
                        held: false,
                        owner: null,
                    },
                }
            }
            if (request?.type === 'acquire_upgrade_lease') {
                if (state.runtimeCount !== 0) {
                    return { success: false, error: 'native_host_upgrade_busy' }
                }
                const endpointPath = this.options?.endpoint?.path ?? ''
                const cfgDir = process.env.ADHDEV_CONFIG_DIR
                if (cfgDir) {
                    const leaseDir = path.join(cfgDir, 'session-host')
                    fs.mkdirSync(leaseDir, { recursive: true, mode: 0o700 })
                    fs.writeFileSync(
                        path.join(leaseDir, 'upgrade-lease.json'),
                        JSON.stringify({
                            schema: 1,
                            bootId: 'boot-idle-1',
                            pid: 54321,
                            endpoint: endpointPath,
                            epoch: 4,
                            held: true,
                            owner: request.payload.owner,
                            tokenHash: createHash('sha256').update(String(request.payload.token ?? '')).digest('hex'),
                            acquiredAt: Date.now(),
                            expiresAt: Date.now() + 15_000,
                        }),
                        { mode: 0o600 },
                    )
                }
                return {
                    success: true,
                    result: {
                        bootId: 'boot-idle-1',
                        pid: 54321,
                        endpoint: endpointPath,
                        epoch: 4,
                        held: true,
                        owner: request.payload.owner,
                    },
                }
            }
            state.calls++
            await state.diagHook?.()
            const budget = options?.timeoutMs ?? 30_000
            state.budgets.push(budget)
            if (state.replaced) await state.childDone
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
import {
    SessionHostServer,
} from '../../../session-host-daemon/src/server.js'

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
            delayCallbackMs: 0, connectErrorCode: '', childDone: null, diagHook: null,
        })
        state.prelisten.mockReset()
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

    it.each(['posix-prefix', 'windows-argv', 'windows-prebuild'] as const)('R4 refuses automatic %s takeover without stopping the existing host', async (fault) => {
        state.healthyDiagnostics = true
        const currentEntry = state.currentEntry
        if (fault !== 'posix-prefix') Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
        if (fault === 'windows-prebuild') {
            state.currentEntry = path.join(configDir, 'active', 'node_modules', 'adhdev', 'vendor', 'session-host-daemon', 'index.js')
        } else {
            state.currentEntry = path.join(configDir, 'removed', 'session-host-daemon', 'index.js')
        }
        const host = managed({ resolveEntryOverride: () => fault === 'windows-prebuild' ? state.currentEntry : currentEntry, timeoutMs: 500 })
        fs.writeFileSync(host.endpoint.path, 'retained endpoint')
        try {
            await expect(host.ensureReady()).rejects.toThrow()
            expect(state.alive).toBe(true)
            expect(state.spawn).not.toHaveBeenCalled()
            expect(state.disconnectCount).toBe(0)
            expect(process.kill).not.toHaveBeenCalledWith(54321, 'SIGTERM')
            expect(process.kill).not.toHaveBeenCalledWith(54321, 'SIGKILL')
            expect(fs.readFileSync(host.getPidFile(), 'utf8')).toBe('54321')
        } finally { fs.rmSync(host.endpoint.path, { force: true }) }
    })

    it('R4 retains the verified dead pidfile for independent child stale endpoint validation', async () => {
        state.alive = false
        state.socketOwners = []
        state.connectErrorCode = 'ECONNREFUSED'
        const host = managed({ timeoutMs: 1000 })
        fs.writeFileSync(host.endpoint.path, 'stale endpoint')
        state.spawn.mockImplementationOnce(() => {
            expect(fs.readFileSync(host.getPidFile(), 'utf8')).toBe('54321')
            const child = new SessionHostServer({
                endpoint: host.endpoint, instanceConfigDir: configDir,
                storageRootDir: path.join(configDir, 'child-storage'), pidFilePath: host.getPidFile(),
                isPidAlive: () => false, getOwnerBirth: () => null, getSocketOwnerPids: () => [],
            })
            state.childDone = child.start().then(() => { throw new Error('unexpected listener') }, error => {
                expect(error.message).toBe('fixture_prelisten_boundary')
                expect(fs.existsSync(host.endpoint.path)).toBe(false)
            })
            state.replaced = true
            return { pid: 4242, unref() {}, on() {} }
        })
        try {
            await expect(host.ensureReady()).resolves.toEqual(host.endpoint)
            expect(state.spawn).toHaveBeenCalledTimes(1)
            expect(state.prelisten).toHaveBeenCalledTimes(1)
        } finally { fs.rmSync(host.endpoint.path, { force: true }) }
    })

    it.each(['cold', 'dead-no-socket', 'no-pid-socket', 'null-owner', 'foreign-owner', 'pid-change', 'birth-change', 'inode-change', 'config-change', 'cancel-after-read', 'undefined-callback'] as const)(
        'R4 child prelisten validates %s with all native and listener effects mocked', async (fault) => {
        const endpoint = { kind: 'unix' as const, path: path.join(configDir, 'owned-child.sock') }
        const pidFilePath = path.join(configDir, 'owned-child.pid')
        if (fault !== 'cold' && fault !== 'no-pid-socket') fs.writeFileSync(pidFilePath, '54321')
        if (fault !== 'cold' && fault !== 'dead-no-socket') fs.writeFileSync(endpoint.path, 'old endpoint')
        let ownerReads = 0, birthReads = 0, cancelled = false
        const child = new SessionHostServer({
            endpoint, instanceConfigDir: configDir, pidFilePath,
            storageRootDir: path.join(configDir, 'owned-child-storage'), isPidAlive: () => false,
            getOwnerBirth: () => fault === 'birth-change' && ++birthReads > 1 ? 'new-birth' : null,
            getSocketOwnerPids: () => {
                if (++ownerReads === 2) {
                    if (fault === 'pid-change') fs.writeFileSync(pidFilePath, '98765')
                    if (fault === 'inode-change') { fs.renameSync(endpoint.path, endpoint.path + '.old'); fs.writeFileSync(endpoint.path, 'peer endpoint') }
                    if (fault === 'config-change') fs.chmodSync(configDir, 0o700)
                    if (fault === 'cancel-after-read') cancelled = true
                }
                return fault === 'null-owner' ? null : fault === 'foreign-owner' ? [98765] : []
            },
            isCancelled: () => cancelled,
            ...(fault === 'undefined-callback' ? { replacementProvenance: () => undefined } : {}),
        })
        if (fault === 'cold' || fault === 'dead-no-socket') {
            await expect(child.start()).rejects.toThrow('fixture_prelisten_boundary')
            expect(state.prelisten).toHaveBeenCalledTimes(1)
        } else {
            // mkdtemp starts at 0700, so stage a distinct initial mode for the mode race.
            if (fault === 'config-change') fs.chmodSync(configDir, 0o750)
            await expect(child.start()).rejects.toThrow()
            expect(state.prelisten).not.toHaveBeenCalled()
            expect(fs.existsSync(endpoint.path)).toBe(true)
        }
        expect(state.spawn).not.toHaveBeenCalled()
        expect(process.kill).not.toHaveBeenCalledWith(54321, 'SIGTERM')
        expect(process.kill).not.toHaveBeenCalledWith(54321, 'SIGKILL')
    })

    it('R4 cancellation during dead-owner native reads refuses before disconnect or spawn', async () => {
        state.alive = false
        state.socketOwners = []
        state.connectErrorCode = 'ECONNREFUSED'
        let reads = 0, cancelled = false
        const host = managed({ timeoutMs: 1000,
            getProcessBirth: () => { if (++reads >= 3) cancelled = true; return null },
            replacementAuthority: { isCancelled: () => cancelled } as any,
        })
        fs.writeFileSync(host.endpoint.path, 'dead endpoint')
        try {
            await expect(host.ensureReady()).rejects.toMatchObject({ code: 'session_host_unavailable_transient' })
            expect(cancelled).toBe(true)
            expect(state.disconnectCount).toBe(0)
            expect(state.spawn).not.toHaveBeenCalled()
        } finally { fs.rmSync(host.endpoint.path, { force: true }) }
    })

    it.each(['pid-change', 'config-change', 'endpoint-change', 'prebuild-removed'] as const)('R4 fences %s during the in-flight prefix probe before automatic effects', async (fault) => {
        state.healthyDiagnostics = true
        let prebuild = ''
        if (fault === 'prebuild-removed') {
            Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
            const prefix = path.join(configDir, 'active')
            state.currentEntry = path.join(prefix, 'node_modules', 'adhdev', 'vendor', 'session-host-daemon', 'index.js')
            prebuild = path.join(prefix, 'node_modules', 'adhdev', 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node')
            fs.mkdirSync(path.dirname(prebuild), { recursive: true }); fs.writeFileSync(prebuild, 'owned prebuild')
        }
        const host = managed({ timeoutMs: 1000 })
        const endpoint = host.endpoint.path
        fs.writeFileSync(endpoint, 'retained endpoint')
        let release!: () => void
        const paused = new Promise<void>(resolve => { release = resolve })
        state.diagHook = async () => { state.diagHook = null; await paused }
        const result = host.ensureReady().then(value => ({ value }), error => ({ error }))
        await new Promise(resolve => setImmediate(resolve))
        if (fault === 'pid-change') fs.writeFileSync(host.getPidFile(), '98765')
        if (fault === 'config-change') { const other = path.join(configDir, 'other'); fs.mkdirSync(other); process.env.ADHDEV_CONFIG_DIR = other }
        if (fault === 'endpoint-change') { fs.renameSync(endpoint, endpoint + '.old'); fs.writeFileSync(endpoint, 'peer endpoint') }
        if (fault === 'prebuild-removed') fs.unlinkSync(prebuild)
        release()
        try {
            expect(await result).toHaveProperty('error')
            expect(state.spawn).not.toHaveBeenCalled()
            expect(state.disconnectCount).toBe(0)
            expect(process.kill).not.toHaveBeenCalledWith(54321, 'SIGTERM')
            expect(fs.existsSync(endpoint)).toBe(true)
        } finally { fs.rmSync(endpoint, { force: true }); fs.rmSync(endpoint + '.old', { force: true }) }
    })

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

    it('refuses unsupported automatic live replacement even with complete count-zero authority', async () => {
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
            await expect(host.ensureReady()).rejects.toMatchObject({ code: 'session_host_unavailable_transient' })
            expect(process.kill).not.toHaveBeenCalledWith(54321, 'SIGTERM')
            expect(process.kill).not.toHaveBeenCalledWith(54321, 'SIGKILL')
            expect(state.spawn).not.toHaveBeenCalled()
            expect(state.disconnectCount).toBe(0)
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
                expect(process.kill).not.toHaveBeenCalledWith(54321, 'SIGTERM')
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

    it('cloud extraStop must not turn missing pidfile plus live socket into kill authority', async () => {
        const host = managed({
            timeoutMs: 500,
            extraStop: () => {
                host.killPid(54321)
            },
        })
        fs.writeFileSync(host.endpoint.path, 'live-socket-missing-pidfile')
        fs.unlinkSync(host.getPidFile())
        try {
            await expect(host.ensureReady()).rejects.toMatchObject({ code: 'session_host_unavailable_transient' })
            expect(process.kill).not.toHaveBeenCalledWith(54321, 'SIGTERM')
            expect(state.spawn).not.toHaveBeenCalled()
            expect(state.disconnectCount).toBe(0)
        } finally {
            fs.rmSync(host.endpoint.path, { force: true })
        }
    })

    it('caller count alone is not authenticated idle-generation authority', async () => {
        const host = managed({
            timeoutMs: 500,
            replacementAuthority: () => ({ activeRuntimeCount: 0 } as any),
        })
        fs.writeFileSync(host.endpoint.path, 'live-socket-unverified-count')
        try {
            await expect(host.ensureReady()).rejects.toMatchObject({ code: 'session_host_unavailable_transient' })
            expect(process.kill).not.toHaveBeenCalledWith(54321, 'SIGTERM')
            expect(state.spawn).not.toHaveBeenCalled()
        } finally {
            fs.rmSync(host.endpoint.path, { force: true })
        }
    })

    it('cancellation occurring during blocking native birth query before SIGTERM aborts before sending SIGTERM', async () => {
        let cancelled = false
        let birthChecks = 0
        const host = managed({
            evictGraceMs: 0,
            timeoutMs: 1_000,
            getProcessBirth: () => {
                birthChecks += 1
                if (birthChecks >= 3) {
                    cancelled = true
                }
                return state.birth
            },
            replacementAuthority: () => ({
                expectedPid: 54321,
                expectedBirth: state.birth,
                expectedInstanceConfigDir: configDir,
                expectedBootId: 'boot-idle-1',
                expectedEpoch: 3,
                expectedOwner: 'rollout_owner_01',
                activeRuntimeCount: 0,
                isCancelled: () => cancelled,
            }),
        })
        fs.writeFileSync(host.endpoint.path, 'cancel-before-term-socket')
        try {
            await expect(host.ensureReady()).rejects.toMatchObject({ code: 'session_host_unavailable_transient' })
            expect(process.kill).not.toHaveBeenCalledWith(54321, 'SIGTERM')
            expect(process.kill).not.toHaveBeenCalledWith(54321, 'SIGKILL')
            expect(state.spawn).not.toHaveBeenCalled()
        } finally {
            fs.rmSync(host.endpoint.path, { force: true })
        }
    })

    it('rejects unsupported automatic lease authority before any native RPC acquisition', async () => {
        const host = managed({ timeoutMs: 1000 })
        const request = vi.spyOn(SessionHostClient.prototype, 'request')
        await expect(host.acquireIdleReplacementAuthority({
            owner: 'fixture_owner', token: 'a'.repeat(64),
        })).rejects.toThrow('session_host_automatic_live_replacement_unsupported')
        expect(request).not.toHaveBeenCalled()
        expect(state.spawn).not.toHaveBeenCalled()
        expect(state.disconnectCount).toBe(0)
    })

    it('treats getSocketOwnerPids() === null (unknown owner) as fail-closed unknown for both dead-pidfile and live replacement paths', async () => {
        // 1. Dead pidfile PID + existing socket + getSocketOwnerPids() === null -> refuses disconnect, unlink, and spawn
        state.alive = false
        state.socketOwners = null
        const deadPidHost = managed({ timeoutMs: 500, getSocketOwnerPids: () => null })
        fs.writeFileSync(deadPidHost.endpoint.path, 'live-socket-with-unknown-owner')
        try {
            await expect(deadPidHost.ensureReady()).rejects.toMatchObject({
                code: 'session_host_unavailable_transient',
            })
            expect(state.disconnectCount).toBe(0)
            expect(fs.existsSync(deadPidHost.getPidFile())).toBe(true)
            expect(state.spawn).not.toHaveBeenCalled()

            // 2. Live pidfile PID + replacement authority + getSocketOwnerPids() === null -> refuses SIGTERM and spawn
            state.alive = true
            state.socketOwners = null
            vi.mocked(process.kill).mockClear()
            const livePidHost = managed({
                evictGraceMs: 0,
                timeoutMs: 500,
                getSocketOwnerPids: () => null,
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
            await expect(livePidHost.ensureReady()).rejects.toMatchObject({
                code: 'session_host_unavailable_transient',
            })
            expect(process.kill).not.toHaveBeenCalledWith(54321, 'SIGTERM')
            expect(state.spawn).not.toHaveBeenCalled()
        } finally {
            fs.rmSync(deadPidHost.endpoint.path, { force: true })
        }
    })
})
