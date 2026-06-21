import { describe, expect, it } from 'vitest'
import { buildMeshSystemMessage, readMeshCompletionSummary } from '../../src/mesh/mesh-events-utils.js'

// C2 ([INJECT]): a worker completion event carries the worker's final assistant message as
// `finalSummary`. The coordinator message buildMeshSystemMessage produces used to merely
// instruct the coordinator to "use mesh_read_chat" to see the result. C2 surfaces the
// summary INLINE into the coordinator chat so it can act on the result without a second
// round-trip; it falls back to the read_chat instruction only when no summary is present.
describe('buildMeshSystemMessage — completion summary auto-surface (C2)', () => {
  it('embeds the worker finalSummary directly into the coordinator message', () => {
    const finalSummary = 'Refactored the auth module; 3 files changed; npm test passed.'
    const msg = buildMeshSystemMessage({
      event: 'agent:generating_completed',
      nodeLabel: "Node 'node_child_1'",
      metadataEvent: { sessionId: 'sess-1', timestamp: Date.now(), finalSummary },
    })
    expect(msg).toContain('has completed its task')
    // The summary is surfaced inline …
    expect(msg).toContain(finalSummary)
    expect(msg).toContain('final summary')
    // … and the message no longer leads with a bare "go call mesh_read_chat" instruction.
    expect(msg).toContain('read it directly')
    expect(msg).not.toContain('Use mesh_read_chat once to review its final progress')
  })

  it('surfaces the reviewRecommended verify note alongside the summary when evidence is weak', () => {
    const msg = buildMeshSystemMessage({
      event: 'agent:generating_completed',
      nodeLabel: "Node 'node_child_1'",
      metadataEvent: {
        sessionId: 'sess-2',
        timestamp: Date.now(),
        finalSummary: 'Done.',
        reviewRecommended: true,
        evidenceLevel: 'weak',
      },
    })
    expect(msg).toContain('Done.')
    expect(msg).toContain('Completion evidence is insufficient')
    // evidenceLevel is surfaced via the completion metadata suffix.
    expect(msg).toContain('evidence_level=weak')
  })

  it('truncates an oversized summary but still points to mesh_read_chat for the full transcript', () => {
    const finalSummary = 'x'.repeat(8000)
    const msg = buildMeshSystemMessage({
      event: 'agent:generating_completed',
      nodeLabel: "Node 'node_child_1'",
      metadataEvent: { sessionId: 'sess-3', timestamp: Date.now(), finalSummary },
    })
    expect(msg.length).toBeLessThan(finalSummary.length)
    expect(msg).toContain('truncated')
    expect(msg).toContain('mesh_read_chat')
  })

  it('falls back to the read_chat instruction when the completion carries no summary', () => {
    const msg = buildMeshSystemMessage({
      event: 'agent:generating_completed',
      nodeLabel: "Node 'node_child_1'",
      metadataEvent: { sessionId: 'sess-4', timestamp: Date.now() },
    })
    // No summary to surface → legacy behaviour is preserved (no regression).
    expect(msg).toContain('Use mesh_read_chat once to review its final progress')
  })

  it('readMeshCompletionSummary resolves the summary from workerResult / result fallbacks', () => {
    expect(readMeshCompletionSummary({ finalSummary: 'A' })).toBe('A')
    expect(readMeshCompletionSummary({ workerResult: { summary: 'B' } })).toBe('B')
    expect(readMeshCompletionSummary({ result: { finalSummary: 'C' } })).toBe('C')
    expect(readMeshCompletionSummary({ sessionId: 'x' })).toBe('')
  })
})
