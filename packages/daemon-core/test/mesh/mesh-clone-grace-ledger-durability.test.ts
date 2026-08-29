import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isWithinCloneBootstrapGrace,
  isWithinCloneBootstrapGraceDurable,
  CLONE_BOOTSTRAP_GRACE_MS,
  __resetCloneBootstrapGraceForTests,
} from '../../src/mesh/mesh-clone-grace.js'
import { isTargetNodeTransientlyUnresolved } from '../../src/mesh/mesh-skip-notify.js'
import type { MeshWorkQueueEntry } from '../../src/mesh/mesh-work-queue.js'

// M-MESH-INFRA-0829 defect 5-b [B]: the clone-bootstrap grace window (mesh-clone-grace.ts) was a
// bare in-memory Map, populated only once at clone-forward time. A coordinator daemon restart
// within the 10-minute window (or a bootstrap that simply runs long) loses that evidence, so a
// still-transient clone was silently reported as the PERMANENT, coordinator-paging
// 'target_node_id_unmatched' reason — exactly the "notification recurs even after a mesh_status
// refresh" symptom, since a refresh never repopulates the in-memory registry. These tests pin
// that a durable ledger 'node_cloned' entry now recovers the same grace window when the
// in-memory registry has nothing.
describe("M-MESH-INFRA-0829 [B] — isWithinCloneBootstrapGraceDurable ledger fallback", () => {
  let root: string
  let previousConfigDir: string | undefined
  let meshId: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'adhdev-clone-grace-durable-'))
    previousConfigDir = process.env.ADHDEV_CONFIG_DIR
    process.env.ADHDEV_CONFIG_DIR = join(root, '.adhdev')
    meshId = 'mesh_ghost_grace'
    __resetCloneBootstrapGraceForTests()
  })

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
    else process.env.ADHDEV_CONFIG_DIR = previousConfigDir
    try { rmSync(root, { recursive: true, force: true }) } catch { /* best-effort */ }
    __resetCloneBootstrapGraceForTests()
  })

  async function appendClonedEntryAt(nodeId: string, atMs: number) {
    const { appendLedgerEntry } = await import('../../src/mesh/mesh-ledger.js')
    vi.useFakeTimers()
    vi.setSystemTime(atMs)
    try {
      appendLedgerEntry(meshId, { kind: 'node_cloned', nodeId, payload: { sourceNodeId: 'node_base', branch: 'feature-x' } })
    } finally {
      vi.useRealTimers()
    }
  }

  it('in-memory registry alone (nothing recorded) reports NOT within grace — proves the fixture reaches the gap', () => {
    expect(isWithinCloneBootstrapGrace('node_ghost_1')).toBe(false)
  })

  it('falls back to a durable ledger node_cloned entry within the grace window when the in-memory registry has nothing', async () => {
    const nodeId = 'node_ghost_2'
    const clonedAtMs = Date.now() - 60_000
    await appendClonedEntryAt(nodeId, clonedAtMs)

    // In-memory registry is empty for this node (never noted this process run — simulates a
    // coordinator restart after the clone) — only the ledger fallback can recover it.
    expect(isWithinCloneBootstrapGrace(nodeId)).toBe(false)
    expect(isWithinCloneBootstrapGraceDurable(meshId, nodeId, clonedAtMs + 60_000)).toBe(true)
  })

  it('returns false once the durable ledger entry itself is past the grace window (genuinely stale)', async () => {
    const nodeId = 'node_ghost_3'
    const clonedAtMs = Date.now() - 60_000
    await appendClonedEntryAt(nodeId, clonedAtMs)

    const pastGrace = clonedAtMs + CLONE_BOOTSTRAP_GRACE_MS + 60_000
    expect(isWithinCloneBootstrapGraceDurable(meshId, nodeId, pastGrace)).toBe(false)
  })

  it('returns false for a node id with no ledger evidence at all (genuinely dead node stays actionable)', async () => {
    await appendClonedEntryAt('node_ghost_other', Date.now())
    expect(isWithinCloneBootstrapGraceDurable(meshId, 'node_never_cloned', Date.now())).toBe(false)
  })

  it('isTargetNodeTransientlyUnresolved (the actual call site) recovers via the ledger fallback', async () => {
    const nodeId = 'node_ghost_4'
    const clonedAtMs = Date.now() - 60_000
    await appendClonedEntryAt(nodeId, clonedAtMs)

    // Mesh has NO nodes at all (simulates the node genuinely absent from this coordinator's
    // union view at scan time) and the in-memory registry is empty — before the fix this must
    // classify as permanently unmatched.
    const mesh = { id: meshId, nodes: [] }
    const task = { id: 'task_1', meshId, targetNodeId: nodeId, status: 'pending' } as unknown as MeshWorkQueueEntry

    // isTargetNodeTransientlyUnresolved calls the durable check with real Date.now() (no
    // override) — the ledger entry was appended ~60s ago (real time), well within the 10min grace.
    expect(isTargetNodeTransientlyUnresolved(mesh, task)).toBe(true)
  })
})
