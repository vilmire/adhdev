import { describe, expect, it } from 'vitest'
import { resolveMeshSurfacedSessionPreview } from '../../src/mesh/mesh-events-utils.js'

// T: the coordinator surfaces a REMOTE worker's mesh session but holds no local instance
// for it, so the status snapshot has no transcript to derive a preview from. The worker's
// latest assistant reply rides the completion event as `finalSummary` (or
// `workerResult.summary` / `result.summary`). resolveMeshSurfacedSessionPreview turns that
// into a preview the coordinator stamps on its mirror so the mobile inbox shows the
// assistant response instead of being stuck on the first dispatched user task.
describe('resolveMeshSurfacedSessionPreview', () => {
  it('extracts the assistant reply from finalSummary on a completion event', () => {
    const result = resolveMeshSurfacedSessionPreview({
      event: 'agent:generating_completed',
      finalSummary: '응 보인다. 책상 위에 컵라면 봉지들이 보이네.',
      timestamp: 12345,
    })
    expect(result).toEqual({
      preview: '응 보인다. 책상 위에 컵라면 봉지들이 보이네.',
      role: 'assistant',
      receivedAt: 12345,
    })
  })

  it('falls back to workerResult.summary then result.summary', () => {
    expect(resolveMeshSurfacedSessionPreview({
      workerResult: { summary: 'task done via worker result' },
      timestamp: 7,
    })?.preview).toBe('task done via worker result')

    expect(resolveMeshSurfacedSessionPreview({
      result: { summary: 'task done via result record' },
    })?.preview).toBe('task done via result record')
  })

  it('returns undefined when the event carries no assistant text so a prior preview is preserved', () => {
    // agent:generating_started / agent:ready without a summary must NOT clobber an
    // already-surfaced assistant preview.
    expect(resolveMeshSurfacedSessionPreview({ event: 'agent:generating_started' })).toBeUndefined()
    expect(resolveMeshSurfacedSessionPreview({ event: 'agent:ready', finalSummary: '   ' })).toBeUndefined()
  })

  it('coerces a string timestamp and tolerates a missing one', () => {
    expect(resolveMeshSurfacedSessionPreview({ finalSummary: 'x', timestamp: '999' })?.receivedAt).toBe(999)
    expect(resolveMeshSurfacedSessionPreview({ finalSummary: 'x' })?.receivedAt).toBe(0)
  })

  it('truncates an overlong summary to the preview cap', () => {
    const long = 'a'.repeat(2000)
    const result = resolveMeshSurfacedSessionPreview({ finalSummary: long })
    expect(result).toBeDefined()
    expect(result!.preview.length).toBeLessThanOrEqual(512)
    expect(result!.preview.endsWith('...[truncated]')).toBe(true)
  })
})
