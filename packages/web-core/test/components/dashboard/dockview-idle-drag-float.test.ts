import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DOCKVIEW_IDLE_DRAG_FLOAT_DELAY_MS,
  createDockviewIdleDragFloatController,
} from '../../../src/components/dashboard/dockviewIdleDragFloat'

afterEach(() => {
  vi.useRealTimers()
})

describe('dockview idle drag float controller', () => {
  it('detaches after 500ms with no dock target', () => {
    vi.useFakeTimers()
    const detached: Array<{ panelId: string; clientX: number; clientY: number }> = []
    const controller = createDockviewIdleDragFloatController({
      detachDelayMs: DOCKVIEW_IDLE_DRAG_FLOAT_DELAY_MS,
      onDetach: event => detached.push(event),
    })

    controller.startDrag({ panelId: 'tab-1', clientX: 10, clientY: 20 })
    controller.markNoDropTarget({ clientX: 120, clientY: 140 })

    vi.advanceTimersByTime(499)
    expect(detached).toEqual([])

    vi.advanceTimersByTime(1)
    expect(detached).toEqual([{ panelId: 'tab-1', clientX: 120, clientY: 140 }])

  })

  it('cancels the pending detach while a dock target is visible', () => {
    vi.useFakeTimers()
    const detached: Array<{ panelId: string; clientX: number; clientY: number }> = []
    const controller = createDockviewIdleDragFloatController({
      detachDelayMs: DOCKVIEW_IDLE_DRAG_FLOAT_DELAY_MS,
      onDetach: event => detached.push(event),
    })

    controller.startDrag({ panelId: 'tab-1', clientX: 10, clientY: 20 })
    controller.markNoDropTarget({ clientX: 120, clientY: 140 })
    vi.advanceTimersByTime(250)

    controller.markDockTarget({ clientX: 130, clientY: 150 })
    vi.advanceTimersByTime(500)
    expect(detached).toEqual([])

    controller.markNoDropTarget({ clientX: 200, clientY: 220 })
    vi.advanceTimersByTime(500)
    expect(detached).toEqual([{ panelId: 'tab-1', clientX: 200, clientY: 220 }])

  })

  it('does not detach after the drag ends', () => {
    vi.useFakeTimers()
    const detached: Array<{ panelId: string; clientX: number; clientY: number }> = []
    const controller = createDockviewIdleDragFloatController({
      detachDelayMs: DOCKVIEW_IDLE_DRAG_FLOAT_DELAY_MS,
      onDetach: event => detached.push(event),
    })

    controller.startDrag({ panelId: 'tab-1', clientX: 10, clientY: 20 })
    controller.markNoDropTarget({ clientX: 120, clientY: 140 })
    controller.endDrag()
    vi.advanceTimersByTime(500)

    expect(detached).toEqual([])

  })
})
