import { describe, expect, it } from 'vitest'

import {
  buildLiveSessionInboxStateMap,
  getConversationLiveInboxState,
  isHiddenNativeIdeParentConversation,
  resolveMuted,
  resolveSurfaceHidden,
} from '../../../src/components/dashboard/DashboardMobileChatShared'

// HIDE-FLAP — a session blinked between hidden and shown while the daemon's
// state never changed (owner report + RCA 9c41fd48).
//
// Cause, in two layers:
//   ① normalizeInboxState coerced `surfaceHidden` with `!!`, so a copy that
//      merely OMITTED the field became an explicit "not hidden".
//   ② one session legitimately appears twice in `ides` (a top-level entry plus
//      a `childSessions` child), and the duplicate that won was chosen by
//      recency — so whichever copy was touched last decided visibility. As the
//      two took turns being newest, the session blinked.
//
// The contract these tests pin: the rendered visibility of a session depends
// only on WHAT the copies know, never on WHICH copy is newest.

/** A daemon entry carrying a child session, as `ides` delivers it. */
function parentWith(child: Record<string, unknown>, parent: Record<string, unknown> = {}): any {
  return {
    id: 'ide_1',
    type: 'cli',
    sessionId: 'parent-session',
    childSessions: [child],
    ...parent,
  }
}

const SESSION = 'a88e8545-2d76-4c0b-a465-c4b0f60902e8'

describe('hide/unhide flap — duplicate registrations of one session', () => {
  // ── Contract 1 (core): alternation is structurally impossible ────────────
  it('resolves to the same visibility whichever duplicate is newest', () => {
    // The live repro shape: the top-level copy knows the session is hidden, the
    // child copy does not carry the field at all. Only the timestamps differ
    // between the two runs.
    const knowsHidden = { id: SESSION, surfaceHidden: true, lastUpdated: 0 }
    const silent = { id: SESSION, lastUpdated: 0 }

    const hiddenCopyNewer = buildLiveSessionInboxStateMap([
      parentWith({ ...silent, lastUpdated: 100 }, { sessionId: undefined }),
      parentWith({ ...knowsHidden, lastUpdated: 200 }, { id: 'ide_2', sessionId: undefined }),
    ])
    const silentCopyNewer = buildLiveSessionInboxStateMap([
      parentWith({ ...knowsHidden, lastUpdated: 100 }, { sessionId: undefined }),
      parentWith({ ...silent, lastUpdated: 200 }, { id: 'ide_2', sessionId: undefined }),
    ])

    // Before the fix these disagreed — that disagreement WAS the blinking.
    expect(resolveSurfaceHidden(hiddenCopyNewer.get(SESSION))).toBe(true)
    expect(resolveSurfaceHidden(silentCopyNewer.get(SESSION))).toBe(true)
    expect(resolveSurfaceHidden(hiddenCopyNewer.get(SESSION)))
      .toBe(resolveSurfaceHidden(silentCopyNewer.get(SESSION)))
  })

  it('holds for muted too, and for the top-level/child pairing', () => {
    const withFlags = buildLiveSessionInboxStateMap([
      // top-level entry knows both flags; child copy is silent but newer.
      { id: 'ide_1', type: 'cli', sessionId: SESSION, surfaceHidden: true, muted: true, lastUpdated: 10,
        childSessions: [{ id: SESSION, lastUpdated: 99 }] } as any,
    ])
    expect(resolveSurfaceHidden(withFlags.get(SESSION))).toBe(true)
    expect(resolveMuted(withFlags.get(SESSION))).toBe(true)
  })

  it('a silent copy alone leaves the state unknown, never a claimed "not hidden"', () => {
    const map = buildLiveSessionInboxStateMap([
      { id: 'ide_1', type: 'cli', sessionId: SESSION, lastUpdated: 5 } as any,
    ])
    // undefined — "nobody told us" — not `false`.
    expect(map.get(SESSION)?.surfaceHidden).toBeUndefined()
    // …which the render boundary turns into "shown" exactly once.
    expect(resolveSurfaceHidden(map.get(SESSION))).toBe(false)
  })

  // ── Contract 2: no over-correction — un-hide must still work ─────────────
  it('REGRESSION: an explicit un-hide still shows the session', () => {
    // The dangerous direction: making "knows" beat "silent" must not make a
    // real `surfaceHidden: false` unreachable. A user who un-hides must see it.
    const map = buildLiveSessionInboxStateMap([
      { id: 'ide_1', type: 'cli', sessionId: SESSION, surfaceHidden: false, muted: false, lastUpdated: 50 } as any,
    ])
    expect(map.get(SESSION)?.surfaceHidden).toBe(false)
    expect(resolveSurfaceHidden(map.get(SESSION))).toBe(false)
  })

  it('REGRESSION: a newer explicit un-hide beats an older explicit hide', () => {
    // When BOTH copies know, recency is still the right rule — otherwise a
    // stale `hidden: true` would pin the session hidden forever.
    const unhideNewer = buildLiveSessionInboxStateMap([
      { id: 'ide_1', type: 'cli', sessionId: SESSION, surfaceHidden: true, lastUpdated: 10 } as any,
      { id: 'ide_2', type: 'cli', sessionId: SESSION, surfaceHidden: false, lastUpdated: 20 } as any,
    ])
    expect(resolveSurfaceHidden(unhideNewer.get(SESSION))).toBe(false)

    // …and the reverse ordering still hides, so recency genuinely governs here.
    const hideNewer = buildLiveSessionInboxStateMap([
      { id: 'ide_1', type: 'cli', sessionId: SESSION, surfaceHidden: false, lastUpdated: 10 } as any,
      { id: 'ide_2', type: 'cli', sessionId: SESSION, surfaceHidden: true, lastUpdated: 20 } as any,
    ])
    expect(resolveSurfaceHidden(hideNewer.get(SESSION))).toBe(true)
  })

  // ── Contract 3: the map-miss fallback ────────────────────────────────────
  it('does not assert "not hidden" for a session missing from the map', () => {
    const fallback = getConversationLiveInboxState(
      { sessionId: 'unknown-session', tabKey: 'tab_1' } as any,
      new Map(),
    )
    // Unknown, not a claim. Asserting `false` here made a session pop into view
    // on any tick where the map briefly lacked it — the same blink, other side.
    expect(fallback.surfaceHidden).toBeUndefined()
    expect(fallback.muted).toBeUndefined()
    // The render boundary still yields a concrete, safe answer.
    expect(resolveSurfaceHidden(fallback)).toBe(false)
    expect(isHiddenNativeIdeParentConversation(
      { sessionId: 'unknown-session', tabKey: 'tab_1' } as any, [], new Map(),
    )).toBe(false)
  })

  it('keeps non-hide fields on recency, so live values are not pinned', () => {
    // The fix is scoped to surfaceHidden/muted. unread/inboxBucket must still
    // follow the newest reading — pinning those would be a different bug.
    const map = buildLiveSessionInboxStateMap([
      { id: 'ide_1', type: 'cli', sessionId: SESSION, unread: true, inboxBucket: 'needs_attention', lastUpdated: 10 } as any,
      { id: 'ide_2', type: 'cli', sessionId: SESSION, unread: false, inboxBucket: 'idle', lastUpdated: 20 } as any,
    ])
    expect(map.get(SESSION)?.unread).toBe(false)
    expect(map.get(SESSION)?.inboxBucket).toBe('idle')
  })
})
