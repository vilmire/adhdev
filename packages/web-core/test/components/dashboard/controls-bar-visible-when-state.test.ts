import { describe, expect, it } from 'vitest'
import type { ProviderControlSchema } from '@adhdev/daemon-core'
import {
  getVisibleBarControls,
  isControlVisibleForState,
  pruneServerReportedLocalValues,
} from '../../../src/components/dashboard/ControlsBar'

const barControl = (over: Partial<ProviderControlSchema>): ProviderControlSchema => ({
  id: 'set_model',
  type: 'select',
  label: 'Model',
  placement: 'bar',
  ...over,
})

describe('isControlVisibleForState', () => {
  it('shows controls gated to idle only when the session is idle', () => {
    const ctrl = barControl({ id: 'set_model', visibleWhenState: ['idle'] })
    expect(isControlVisibleForState(ctrl, 'idle')).toBe(true)
    expect(isControlVisibleForState(ctrl, 'generating')).toBe(false)
  })

  it('shows controls gated to busy while the session is generating', () => {
    // statusForState collapses the FSM 'busy' state to the 'generating' status,
    // so a busy-gated control must show across generating-flavoured statuses.
    const stop = barControl({ id: 'stop', type: 'action', visibleWhenState: ['busy'] })
    expect(isControlVisibleForState(stop, 'generating')).toBe(true)
    expect(isControlVisibleForState(stop, 'streaming')).toBe(true)
    expect(isControlVisibleForState(stop, 'long_generating')).toBe(true)
    expect(isControlVisibleForState(stop, 'idle')).toBe(false)
  })

  it('always shows controls without visibleWhenState (regression guard)', () => {
    const ctrl = barControl({ id: 'thinking', type: 'toggle' })
    expect(isControlVisibleForState(ctrl, 'idle')).toBe(true)
    expect(isControlVisibleForState(ctrl, 'generating')).toBe(true)
    expect(isControlVisibleForState(ctrl, undefined)).toBe(true)
  })

  it('shows conservatively when the current status is unknown or unmapped', () => {
    const ctrl = barControl({ id: 'set_model', visibleWhenState: ['idle'] })
    expect(isControlVisibleForState(ctrl, undefined)).toBe(true)
    expect(isControlVisibleForState(ctrl, 'some_future_status')).toBe(true)
  })
})

describe('getVisibleBarControls with currentStatus', () => {
  it('hides idle-gated controls during generating but keeps ungated ones', () => {
    const controls: ProviderControlSchema[] = [
      barControl({ id: 'set_model', visibleWhenState: ['idle'], order: 1 }),
      barControl({ id: 'stop', type: 'action', visibleWhenState: ['busy'], order: 0 }),
      barControl({ id: 'thinking', type: 'toggle', order: 2 }),
    ]

    // Use a providerType not in HIDE_BAR_CONTROL_IDS_BY_PROVIDER so the
    // visibleWhenState gating is what we're exercising (claude-cli separately
    // hides 'stop' from the bar entirely).
    const idle = getVisibleBarControls(controls, { providerType: 'hermes-cli', currentStatus: 'idle' })
    expect(idle.map(c => c.id)).toEqual(['set_model', 'thinking'])

    const generating = getVisibleBarControls(controls, { providerType: 'hermes-cli', currentStatus: 'generating' })
    expect(generating.map(c => c.id)).toEqual(['stop', 'thinking'])
  })

  it('falls back to showing all gated controls when status is omitted', () => {
    const controls: ProviderControlSchema[] = [
      barControl({ id: 'set_model', visibleWhenState: ['idle'], order: 1 }),
      barControl({ id: 'stop', type: 'action', visibleWhenState: ['busy'], order: 0 }),
    ]
    const all = getVisibleBarControls(controls, { providerType: 'hermes-cli' })
    expect(all.map(c => c.id)).toEqual(['stop', 'set_model'])
  })
})

describe('pruneServerReportedLocalValues', () => {
  it('keeps committed values the server never reports back (no stale revert)', () => {
    // claude-cli's model picker has no daemon-side readback, so controlValues
    // never carries set_model — the committed selection must stay sticky.
    const local = { set_model: 'opus' }
    const next = pruneServerReportedLocalValues(local, {})
    expect(next).toBe(local)
    expect(next.set_model).toBe('opus')
  })

  it('drops entries the server now reports authoritatively', () => {
    const local = { set_model: 'opus', thinking: true }
    const next = pruneServerReportedLocalValues(local, { thinking: false })
    expect(next).not.toBe(local)
    expect(next).toEqual({ set_model: 'opus' })
  })

  it('returns the same reference when nothing is dropped', () => {
    const local = { set_model: 'opus' }
    expect(pruneServerReportedLocalValues(local, { other: 'x' })).toBe(local)
  })
})
