import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

describe('dashboard split-view boundary cleanup', () => {
  it('does not thread raw group layout React setters into split-view orchestration', () => {
    const dashboardSource = readSource('pages/Dashboard.tsx')
    const splitViewSource = readSource('hooks/useDashboardSplitView.ts')

    expect(dashboardSource).not.toContain('setGroupAssignments,')
    expect(dashboardSource).not.toContain('setFocusedGroup,')
    expect(dashboardSource).not.toContain('setGroupActiveTabIds,')
    expect(dashboardSource).not.toContain('setGroupTabOrders,')
    expect(dashboardSource).not.toContain('setGroupSizes,')

    expect(splitViewSource).not.toContain('setGroupAssignments:')
    expect(splitViewSource).not.toContain('setFocusedGroup:')
    expect(splitViewSource).not.toContain('setGroupActiveTabIds:')
    expect(splitViewSource).not.toContain('setGroupTabOrders:')
    expect(splitViewSource).not.toContain('setGroupSizes:')
  })
})
