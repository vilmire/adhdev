import { describe, expect, it, vi } from 'vitest';
import { TurnSnapshotTracker } from '../../src/git/turn-snapshot-tracker.js';

describe('TurnSnapshotTracker', () => {
  it('does NOT fire when transitioning idle → streaming', () => {
    const callback = vi.fn()
    const tracker = new TurnSnapshotTracker(callback)
    tracker.record('s1', 'idle', '/workspace')
    tracker.record('s1', 'streaming', '/workspace')
    expect(callback).not.toHaveBeenCalled()
  })

  it('does NOT fire when transitioning streaming → streaming', () => {
    const callback = vi.fn()
    const tracker = new TurnSnapshotTracker(callback)
    tracker.record('s1', 'streaming', '/workspace')
    tracker.record('s1', 'streaming', '/workspace')
    expect(callback).not.toHaveBeenCalled()
  })

  it('fires when transitioning streaming → idle (with workspace)', () => {
    const callback = vi.fn()
    const tracker = new TurnSnapshotTracker(callback)
    tracker.record('s1', 'streaming', '/workspace')
    tracker.record('s1', 'idle', '/workspace')
    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith({ sessionId: 's1', workspace: '/workspace' })
  })

  it('fires when transitioning waiting_approval → error (with workspace)', () => {
    const callback = vi.fn()
    const tracker = new TurnSnapshotTracker(callback)
    tracker.record('s1', 'waiting_approval', '/workspace')
    tracker.record('s1', 'error', '/workspace')
    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith({ sessionId: 's1', workspace: '/workspace' })
  })

  it('does NOT fire when transitioning streaming → idle with no workspace', () => {
    const callback = vi.fn()
    const tracker = new TurnSnapshotTracker(callback)
    tracker.record('s1', 'streaming', null)
    tracker.record('s1', 'idle', null)
    expect(callback).not.toHaveBeenCalled()
  })

  it('forget() clears state — no fire after forget', () => {
    const callback = vi.fn()
    const tracker = new TurnSnapshotTracker(callback)
    tracker.record('s1', 'streaming', '/workspace')
    tracker.forget('s1')
    tracker.record('s1', 'idle', '/workspace')
    expect(callback).not.toHaveBeenCalled()
  })
})
