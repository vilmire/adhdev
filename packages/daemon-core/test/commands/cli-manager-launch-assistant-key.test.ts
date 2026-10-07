import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// Assistant MCP session id (design 2026-10-07-assistant-layer.md §4.5): launch_assistant
// mints the session id, writes it into the assistant MCP server entry, and passes it to
// launch_cli as `assistantSessionKey`. launch_cli must spawn under THAT id
// (startSession presetSessionKey), or the MCP server would name a session that never exists.

const testTmpDir = path.join(tmpdir(), `adhdev-launch-asst-key-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')

vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-machine' } as any),
  getMachineId: () => 'test-machine',
  getMachineNickname: () => null,
}))

import { DaemonCliManager } from '../../src/commands/cli-manager.js'

const workspaceDir = path.join(testTmpDir, 'assistant')

function createManager() {
  const manager = new DaemonCliManager({
    getServerConn: () => null,
    getP2p: () => null,
    onStatusChange: vi.fn(),
    removeAgentTracking: vi.fn(),
    getInstanceManager: () => ({ getInstance: () => undefined }) as any,
  } as any, {
    resolveAlias: vi.fn((t: string) => t),
    getMeta: vi.fn(() => undefined),
    getResolvedSpecPath: vi.fn(() => null),
  } as any)
  const startSession = vi.fn(async (_t: string, _d: string, _a: unknown, _m: unknown, opts: any) => ({
    runtimeSessionId: opts?.presetSessionKey || 'minted-by-start-session',
  }))
  ;(manager as any).startSession = startSession
  return { manager, startSession }
}

async function launch(manager: DaemonCliManager, extra: Record<string, unknown>) {
  fs.mkdirSync(workspaceDir, { recursive: true })
  return manager.launchCli({ cliType: 'codex-cli', dir: workspaceDir, ...extra }) as Promise<any>
}

afterEach(() => {
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  vi.clearAllMocks()
})

describe('launch_cli assistantSessionKey', () => {
  it('an assistant launch spawns under the caller-minted id', async () => {
    const { manager, startSession } = createManager()
    const id = randomUUID()
    const r = await launch(manager, { settings: { assistant: true }, assistantSessionKey: id })
    expect(r).toMatchObject({ success: true, sessionId: id })
    expect(startSession.mock.calls[0][4]).toMatchObject({ presetSessionKey: id })
  })

  it('ignored for a non-assistant launch', async () => {
    const { manager, startSession } = createManager()
    const r = await launch(manager, { assistantSessionKey: randomUUID() })
    expect(r.sessionId).toBe('minted-by-start-session')
    expect(startSession.mock.calls[0][4].presetSessionKey).toBeUndefined()
  })

  it('refuses an id that is already a live session', async () => {
    const { manager, startSession } = createManager()
    const id = randomUUID()
    ;(manager as any).adapters.set(id, {})
    const r = await launch(manager, { settings: { assistant: true }, assistantSessionKey: id })
    expect(r).toMatchObject({ success: false, code: 'session_id_in_use' })
    expect(startSession).not.toHaveBeenCalled()
  })
})
