import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

describe('dashboard pending launch boundary cleanup', () => {
  it('moves pending launch tracking and matching effects out of Dashboard root into a dedicated hook', () => {
    const dashboardSource = readSource('pages/Dashboard.tsx')

    expect(dashboardSource).not.toContain('interface PendingDashboardLaunch')
    expect(dashboardSource).not.toContain('const [pendingDashboardLaunch')
    expect(dashboardSource).not.toContain('setPendingDashboardLaunch(')
    expect(dashboardSource).not.toContain('function getRouteMachineId(')
    expect(dashboardSource).not.toContain('function normalizeWorkspacePath(')
    expect(dashboardSource).toContain('useDashboardPendingLaunch(')
  })
})
