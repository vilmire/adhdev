import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('DashboardDockviewWorkspace Dockview idle drag floating behavior', () => {
  it('only wires the delayed no-target detach controller for ordinary tab drags', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/dashboard/DashboardDockviewWorkspace.tsx'),
      'utf8',
    )

    expect(source).toContain('createDockviewIdleDragFloatController')
    expect(source).toContain('DOCKVIEW_IDLE_DRAG_FLOAT_DELAY_MS')
    expect(source).toContain('.onWillDragPanel')
    expect(source).toContain('.onUnhandledDragOverEvent')
    expect(source).not.toContain('dockviewDragDetach')
    expect(source).not.toContain('inDragMode: true')
  })

  it('does not patch or remove Dockview native drop target overlays', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/dashboard/DashboardDockviewWorkspace.tsx'),
      'utf8',
    )
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

    expect(source).not.toContain('data-adhdev-force-hidden')
    expect(source).not.toContain('removeDockviewOverlayNodes')
    expect(css).not.toContain('is-showing-dockview-overlay')
    expect(css).not.toContain('data-adhdev-force-hidden')
  })
})
