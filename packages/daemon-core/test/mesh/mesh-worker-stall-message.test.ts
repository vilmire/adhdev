import { describe, expect, it } from 'vitest'
import { buildMeshSystemMessage } from '../../src/mesh/mesh-events-utils.js'

// MESH-STALL-WATCH (feature 1: STALL detection). The coordinator-facing message
// for a status-agnostic worker stall (metadataEvent.meshWorkerStall === true) is
// generalized away from the generating-only "still reported as generating"
// phrasing to "PTY output unchanged", and states explicitly that it is
// informational (not a failure / auto-restart). A plain monitor:no_progress
// (StatusMonitor, no meshWorkerStall marker) keeps the original generating wording.
describe('buildMeshSystemMessage — monitor:no_progress worker stall', () => {
  it('uses generalized "PTY output unchanged" wording for a mesh worker stall', () => {
    const msg = buildMeshSystemMessage({
      event: 'monitor:no_progress',
      nodeLabel: 'node-1',
      metadataEvent: {
        meshWorkerStall: true,
        stalledMs: 185_000,
        observedStatus: 'idle',
        taskId: 'task-1',
      },
    })
    expect(msg).toContain('PTY output unchanged')
    expect(msg).toContain('185s')
    expect(msg).toContain('observed status: idle')
    expect(msg.toLowerCase()).toContain('informational')
    // Must NOT claim the worker is generating — this fires status-agnostically.
    expect(msg).not.toContain('still reported as generating')
  })

  it('keeps the generating-specific wording for a non-stall no_progress', () => {
    const msg = buildMeshSystemMessage({
      event: 'monitor:no_progress',
      nodeLabel: 'node-1',
      metadataEvent: {},
    })
    expect(msg).toContain('still reported as generating')
    expect(msg).not.toContain('PTY output unchanged')
  })
})
