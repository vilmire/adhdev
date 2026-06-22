import { describe, expect, it } from 'vitest'
import { CliProviderInstance } from '../../src/providers/cli-provider-instance.js'

// TASKIDLESS regression: the mesh consumer (updateDirectDispatchStatus) keys on
// task_id (CANON-B), but the producer — pushEvent in CliProviderInstance — never
// carried it. Every forwarded metadataEvent.taskId arrived undefined and the
// coordinator fell back to a session_id match, which can flip a sibling dispatch
// row. pushEvent must now stamp settings.meshActiveTaskId onto lifecycle events
// emitted by a mesh worker session, and must NOT stamp anything for a plain
// (non-mesh) CLI session.
describe('CliProviderInstance.pushEvent mesh taskId stamping', () => {
  function makeInstance(settings: Record<string, any>) {
    const emitted: any[] = []
    const instance = Object.create(CliProviderInstance.prototype) as any
    instance.instanceId = 'sess-instance-1'
    instance.type = 'claude-code'
    instance.workingDir = '/work/repo'
    instance.providerSessionId = 'provider-sess-1'
    instance.settings = settings
    instance.events = []
    // Adapter is touched by detachMeshAssignment on terminal events.
    instance.adapter = { updateRuntimeSettings() {} }
    instance.context = { emitProviderEvent: (e: any) => emitted.push(e) }
    return { instance, emitted }
  }

  it('stamps meshActiveTaskId onto agent:generating_started for a mesh worker session', () => {
    const { instance, emitted } = makeInstance({
      meshNodeFor: 'mesh-abc',
      meshNodeId: 'node-1',
      meshActiveTaskId: 'task-12345',
    })
    instance.pushEvent({ event: 'agent:generating_started', timestamp: 1 })
    expect(emitted).toHaveLength(1)
    expect(emitted[0].taskId).toBe('task-12345')
  })

  it('stamps meshActiveTaskId onto agent:generating_completed for a mesh worker session', () => {
    const { instance, emitted } = makeInstance({
      meshNodeFor: 'mesh-abc',
      meshNodeId: 'node-1',
      meshActiveTaskId: 'task-67890',
    })
    instance.pushEvent({ event: 'agent:generating_completed', timestamp: 2 })
    expect(emitted).toHaveLength(1)
    expect(emitted[0].taskId).toBe('task-67890')
  })

  it('does NOT stamp a taskId for a plain non-mesh CLI session (regression guard)', () => {
    const { instance, emitted } = makeInstance({})
    instance.pushEvent({ event: 'agent:generating_started', timestamp: 3 })
    instance.pushEvent({ event: 'agent:generating_completed', timestamp: 4 })
    expect(emitted).toHaveLength(2)
    expect(emitted[0].taskId).toBeUndefined()
    expect(emitted[1].taskId).toBeUndefined()
  })

  it('does NOT overwrite a taskId the event already carries', () => {
    const { instance, emitted } = makeInstance({
      meshNodeFor: 'mesh-abc',
      meshActiveTaskId: 'task-from-settings',
    })
    instance.pushEvent({ event: 'agent:generating_started', timestamp: 5, taskId: 'task-explicit' })
    expect(emitted).toHaveLength(1)
    expect(emitted[0].taskId).toBe('task-explicit')
  })
})
