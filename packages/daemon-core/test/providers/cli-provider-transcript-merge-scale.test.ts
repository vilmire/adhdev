import { describe, expect, it, vi } from 'vitest'
import { mergeConversationMessages } from '../../src/providers/cli-provider-transcript-merge.js'
import { readInstanceIdentity } from '../../src/mesh/mesh-queue-assignment.js'

// 2026-10-17 preview-daemon incident: the mesh queue-claim tick (every 4s) called
// getState() on every CLI instance, and getState() runs mergeConversationMessages,
// whose runtime-ack dedup rescanned all parsed turns and all runtime messages per
// ack (O(n²) regex normalization). With 13 long sessions the event loop sat at
// 100% CPU, session-host requests timed out and the dashboard lost the machine.

function session(turns: number) {
  const parsed: any[] = []
  const runtime: Array<{ key: string; message: any }> = []
  for (let i = 0; i < turns; i += 1) {
    const at = 1_000_000 + i * 10_000
    const text = `prompt number ${i}\n  with   some   spacing ${'x'.repeat(200)}`
    parsed.push({ role: 'user', content: text, receivedAt: at + 50 })
    parsed.push({ role: 'assistant', content: `answer ${i} ${'y'.repeat(800)}`, receivedAt: at + 5_000 })
    runtime.push({
      key: `ack:${i}`,
      message: { role: 'user', content: text, receivedAt: at, meta: { runtimeInputAck: true } },
    })
  }
  return { parsed, runtime }
}

describe('mergeConversationMessages at session scale', () => {
  it('folds each unique runtime ack into its native turn (no duplicate user bubbles)', () => {
    const { parsed, runtime } = session(50)
    const merged = mergeConversationMessages(runtime, parsed)
    expect(merged.filter((m) => m.role === 'user')).toHaveLength(50)
    expect(merged).toHaveLength(100)
  })

  it('keeps both acks when the same text was sent twice (ambiguous → not folded)', () => {
    const text = 'same prompt'
    const parsed = [{ role: 'user', content: text, receivedAt: 1_050 }]
    const runtime = [
      { key: 'a', message: { role: 'user', content: text, receivedAt: 1_000, meta: { runtimeInputAck: true } } },
      { key: 'b', message: { role: 'user', content: text, receivedAt: 2_000, meta: { runtimeInputAck: true } } },
    ]
    const merged = mergeConversationMessages(runtime, parsed)
    expect(merged.filter((m) => m.role === 'user')).toHaveLength(3)
  })

  it('merges a 1,800-message session fast enough to run on every claim tick', () => {
    const { parsed, runtime } = session(900)
    mergeConversationMessages(runtime, parsed) // warm up the JIT
    const started = performance.now()
    for (let i = 0; i < 13; i += 1) mergeConversationMessages(runtime, parsed)
    const elapsedMs = performance.now() - started
    // 13 sessions × 900 turns. The quadratic version took seconds here; the
    // indexed one is tens of milliseconds. The bound is loose for slow CI.
    expect(elapsedMs).toBeLessThan(1_500)
  })
})

describe('readInstanceIdentity', () => {
  it('reads the plain instanceId field without building state', () => {
    const getState = vi.fn(() => ({ instanceId: 'from-state' }))
    expect(readInstanceIdentity({ instanceId: 'sess-1', getState })).toBe('sess-1')
    expect(getState).not.toHaveBeenCalled()
  })

  it('falls back to getState() for instances without the field', () => {
    expect(readInstanceIdentity({ getState: () => ({ instanceId: 'sess-2' }) })).toBe('sess-2')
    expect(readInstanceIdentity(undefined)).toBeUndefined()
  })
})

describe('findLocalCliInstance', () => {
  it('builds state for no instance other than the match', async () => {
    const { findLocalCliInstance } = await import('../../src/mesh/cli-instance-lookup.js')
    const mk = (id: string) => ({ category: 'cli', instanceId: id, getState: vi.fn(() => ({ instanceId: id })) })
    const others = Array.from({ length: 12 }, (_, i) => mk(`sess-${i}`))
    const target = mk('sess-target')
    const components = { instanceManager: { getInstance: () => undefined, getByCategory: () => [...others, target] } }
    expect(findLocalCliInstance(components, 'sess-target')).toBe(target)
    for (const o of others) expect(o.getState).not.toHaveBeenCalled()
    expect(findLocalCliInstance(components, 'missing')).toBeUndefined()
  })
})
