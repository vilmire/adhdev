import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

describe('dashboard desktop auto-read boundary', () => {
  it('keeps desktop auto-read timer and daemon mark-seen orchestration out of Dashboard root', () => {
    const dashboardSource = readSource('pages/Dashboard.tsx')
    const hookSource = readSource('hooks/useDashboardDesktopAutoRead.ts')

    expect(dashboardSource).toContain('useDashboardDesktopAutoRead({')
    expect(dashboardSource).not.toContain('pendingDesktopAutoReadTimerRef')
    expect(dashboardSource).not.toContain('pendingDesktopAutoReadVisibleTimerRef')
    expect(dashboardSource).not.toContain('pendingDesktopAutoReadVisibilityHandlerRef')
    expect(dashboardSource).not.toContain("'mark_session_seen'")

    expect(hookSource).toContain('getDesktopAutoReadPlan')
    expect(hookSource).toContain('getDesktopAutoReadScheduleDecision')
    expect(hookSource).toContain("'mark_session_seen'")
  })
})
