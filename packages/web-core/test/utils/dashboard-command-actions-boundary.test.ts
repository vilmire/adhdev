import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

describe('dashboard command action boundary cleanup', () => {
  it('moves dashboard-level notification, machine launch, and cli view-mode handlers out of Dashboard root into dedicated hooks', () => {
    const dashboardSource = readSource('pages/Dashboard.tsx')

    expect(dashboardSource).not.toContain('const handleMarkDashboardNotificationRead')
    expect(dashboardSource).not.toContain('const handleMarkDashboardNotificationUnread')
    expect(dashboardSource).not.toContain('const handleDeleteDashboardNotification')
    expect(dashboardSource).not.toContain('const handleBrowseMachineDirectory')
    expect(dashboardSource).not.toContain('const handleSaveMachineWorkspace')
    expect(dashboardSource).not.toContain('const handleLaunchMachineIde')
    expect(dashboardSource).not.toContain('const handleLaunchMachineProvider')
    expect(dashboardSource).not.toContain('const handleListMachineSavedSessions')
    expect(dashboardSource).not.toContain('const setActiveCliViewMode')
    expect(dashboardSource).toContain('useDashboardNotificationActions(')
    expect(dashboardSource).toContain('useDashboardCommandActions(')
  })
})
