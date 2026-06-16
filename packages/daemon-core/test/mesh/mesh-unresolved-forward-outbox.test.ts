import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'

// Isolate all file I/O (MeshRuntimeStore SQLite, ledger JSONL) to a per-run temp dir.
const testTmpDir = path.join(tmpdir(), `adhdev-unresolved-fwd-test-${randomUUID().slice(0, 8)}`)
const testConfigDir = path.join(testTmpDir, '.adhdev')
vi.mock('../../src/config/config.js', () => ({
  getConfigDir: () => {
    if (!fs.existsSync(testConfigDir)) fs.mkdirSync(testConfigDir, { recursive: true })
    return testConfigDir
  },
  loadConfig: () => ({ machineId: 'test-worker-machine' }),
}))

vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: vi.fn(() => undefined),
  getMeshByRepo: vi.fn(() => undefined),
  listMeshes: vi.fn(() => [] as any[]),
}))

vi.mock('../../src/detection/cli-detector.js', () => ({ detectCLI: vi.fn() }))
vi.mock('../../src/mesh/mesh-fast-forward.js', () => ({ fastForwardMeshNode: vi.fn() }))

import { runMeshReconcileTick, setupMeshEventForwarding } from '../../src/mesh/mesh-events.js'
import { __resetMeshRuntimeStoreForTests } from '../../src/mesh/mesh-work-queue.js'
import {
  peekUnresolvedDelegateForwards,
  __clearUnresolvedDelegateForwardOutboxForTests,
} from '../../src/mesh/mesh-unresolved-forward-outbox.js'
import { __resetMeshWorkspaceCacheForTests } from '../../src/mesh/mesh-events.js'

// A worker that is NOT a member of the coordinator's mesh: meshNodeFor absent, no
// workspace→mesh resolution, but it carries the coordinator daemon anchor. Its
// completion routes through forwardUnresolvedDelegateEvent → durable outbox.
function createUnresolvedWorker() {
  let listener: ((event: any) => void) | undefined
  const sourceState = {
    instanceId: 'worker-session-1',
    workspace: '/repo/worktree-worker',
    settings: {
      meshCoordinatorDaemonId: 'daemon_remote_coordinator',
      meshNodeId: 'node_worker',
      launchedByCoordinator: true,
    },
  }
  const source = { category: 'cli', getState: vi.fn(() => sourceState) }
  const instanceManager = {
    onEvent: vi.fn((cb: (event: any) => void) => { listener = cb }),
    getInstance: vi.fn((id: string) => (id === 'worker-session-1' ? source : undefined)),
    getByCategory: vi.fn((category: string) => (category === 'cli' ? [source] : [])),
  }
  return {
    components: { instanceManager } as any,
    emit: (event: any) => {
      if (!listener) throw new Error('listener not registered')
      listener(event)
    },
  }
}

const COMPLETION = {
  event: 'agent:generating_completed',
  instanceId: 'worker-session-1',
  targetSessionId: 'worker-session-1',
  providerType: 'claude-cli',
  providerSessionId: 'claude-history-1',
  finalSummary: 'remote task done',
  timestamp: 4242,
}

beforeEach(() => {
  __resetMeshRuntimeStoreForTests()
  __resetMeshWorkspaceCacheForTests()
  __clearUnresolvedDelegateForwardOutboxForTests()
})

describe('unresolved-delegate durable forward', () => {
  it('(a) keeps the event queued for retry when the immediate push fails', async () => {
    const { components, emit } = createUnresolvedWorker()
    // Immediate push rejects (coordinator momentarily unreachable).
    const dispatchMeshCommand = vi.fn(async () => { throw new Error('p2p unreachable') })
    components.dispatchMeshCommand = dispatchMeshCommand

    setupMeshEventForwarding(components)
    emit(COMPLETION)

    // The immediate push was attempted once …
    expect(dispatchMeshCommand).toHaveBeenCalledTimes(1)
    // … and because it failed, the durable copy is still in the outbox (not acked).
    await Promise.resolve() // let the immediate-push .catch settle
    const queued = peekUnresolvedDelegateForwards()
    expect(queued).toHaveLength(1)
    expect(queued[0].coordinatorDaemonId).toBe('daemon_remote_coordinator')
    expect(queued[0].payload.event).toBe('agent:generating_completed')

    // Next reconcile tick retries the push. This time it succeeds.
    dispatchMeshCommand.mockReset()
    dispatchMeshCommand.mockImplementation(async () => ({ success: true }))
    await runMeshReconcileTick(components)

    // Retried exactly the queued entry, then acked it (drained) so it won't resend.
    expect(dispatchMeshCommand).toHaveBeenCalledTimes(1)
    const [target, command, payload] = dispatchMeshCommand.mock.calls[0]
    expect(target).toBe('daemon_remote_coordinator')
    expect(command).toBe('mesh_forward_event')
    expect(payload.event).toBe('agent:generating_completed')
    expect(peekUnresolvedDelegateForwards()).toHaveLength(0)
  })

  it('(b) acks on a successful immediate push so the retry loop does not resend', async () => {
    const { components, emit } = createUnresolvedWorker()
    const dispatchMeshCommand = vi.fn(async () => ({ success: true }))
    components.dispatchMeshCommand = dispatchMeshCommand

    setupMeshEventForwarding(components)
    emit(COMPLETION)

    expect(dispatchMeshCommand).toHaveBeenCalledTimes(1)
    // Let the .then(ack) settle, then the outbox is empty (delivered).
    await Promise.resolve()
    await Promise.resolve()
    expect(peekUnresolvedDelegateForwards()).toHaveLength(0)

    // A reconcile tick has nothing to retry — no further push.
    dispatchMeshCommand.mockClear()
    await runMeshReconcileTick(components)
    expect(dispatchMeshCommand).not.toHaveBeenCalled()
  })

  it('(c) enqueue is idempotent on the event fingerprint (a re-fired completion queues once)', async () => {
    const { components, emit } = createUnresolvedWorker()
    // Push always fails so the entry stays in the outbox and we can count rows.
    const dispatchMeshCommand = vi.fn(async () => { throw new Error('still unreachable') })
    components.dispatchMeshCommand = dispatchMeshCommand

    setupMeshEventForwarding(components)
    emit(COMPLETION)
    await Promise.resolve()
    emit(COMPLETION) // identical completion fires again
    await Promise.resolve()

    // Idempotent: the unique (mesh_id, fingerprint) index collapses both to one row.
    expect(peekUnresolvedDelegateForwards()).toHaveLength(1)
  })

  it('leaves the entry queued when the coordinator rejects the push (success:false)', async () => {
    const { components, emit } = createUnresolvedWorker()
    const dispatchMeshCommand = vi.fn(async () => ({ success: false, error: 'mesh not found yet' }))
    components.dispatchMeshCommand = dispatchMeshCommand

    setupMeshEventForwarding(components)
    emit(COMPLETION)
    await Promise.resolve()
    await Promise.resolve()

    // A rejected push must NOT ack — the completion stays durable for the next tick.
    expect(peekUnresolvedDelegateForwards()).toHaveLength(1)
  })
})
