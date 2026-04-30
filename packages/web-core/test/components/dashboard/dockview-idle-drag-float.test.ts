import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DOCKVIEW_IDLE_DRAG_FLOAT_DELAY_MS,
  DOCKVIEW_IDLE_DRAG_FLOAT_STILLNESS_THRESHOLD_PX,
  createDockviewIdleDragFloatController,
} from '../../../src/components/dashboard/dockviewIdleDragFloat'

const selfPanelBounds = {
  left: 100,
  right: 500,
  top: 80,
  bottom: 420,
}

afterEach(() => {
  vi.useRealTimers()
})

describe('dockview idle drag float controller', () => {
  it('detaches after 1s of near-still movement inside the original panel bounds', () => {
    vi.useFakeTimers()
    const detached: Array<{ panelId: string; clientX: number; clientY: number }> = []
    const controller = createDockviewIdleDragFloatController({
      detachDelayMs: DOCKVIEW_IDLE_DRAG_FLOAT_DELAY_MS,
      stillnessThresholdPx: DOCKVIEW_IDLE_DRAG_FLOAT_STILLNESS_THRESHOLD_PX,
      onDetach: event => detached.push(event),
    })

    controller.startDrag({ panelId: 'tab-1', clientX: 120, clientY: 140, selfPanelBounds })
    controller.markSelfPanel({ clientX: 120, clientY: 140 })

    vi.advanceTimersByTime(999)
    expect(detached).toEqual([])

    controller.markSelfPanel({
      clientX: 120 + DOCKVIEW_IDLE_DRAG_FLOAT_STILLNESS_THRESHOLD_PX,
      clientY: 140,
    })
    vi.advanceTimersByTime(1)
    expect(detached).toEqual([{
      panelId: 'tab-1',
      clientX: 120 + DOCKVIEW_IDLE_DRAG_FLOAT_STILLNESS_THRESHOLD_PX,
      clientY: 140,
    }])
  })

  it('does not detach while the pointer is outside the original panel bounds', () => {
    vi.useFakeTimers()
    const detached: Array<{ panelId: string; clientX: number; clientY: number }> = []
    const controller = createDockviewIdleDragFloatController({
      detachDelayMs: DOCKVIEW_IDLE_DRAG_FLOAT_DELAY_MS,
      stillnessThresholdPx: DOCKVIEW_IDLE_DRAG_FLOAT_STILLNESS_THRESHOLD_PX,
      onDetach: event => detached.push(event),
    })

    controller.startDrag({ panelId: 'tab-1', clientX: 120, clientY: 140, selfPanelBounds })
    controller.markSelfPanel({ clientX: 120, clientY: 140 })
    vi.advanceTimersByTime(500)

    controller.markNonSelfPanel({ clientX: 520, clientY: 140 })
    vi.advanceTimersByTime(1000)
    expect(detached).toEqual([])

    controller.markSelfPanel({ clientX: 200, clientY: 220 })
    vi.advanceTimersByTime(1000)
    expect(detached).toEqual([{ panelId: 'tab-1', clientX: 200, clientY: 220 }])
  })

  it('cancels the pending detach while a dock target is visible', () => {
    vi.useFakeTimers()
    const detached: Array<{ panelId: string; clientX: number; clientY: number }> = []
    const controller = createDockviewIdleDragFloatController({
      detachDelayMs: DOCKVIEW_IDLE_DRAG_FLOAT_DELAY_MS,
      stillnessThresholdPx: DOCKVIEW_IDLE_DRAG_FLOAT_STILLNESS_THRESHOLD_PX,
      onDetach: event => detached.push(event),
    })

    controller.startDrag({ panelId: 'tab-1', clientX: 120, clientY: 140, selfPanelBounds })
    controller.markSelfPanel({ clientX: 120, clientY: 140 })
    vi.advanceTimersByTime(500)

    controller.markDockTarget({ clientX: 130, clientY: 150 })
    vi.advanceTimersByTime(1000)
    expect(detached).toEqual([])

    controller.markSelfPanel({ clientX: 200, clientY: 220 })
    vi.advanceTimersByTime(1000)
    expect(detached).toEqual([{ panelId: 'tab-1', clientX: 200, clientY: 220 }])
  })

  it('does not detach after the drag ends', () => {
    vi.useFakeTimers()
    const detached: Array<{ panelId: string; clientX: number; clientY: number }> = []
    const controller = createDockviewIdleDragFloatController({
      detachDelayMs: DOCKVIEW_IDLE_DRAG_FLOAT_DELAY_MS,
      stillnessThresholdPx: DOCKVIEW_IDLE_DRAG_FLOAT_STILLNESS_THRESHOLD_PX,
      onDetach: event => detached.push(event),
    })

    controller.startDrag({ panelId: 'tab-1', clientX: 120, clientY: 140, selfPanelBounds })
    controller.markSelfPanel({ clientX: 120, clientY: 140 })
    controller.endDrag()
    vi.advanceTimersByTime(1000)

    expect(detached).toEqual([])
  })

  it('restarts the 1s stillness window when pointer movement exceeds the jitter threshold inside the original panel', () => {
    vi.useFakeTimers()
    const detached: Array<{ panelId: string; clientX: number; clientY: number }> = []
    const controller = createDockviewIdleDragFloatController({
      detachDelayMs: DOCKVIEW_IDLE_DRAG_FLOAT_DELAY_MS,
      stillnessThresholdPx: DOCKVIEW_IDLE_DRAG_FLOAT_STILLNESS_THRESHOLD_PX,
      onDetach: event => detached.push(event),
    })

    controller.startDrag({ panelId: 'tab-1', clientX: 120, clientY: 140, selfPanelBounds })
    controller.markSelfPanel({ clientX: 120, clientY: 140 })
    vi.advanceTimersByTime(700)

    controller.markSelfPanel({
      clientX: 121 + DOCKVIEW_IDLE_DRAG_FLOAT_STILLNESS_THRESHOLD_PX,
      clientY: 140,
    })
    vi.advanceTimersByTime(999)
    expect(detached).toEqual([])

    vi.advanceTimersByTime(1)
    expect(detached).toEqual([{
      panelId: 'tab-1',
      clientX: 121 + DOCKVIEW_IDLE_DRAG_FLOAT_STILLNESS_THRESHOLD_PX,
      clientY: 140,
    }])
  })
})
