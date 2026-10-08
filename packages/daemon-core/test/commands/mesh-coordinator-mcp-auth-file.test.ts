/**
 * The coordinator / assistant MCP launch of a standalone daemon names the
 * daemon's per-boot MCP credential FILE (standalone-mcp-auth.ts) — never the
 * token itself, never on a worker launch, never on the IPC (cloud) route.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveAdhdevMcpServerLaunch, resolveWorkerMcpServerLaunch } from '../../src/commands/mesh-coordinator.js'
import { ADHDEV_COORDINATOR_MCP_AUTH_FILE_ENV, ADHDEV_DAEMON_AUTH_FILE_FLAG } from '../../src/standalone-mcp-auth.js'

const AUTH_FILE = '/home/u/.adhdev-standalone/run/standalone-mcp-auth-3847'
const ENTRY = '/opt/adhdev/vendor/mcp-server/index.js'

let previous: string | undefined
beforeEach(() => {
    previous = process.env[ADHDEV_COORDINATOR_MCP_AUTH_FILE_ENV]
    process.env[ADHDEV_COORDINATOR_MCP_AUTH_FILE_ENV] = AUTH_FILE
})
afterEach(() => {
    if (previous === undefined) delete process.env[ADHDEV_COORDINATOR_MCP_AUTH_FILE_ENV]
    else process.env[ADHDEV_COORDINATOR_MCP_AUTH_FILE_ENV] = previous
})

describe('coordinator MCP launch — standalone auth file', () => {
    it('mesh and assistant local launches name the auth file', () => {
        for (const toolset of [{ kind: 'mesh', meshId: 'mesh_x' } as const, { kind: 'assistant' } as const]) {
            const launch = resolveAdhdevMcpServerLaunch({ toolset, adhdevMcpEntryPath: ENTRY, nodeExecutable: '/usr/bin/node', adhdevMcpTransport: 'local', adhdevMcpPort: 3847 })!
            const at = launch.args.indexOf(ADHDEV_DAEMON_AUTH_FILE_FLAG)
            expect(at, launch.args.join(' ')).toBeGreaterThan(0)
            expect(launch.args[at + 1]).toBe(AUTH_FILE)
        }
    })

    it('the IPC route and the `adhdev mcp` wrapper do not get it', () => {
        const ipc = resolveAdhdevMcpServerLaunch({ toolset: { kind: 'mesh', meshId: 'mesh_x' }, adhdevMcpEntryPath: ENTRY, adhdevMcpTransport: 'ipc', adhdevMcpPort: 19223 })!
        expect(ipc.args).not.toContain(ADHDEV_DAEMON_AUTH_FILE_FLAG)
        const wrapper = resolveAdhdevMcpServerLaunch({ toolset: { kind: 'mesh', meshId: 'mesh_x' }, adhdevMcpCommand: 'adhdev', adhdevMcpTransport: 'local', adhdevMcpPort: 3847 })!
        expect(wrapper.args).not.toContain(ADHDEV_DAEMON_AUTH_FILE_FLAG)
    })

    it('a worker launch never gets it', () => {
        const worker = resolveWorkerMcpServerLaunch({ adhdevMcpEntryPath: ENTRY, adhdevMcpTransport: 'local', adhdevMcpPort: 3847 })
        expect(worker.args).not.toContain(ADHDEV_DAEMON_AUTH_FILE_FLAG)
        expect(worker.args.join(' ')).not.toContain(AUTH_FILE)
    })

    it('no daemon auth file → unchanged args', () => {
        delete process.env[ADHDEV_COORDINATOR_MCP_AUTH_FILE_ENV]
        const launch = resolveAdhdevMcpServerLaunch({ toolset: { kind: 'mesh', meshId: 'mesh_x' }, adhdevMcpEntryPath: ENTRY, nodeExecutable: '/usr/bin/node', adhdevMcpTransport: 'local', adhdevMcpPort: 3847 })!
        expect(launch.args).toEqual([ENTRY, '--mode', 'local', '--repo-mesh', 'mesh_x', '--port', '3847'])
    })
})
