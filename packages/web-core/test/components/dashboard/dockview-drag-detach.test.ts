import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  getDockviewDragDetachFloatingOptions,
  shouldDetachDockviewTabDrag,
} from '../../../src/components/dashboard/dockviewDragDetach'

describe('shouldDetachDockviewTabDrag', () => {
  it('turns an ordinary grid tab drag into a floating-panel drag', () => {
    expect(shouldDetachDockviewTabDrag({
      isDefaultPrevented: false,
      locationType: 'grid',
      groupPanelCount: 2,
    })).toBe(true)
  })

  it('does not re-detach the last tab of an already-floating panel', () => {
    expect(shouldDetachDockviewTabDrag({
      isDefaultPrevented: false,
      locationType: 'floating',
      groupPanelCount: 1,
    })).toBe(false)
  })

  it('respects dockview or browser drag cancellation', () => {
    expect(shouldDetachDockviewTabDrag({
      isDefaultPrevented: true,
      locationType: 'grid',
      groupPanelCount: 2,
    })).toBe(false)
  })
})

describe('getDockviewDragDetachFloatingOptions', () => {
  it('positions the floating panel under the dragged tab inside the dockview root', () => {
    expect(getDockviewDragDetachFloatingOptions({
      rootRect: { left: 100, top: 50 },
      tabRect: { left: 260, top: 110, width: 180, height: 36 },
      defaultWidth: 600,
      defaultHeight: 500,
    })).toEqual({
      x: 160,
      y: 60,
      width: 600,
      height: 500,
      inDragMode: true,
    })
  })
})

describe('DashboardDockviewWorkspace drag-detach wiring', () => {
  it('converts dockview tab drag start into addFloatingGroup instead of relying on the context menu only', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/dashboard/DashboardDockviewWorkspace.tsx'),
      'utf8',
    )

    expect(source).toContain('event.api.onWillDragPanel(dragEvent => {')
    expect(source).toContain('shouldDetachDockviewTabDrag({')
    expect(source).toContain('getDockviewDragDetachFloatingOptions({')
    expect(source).toContain('event.api.addFloatingGroup(panel, floatingOptions)')
  })
})
