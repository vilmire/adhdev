import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
    currentEntry: '', calls: 0, callsAtSpawn: 0, alive: true, replaced: false,
    resourceCode: '', instanceOwner: '', existing: null as any, budgets: [] as number[],
    spawn: vi.fn(),
}))
vi.mock('child_process', () => ({
    execFileSync: vi.fn(() => `node ${state.currentEntry} serve --instance-config-key=${createHash('sha256').update(path.resolve(state.instanceOwner || process.env.ADHDEV_CONFIG_DIR!)).digest('hex')}`),
    spawn: (...args: any[]) => state.spawn(...args),
}))
vi.mock('@adhdev/session-host-core', async (original) => {
    const actual = await original<typeof import('@adhdev/session-host-core')>()
    class Client {
        static findConnectedClient() { return state.existing }
        static disconnectClients() { state.existing = null }
        isConnected() { return true }
        async connect() {
            if (state.resourceCode) throw Object.assign(new Error(state.resourceCode), { code: state.resourceCode })
        }
        async request(_request: unknown, options?: { timeoutMs: number }) {
            state.calls++
            state.budgets.push(options?.timeoutMs ?? 30_000)
            if (!state.replaced) {
                state.existing = null // mirrors request() dropping its timed-out socket
                throw new Error('Session host request timed out after 3s (get_host_diagnostics)')
            }
            return { success: true, result: { hostEntryPath: state.currentEntry, hostStartedAt: 2, supportedRequestTypes: ['delete_session'] } }
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
        Object.assign(state, { calls: 0, callsAtSpawn: 0, alive: true, replaced: false, resourceCode: '', instanceOwner: '', existing: null, budgets: [] })
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
        if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
        if (oldConfig === undefined) delete process.env.ADHDEV_CONFIG_DIR
        else process.env.ADHDEV_CONFIG_DIR = oldConfig
        fs.rmSync(configDir, { recursive: true, force: true })
    })
    function managed() {
        const host = createManagedSessionHost({ appName: path.basename(configDir),
            resolveEntryOverride: () => state.currentEntry, requiredRequestTypes: ['delete_session'],
            timeoutMs: 1000, isManagedPid: () => true, identifiesPid: () => true })
        fs.writeFileSync(host.getPidFile(), '54321')
        return host
    }
    it.each([false, true])('requires >=30s and multiple ensure calls before replacing, controller=%s', async (hasController) => {
        if (hasController) state.existing = new SessionHostClient({ endpoint: { kind: 'unix', path: '/tmp/unused.sock' } })
        const host = managed()
        fs.writeFileSync(host.endpoint.path, '')
        const start = Date.now()
        const now = vi.spyOn(Date, 'now').mockReturnValue(start)
        try {
            await expect(host.ensureReady()).rejects.toMatchObject({ code: 'session_host_unavailable_transient' })
            expect(state.spawn).not.toHaveBeenCalled()
            now.mockReturnValue(start + 10_000)
            await expect(host.ensureReady()).rejects.toMatchObject({ code: 'session_host_unavailable_transient' })
            expect(state.spawn).not.toHaveBeenCalled()
            now.mockReturnValue(start + 30_000)
            await expect(host.ensureReady()).resolves.toEqual(host.endpoint)
            expect(state.spawn).toHaveBeenCalledTimes(1)
            expect(state.budgets.every(ms => ms > 0 && ms <= 1000)).toBe(true)
        } finally { fs.rmSync(host.endpoint.path, { force: true }) }
    })

    it('escalates to SIGKILL only while the wedged PID still proves this instance', async () => {
        const host = managed()
        fs.writeFileSync(host.endpoint.path, '')
        const start = Date.now()
        const now = vi.spyOn(Date, 'now').mockReturnValue(start)
        try {
            await expect(host.ensureReady()).rejects.toMatchObject({ code: 'session_host_unavailable_transient' })
            now.mockReturnValue(start + 30_000)
            vi.mocked(process.kill).mockImplementation(((pid: number, signal: any) => {
                if (signal === 0 && !state.alive) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
                if (signal === 'SIGKILL') state.alive = false
                return true
            }) as any)
            // No grace wait is needed for this signal-verification regression.
            const escalator = createManagedSessionHost({ appName: host.appName, requiredRequestTypes: ['delete_session'],
                resolveEntryOverride: () => state.currentEntry, isManagedPid: () => true, evictGraceMs: 0, timeoutMs: 1000 })
            await expect(escalator.ensureReady()).resolves.toEqual(host.endpoint)
            expect(process.kill).toHaveBeenCalledWith(54321, 'SIGTERM')
            expect(process.kill).toHaveBeenCalledWith(54321, 'SIGKILL')
        } finally { fs.rmSync(host.endpoint.path, { force: true }) }
    })
    it('refuses SIGKILL if the PID identity changes after SIGTERM', async () => {
        const host = managed()
        fs.writeFileSync(host.endpoint.path, '')
        const start = Date.now()
        const now = vi.spyOn(Date, 'now').mockReturnValue(start)
        try {
            await expect(host.ensureReady()).rejects.toMatchObject({ code: 'session_host_unavailable_transient' })
            now.mockReturnValue(start + 30_000)
            vi.mocked(process.kill).mockImplementation(((_pid: number, signal: any) => {
                if (signal === 'SIGTERM') state.instanceOwner = path.join(configDir, 'stable')
                return true // reused PID remains alive, now owned by the other instance
            }) as any)
            await expect(host.ensureReady()).rejects.toMatchObject({ code: 'session_host_unavailable_transient' })
            expect(process.kill).toHaveBeenCalledWith(54321, 'SIGTERM')
            expect(process.kill).not.toHaveBeenCalledWith(54321, 'SIGKILL')
            expect(state.spawn).not.toHaveBeenCalled()
        } finally { fs.rmSync(host.endpoint.path, { force: true }) }
    })

    it.each(['ENFILE', 'EMFILE', 'EAGAIN', 'ENOBUFS'])('preserves a live host on %s during foreign-entry connect', async (code) => {
        state.resourceCode = code
        const host = managed()
        await expect(host.ensureReady()).rejects.toMatchObject({ code: 'session_host_unavailable_transient', causeError: { code } })
        expect(state.alive).toBe(true)
        expect(state.spawn).not.toHaveBeenCalled()
        expect(state.calls).toBe(0)
    })
})
