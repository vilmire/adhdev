import { describe, expect, it, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// LAUNCH-ACCOUNTING (P4, 2026-09-08 runaway follow-up): every mesh WORKER spawn must land
// a `session_launched` audit entry, written by the launch_cli funnel in cli-manager on the
// daemon that actually spawned the session. Before this, only the mesh_launch_session MCP
// tool recorded one — the queue auto-launch and recovery-relaunch paths left only
// write-only `session_auto_launch` telemetry, so a 60-session spawn runaway was invisible
// to ledger accounting (lifetime total read 75). The funnel keys on `settings.meshNodeFor`
// (worker envelope); a `source` payload discriminator labels the initiating path.

const testTmpDir = path.join(tmpdir(), `adhdev-launch-ledger-test-${randomUUID().slice(0, 8)}`)
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
import { readLedgerEntries } from '../../src/mesh/mesh-ledger.js'
import { __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js'

// A real workspace dir so resolveLaunchDirectory's existence validation passes.
const workspaceDir = path.join(testTmpDir, 'repo')

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
  // The funnel runs AFTER a successful spawn; stub the spawn itself so the test
  // exercises only the accounting path (no PTY/process).
  ;(manager as any).startSession = vi.fn(async () => ({
    runtimeSessionId: 'sess-spawned-1',
    providerSessionId: 'prov-abc',
  }))
  return manager
}

async function launch(manager: DaemonCliManager, settings: Record<string, unknown> | undefined) {
  fs.mkdirSync(workspaceDir, { recursive: true })
  return manager.handleCliCommand('launch_cli', {
    cliType: 'codex-cli',
    dir: workspaceDir,
    ...(settings ? { settings } : {}),
  })
}

function sessionLaunchedEntries(meshId: string) {
  return readLedgerEntries(meshId, { tail: 50 }).filter(e => e.kind === 'session_launched')
}

afterEach(() => {
  __resetMeshRuntimeStoreForTests()
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  vi.clearAllMocks()
})

describe('LAUNCH-ACCOUNTING — launch_cli session_launched funnel', () => {
  it('auto-launch envelope (meshNodeFor + autoLaunchedForQueueTaskId) records exactly one session_launched with source auto_launch', async () => {
    const meshId = `mesh_ll_auto_${randomUUID().slice(0, 8)}`
    const manager = createManager()

    const result: any = await launch(manager, {
      role: 'worker',
      meshNodeFor: meshId,
      meshNodeId: 'node_alpha',
      autoLaunchedForQueueTaskId: 'task-42',
    })

    expect(result.success).toBe(true)
    expect(result.ledgerLaunchRecorded).toBe(true)
    const entries = sessionLaunchedEntries(meshId)
    expect(entries).toHaveLength(1) // exactly one — the funnel is the single writer
    expect(entries[0].nodeId).toBe('node_alpha')
    expect(entries[0].sessionId).toBe('sess-spawned-1')
    expect(entries[0].providerType).toBe('codex-cli')
    expect(entries[0].taskId).toBe('task-42')
    expect(entries[0].payload?.source).toBe('auto_launch')
    expect(entries[0].payload?.providerSessionId).toBe('prov-abc')
  })

  it('mesh_launch_session envelope (meshLaunchSource) records its declared source', async () => {
    const meshId = `mesh_ll_mcp_${randomUUID().slice(0, 8)}`
    const manager = createManager()

    const result: any = await launch(manager, {
      role: 'worker',
      meshNodeFor: meshId,
      meshNodeId: 'node_alpha',
      meshLaunchSource: 'mesh_launch_session',
    })

    expect(result.ledgerLaunchRecorded).toBe(true)
    const entries = sessionLaunchedEntries(meshId)
    expect(entries).toHaveLength(1)
    expect(entries[0].payload?.source).toBe('mesh_launch_session')
  })

  it('recovery relaunch envelope records source recovery_relaunch', async () => {
    const meshId = `mesh_ll_rec_${randomUUID().slice(0, 8)}`
    const manager = createManager()

    await launch(manager, {
      role: 'worker',
      meshNodeFor: meshId,
      meshNodeId: 'node_alpha',
      meshLaunchSource: 'recovery_relaunch',
    })

    const entries = sessionLaunchedEntries(meshId)
    expect(entries).toHaveLength(1)
    expect(entries[0].payload?.source).toBe('recovery_relaunch')
  })

  it('legacy mesh envelope with neither meshLaunchSource nor a task marker is labeled unlabeled_delegated_launch', async () => {
    const meshId = `mesh_ll_legacy_${randomUUID().slice(0, 8)}`
    const manager = createManager()

    await launch(manager, { role: 'worker', meshNodeFor: meshId, meshNodeId: 'node_alpha' })

    const entries = sessionLaunchedEntries(meshId)
    expect(entries).toHaveLength(1)
    expect(entries[0].payload?.source).toBe('unlabeled_delegated_launch')
  })

  it('control: a non-mesh launch (no meshNodeFor) records NOTHING and sets no flag', async () => {
    const meshId = `mesh_ll_none_${randomUUID().slice(0, 8)}`
    const manager = createManager()

    const result: any = await launch(manager, undefined)

    expect(result.success).toBe(true)
    expect(result.ledgerLaunchRecorded).toBeUndefined()
    expect(sessionLaunchedEntries(meshId)).toHaveLength(0)
  })

  it('control: a coordinator launch (meshCoordinatorFor, no meshNodeFor) records nothing', async () => {
    const meshId = `mesh_ll_coord_${randomUUID().slice(0, 8)}`
    const manager = createManager()

    const result: any = await launch(manager, { meshCoordinatorFor: meshId })

    expect(result.success).toBe(true)
    expect(result.ledgerLaunchRecorded).toBeUndefined()
    expect(sessionLaunchedEntries(meshId)).toHaveLength(0)
  })
})
