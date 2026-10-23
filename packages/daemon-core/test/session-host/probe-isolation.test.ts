import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { SessionHostClient } from '@adhdev/session-host-core'
import { ensureSessionHostReady, listHostedCliRuntimes } from '../../src/session-host/runtime-support.js'
import { createManagedSessionHost } from '../../src/session-host/managed-host.js'
import { resetProcessInstanceContextForTests } from '../../src/config/instance-context.js'

it.each(['readiness', 'foreign-entry preflight', 'before controller connects'])('%s probe timeout preserves a concurrent 30s list_sessions', async (probe) => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-isolation-'))
    const oldConfig = process.env.ADHDEV_CONFIG_DIR
    process.env.ADHDEV_CONFIG_DIR = configDir
    resetProcessInstanceContextForTests()
    const host = createManagedSessionHost({ appName: `probe-${process.pid}`, requiredRequestTypes: [], timeoutMs: 60 })
    const endpoint = host.endpoint
    const sockets = new Set<net.Socket>()
    let replyToList!: () => void
    let listReceived!: () => void
    const received = new Promise<void>(resolve => { listReceived = resolve })
    let diagnosticReceived!: () => void
    const probing = new Promise<void>(resolve => { diagnosticReceived = resolve })
    const server = net.createServer(socket => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
        let buffer = ''
        socket.on('data', chunk => {
            buffer += chunk.toString()
            let newline: number
            while ((newline = buffer.indexOf('\n')) >= 0) {
                const envelope = JSON.parse(buffer.slice(0, newline))
                buffer = buffer.slice(newline + 1)
                if (envelope.request.type === 'list_sessions') {
                    replyToList = () => socket.write(JSON.stringify({ kind: 'response', requestId: envelope.requestId,
                        response: { success: true, result: [] } }) + '\n')
                    listReceived()
                }
                if (envelope.request.type === 'get_host_diagnostics') diagnosticReceived()
                // Deliberately leave diagnostics unanswered while the list is in flight.
            }
        })
    })
    const shared = new SessionHostClient({ endpoint, requestTimeoutMs: 30_000 })
    try {
        await new Promise<void>(resolve => server.listen(endpoint.path, resolve))
        if (probe !== 'before controller connects') await shared.connect()
        const spawnHost = vi.fn()
        const ensure = probe !== 'foreign-entry preflight'
            ? ensureSessionHostReady({ endpoint, existingClient: shared, spawnHost, isExistingHostAlive: () => true,
                isExistingSocketPresent: () => true, canConnectRetries: 0, timeoutMs: 60 })
            : host.ensureReady()
        const ensureChecked = expect(ensure).rejects.toMatchObject({ code: 'session_host_unavailable_transient' })
        await probing
        if (probe === 'before controller connects') expect(SessionHostClient.findConnectedClient(endpoint)).toBeNull()
        const list = probe === 'before controller connects' ? listHostedCliRuntimes(endpoint)
            : shared.request({ type: 'list_sessions', payload: {} })
        const listChecked = expect(list).resolves.toEqual(probe === 'before controller connects' ? [] : { success: true, result: [] })
        await received
        await ensureChecked
        if (probe !== 'before controller connects') expect(shared.isConnected()).toBe(true)
        replyToList()
        await listChecked
        expect(spawnHost).not.toHaveBeenCalled()
    } finally {
        await shared.close()
        for (const socket of sockets) socket.destroy()
        await new Promise<void>(resolve => server.close(() => resolve()))
        if (oldConfig === undefined) delete process.env.ADHDEV_CONFIG_DIR
        else process.env.ADHDEV_CONFIG_DIR = oldConfig
        resetProcessInstanceContextForTests()
        fs.rmSync(configDir, { recursive: true, force: true })
    }
})
