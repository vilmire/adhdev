import { afterEach, describe, expect, it, vi } from 'vitest'

// mesh-event-forwarding after wiring-unification C-W5c: `buildProviderEvidence`
// / `observeBuilt` are DELETED — a mesh session's `agent:*` provider event no
// longer becomes turn evidence here. `TurnEvidencePort` (every producer site,
// via `providers/turn-evidence-port.ts`'s `emit*` helpers) is now the sole
// producer of turn evidence, mesh-bound or plain; see
// `test/providers/turn-evidence-port.test.ts` (owner/handoff resolution) and
// `test/boot/mesh-runtime-turn-wiring.test.ts` (every kind reaches the ledger
// for a mesh-bound session, not just `session_error`) for that coverage.
//
// What is LEFT in this file (mesh-event-forwarding.ts, `processMeshEvent`):
// non-turn events (refine, worktree bootstrap, mission close) still become
// coordinator notices, and queue-edge bookkeeping (idle registration/claim,
// bootstrap terminal state) the reducer does not own.

const meshConfigMocks = vi.hoisted(() => ({
  getMesh: vi.fn(),
  getMeshByRepo: vi.fn(() => undefined),
  listMeshes: vi.fn(() => []),
}))
vi.mock('../../src/config/mesh-config.js', () => ({
  getMesh: meshConfigMocks.getMesh,
  getMeshByRepo: meshConfigMocks.getMeshByRepo,
  listMeshes: meshConfigMocks.listMeshes,
}))

import { setupMeshEventForwarding, processMeshEvent } from '../../src/mesh/mesh-event-forwarding.js'
import { bindMeshNoticeRuntime } from '../../src/mesh/turn-ledger/deliver.js'
import { captureNotices } from '../helpers/notice-capture.js'
import { withMeshForwardingBus } from './helpers/mesh-forwarding-bus-fixture.js'

const MESH = 'mesh_fwd_evidence'
const SESSION = 'worker-session-1'

function worker(settings: Record<string, unknown> = {}) {
  return {
    category: 'cli',
    getState: () => ({ instanceId: SESSION, workspace: '/repo/wt', status: 'idle', settings: { meshNodeFor: MESH, meshNodeId: 'node_1', ...settings } }),
    onEvent: vi.fn(),
  }
}

function setup(opts: { settings?: Record<string, unknown> } = {}) {
  meshConfigMocks.getMesh.mockReturnValue({ id: MESH, nodes: [{ id: 'node_1', workspace: '/repo/wt' }], policy: {} })
  const source = worker(opts.settings)
  const components = withMeshForwardingBus({
    instanceManager: {
      getInstance: (id: string) => (id === SESSION ? source : undefined),
      getByCategory: (c: string) => (c === 'cli' ? [source] : []),
    },
    router: { markWorktreeBootstrapTerminalState: vi.fn(), getCachedInlineMesh: vi.fn(() => undefined) },
    statusInstanceId: 'daemon_self',
  } as any)
  const capture = captureNotices()
  const off = setupMeshEventForwarding(components)
  return { components, capture, off }
}

afterEach(() => {
  bindMeshNoticeRuntime(null)
  vi.clearAllMocks()
})

describe('mesh-event-forwarding after C-W5c (no evidence construction)', () => {
  it('a completion/stop provider event produces NO evidence call — processMeshEvent has no ledger dependency at all', () => {
    const { components, off } = setup()
    // No `evidence` field in MeshEventResult anymore, and no exception even
    // though nothing here talks to a ledger — the port already observed
    // this evidence at its own producer site before the bus ever saw it.
    const result = processMeshEvent(components as any, {
      meshId: MESH, eventName: 'agent:generating_completed', event: { finalSummary: 'x', timestamp: 1000 },
      nodeId: 'node_1', nodeLabel: "Node 'node_1'", sessionId: SESSION, settings: {},
      coordinatorDaemonId: '', coordinatorSessionId: '',
    })
    expect(result).toEqual({ success: true })
    off()
  })

  it('worktree bootstrap / refine events still become coordinator notices, not evidence', () => {
    const { components, capture, off } = setup()
    components.emit({ event: 'worktree_bootstrap_complete', instanceId: SESSION, targetSessionId: SESSION, worktreePath: '/repo/wt', timestamp: 4_000 })
    expect(capture.pending(MESH).map((n) => n.event)).toEqual(['worktree_bootstrap_complete'])
    expect((components as any).router.markWorktreeBootstrapTerminalState).toHaveBeenCalledWith(MESH, 'node_1', 'complete', expect.objectContaining({ workspace: '/repo/wt' }))
    off()
  })

  it('a bare agent:generating_completed relay (no turnLedger on components) still runs the queue-edge path without throwing', () => {
    const { components, off } = setup()
    expect(() => {
      components.emit({ event: 'agent:generating_completed', instanceId: SESSION, targetSessionId: SESSION, providerType: 'codex-cli', timestamp: 1_000 })
    }).not.toThrow()
    off()
  })
})
