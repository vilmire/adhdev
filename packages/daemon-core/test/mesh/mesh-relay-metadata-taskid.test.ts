import { describe, expect, it } from 'vitest'
import { buildRelayMetadataEvent } from '../../src/mesh/mesh-events-coordinator.js'

// TASKIDLESS 2nd-pass regression: a mesh completion event forwarded across the
// machine boundary (remote relay hop) arrives as a flat payload, and the coordinator
// rebuilds metadataEvent via a field whitelist before injectMeshSystemMessage consumes
// it. The whitelist dropped taskId — so the rebuilt metadataEvent.taskId was undefined,
// injectMeshSystemMessage's traceCtx.taskId / updateDirectDispatchStatus(eventTaskId)
// went undefined, EvtTrace queued/surfaced showed task=-, and the direct-dispatch ledger
// fell back to a session_id match (sibling-row flip risk). buildRelayMetadataEvent must
// mirror taskId (with meshActiveTaskId fallback), matching the local in-process forward
// path that passes the whole event through.
describe('buildRelayMetadataEvent taskId preservation (remote relay path)', () => {
  it('mirrors payload.taskId onto the rebuilt metadataEvent', () => {
    const md = buildRelayMetadataEvent({
      event: 'agent:generating_completed',
      taskId: 'task-8fffba2f',
      targetSessionId: 'sess-1',
      providerType: 'claude-code',
      workspace: '/repo/worktree',
      finalSummary: 'done',
      jobId: 'job-1',
      status: 'completed',
    })
    expect(md.taskId).toBe('task-8fffba2f')
    // sanity: the other whitelisted fields still survive the rebuild
    expect(md.targetSessionId).toBe('sess-1')
    expect(md.providerType).toBe('claude-code')
    expect(md.finalSummary).toBe('done')
  })

  it('falls back to payload.meshActiveTaskId when payload.taskId is absent', () => {
    const md = buildRelayMetadataEvent({
      event: 'agent:generating_completed',
      meshActiveTaskId: 'task-from-settings',
      targetSessionId: 'sess-2',
    })
    expect(md.taskId).toBe('task-from-settings')
  })

  it('prefers payload.taskId over payload.meshActiveTaskId', () => {
    const md = buildRelayMetadataEvent({
      event: 'agent:generating_completed',
      taskId: 'task-explicit',
      meshActiveTaskId: 'task-settings',
    })
    expect(md.taskId).toBe('task-explicit')
  })

  it('yields an empty (falsy) taskId when neither source is present (regression guard)', () => {
    const md = buildRelayMetadataEvent({
      event: 'agent:generating_completed',
      targetSessionId: 'sess-3',
    })
    // readNonEmptyString coerces an absent value to '' — falsy, so the downstream
    // consumer (readNonEmptyString(metadataEvent.taskId) || undefined) collapses it back
    // to undefined and the ledger keeps its session_id fallback. No spurious task id.
    expect(md.taskId).toBe('')
    expect(md.taskId).toBeFalsy()
  })
})
