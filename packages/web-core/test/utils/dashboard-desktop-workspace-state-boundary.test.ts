import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

describe('dashboard desktop workspace state boundary cleanup', () => {
  it('moves desktop active-tab and scroll-to-bottom orchestration out of Dashboard root into a dedicated hook', () => {
    const dashboardSource = readSource('pages/Dashboard.tsx')

    expect(dashboardSource).not.toContain('const [desktopActiveTabKey')
    expect(dashboardSource).not.toContain('const [scrollToBottomRequest')
    expect(dashboardSource).not.toContain('const handleOpenDesktopConversation')
    expect(dashboardSource).not.toContain('const requestScrollToBottom')
    expect(dashboardSource).not.toContain('buildDashboardScrollToBottomRequest(')
    expect(dashboardSource).toContain('useDashboardDesktopWorkspaceState(')
  })

  it('uses intent-style desktop tab selection callbacks instead of exposing React state dispatch types through main view props', () => {
    const mainViewSource = readSource('components/dashboard/DashboardMainView.tsx')

    expect(mainViewSource).not.toContain('onDesktopActiveTabChange: React.Dispatch<React.SetStateAction<string | null>>')
  })
})
