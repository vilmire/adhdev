import { describe, expect, it } from 'vitest'
import { createWebDebugStore } from '../../src/debug/webDebugStore'

describe('webDebugStore', () => {
  it('keeps a bounded ring buffer', () => {
    const store = createWebDebugStore({ capacity: 2 })

    store.record({ kind: 'p2p.topic_update_received', topic: 'session.chat_tail', payload: { seq: 1 } })
    store.record({ kind: 'subscription.publish', topic: 'session.chat_tail', payload: { seq: 2 } })
    store.record({ kind: 'dashboard.session_state_applied', topic: 'session.modal', payload: { seq: 3 } })

    const entries = store.list({ limit: 10 })
    expect(entries).toHaveLength(2)
    expect(entries.map((entry) => entry.payload)).toEqual([{ seq: 2 }, { seq: 3 }])
  })

  it('filters by topic and interaction id', () => {
    const store = createWebDebugStore({ capacity: 10 })

    store.record({ interactionId: 'ix_1', kind: 'p2p.topic_update_received', topic: 'session.chat_tail', payload: { seq: 1 } })
    store.record({ interactionId: 'ix_2', kind: 'subscription.publish', topic: 'session.modal', payload: { seq: 2 } })
    store.record({ interactionId: 'ix_1', kind: 'dashboard.session_state_applied', topic: 'session.chat_tail', payload: { seq: 3 } })

    expect(store.list({ interactionId: 'ix_1', limit: 10 }).map((entry) => entry.payload))
      .toEqual([{ seq: 1 }, { seq: 3 }])
    expect(store.list({ topic: 'session.modal', limit: 10 }).map((entry) => entry.payload))
      .toEqual([{ seq: 2 }])
  })
})
