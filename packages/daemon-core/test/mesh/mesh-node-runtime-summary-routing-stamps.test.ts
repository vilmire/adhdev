/**
 * Routing stamps in the pushed runtime summary (mesh-node-runtime-summary.ts):
 * `settings.meshLastNodeId` (the sticky node marker of a detached session) and
 * `settings.meshCoordinatorDaemonId` (the relay anchor) are identifiers the
 * coordinator needs to make a remote dispatch pick without a live member read.
 * The allow-list must carry them — and still drop every content field — and the
 * stamp version must be preserved (never defaulted) so an older member's summary
 * stays recognizable after the coordinator re-sanitizes it.
 */
import { describe, expect, it } from 'vitest'
import {
  MESH_NODE_RUNTIME_SESSION_STAMP_VERSION,
  buildMeshNodeRuntimeSummary,
  sanitizeMeshNodeRuntimeSummary,
} from '../../src/mesh/mesh-node-runtime-summary'

const rawSession = {
  id: 'sess-1',
  providerType: 'claude-cli',
  status: 'idle',
  // Content: must never survive the allow-list.
  title: 'PRIVATE TITLE',
  lastMessagePreview: 'PRIVATE CHAT TEXT',
  messages: [{ role: 'user', content: 'PRIVATE MESSAGE' }],
  settings: {
    launchedByCoordinator: true,
    meshLastNodeId: 'node_worktree_a',
    meshCoordinatorDaemonId: 'daemon_mach_coord',
    systemPrompt: 'PRIVATE PROMPT',
    meshTaskMessage: 'PRIVATE TASK TEXT',
  },
}

describe('runtime summary routing stamps', () => {
  it('member build carries meshLastNodeId / meshCoordinatorDaemonId and the stamp version, and drops content', () => {
    const summary = buildMeshNodeRuntimeSummary({ status: { instanceId: 'daemon_member', sessions: [rawSession] } })!
    expect(summary.sessionStampVersion).toBe(MESH_NODE_RUNTIME_SESSION_STAMP_VERSION)
    expect(summary.sessions[0].settings).toEqual({
      launchedByCoordinator: true,
      meshLastNodeId: 'node_worktree_a',
      meshCoordinatorDaemonId: 'daemon_mach_coord',
    })
    expect(JSON.stringify(summary)).not.toContain('PRIVATE')
  })

  it('coordinator re-sanitize is idempotent and keeps the stamps (content still rejected)', () => {
    const member = buildMeshNodeRuntimeSummary({ status: { instanceId: 'daemon_member', sessions: [rawSession] } })!
    // A tampered member adds content next to the allow-listed fields.
    const tampered = {
      ...member,
      sessions: member.sessions.map(s => ({ ...s, title: 'PRIVATE TITLE', settings: { ...s.settings, systemPrompt: 'PRIVATE PROMPT' } })),
      transcript: 'PRIVATE TRANSCRIPT',
    }
    const ingested = sanitizeMeshNodeRuntimeSummary(tampered)!
    expect(ingested).toEqual(member)
    expect(JSON.stringify(ingested)).not.toContain('PRIVATE')
  })

  it('an older member summary (no stamp version) stays without one after the coordinator re-sanitizes it', () => {
    const olderMember = { schemaVersion: 1, daemonId: 'daemon_old', sessions: [{ id: 'sess-old', settings: { meshNodeFor: 'mesh_a' } }] }
    const ingested = sanitizeMeshNodeRuntimeSummary(olderMember)!
    expect(ingested.sessionStampVersion).toBeUndefined()
  })

  it('a routing stamp that is not identifier-shaped (multi-line / oversized) is dropped', () => {
    const summary = sanitizeMeshNodeRuntimeSummary({
      sessions: [{ id: 's', settings: { meshLastNodeId: 'line one\nline two', meshCoordinatorDaemonId: 'x'.repeat(500) } }],
    })!
    expect(summary.sessions[0].settings).toBeUndefined()
  })
})
