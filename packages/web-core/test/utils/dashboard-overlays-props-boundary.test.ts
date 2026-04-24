import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

describe('dashboard overlays prop boundary cleanup', () => {
  it('groups overlay render-hub props by overlay surface instead of keeping one flat prop list', () => {
    const overlaysSource = readSource('components/dashboard/DashboardOverlays.tsx')
    const dashboardSource = readSource('pages/Dashboard.tsx')

    expect(overlaysSource).toContain('historyModal: {')
    expect(overlaysSource).toContain('remoteDialog: {')
    expect(overlaysSource).toContain('cliStopDialog: {')
    expect(overlaysSource).toContain('connectionBanner: {')
    expect(overlaysSource).toContain('toastOverlay: {')
    expect(overlaysSource).toContain('onboarding: {')

    expect(dashboardSource).toContain('<DashboardOverlays')
    expect(dashboardSource).toContain('historyModal={{')
    expect(dashboardSource).toContain('remoteDialog={{')
    expect(dashboardSource).toContain('cliStopDialog={{')
    expect(dashboardSource).toContain('connectionBanner={{')
    expect(dashboardSource).toContain('toastOverlay={{')
    expect(dashboardSource).toContain('onboarding={{')
    expect(dashboardSource).not.toContain('<ConnectionBanner')
    expect(dashboardSource).not.toContain('historyModalOpen={historyModalOpen}')
    expect(dashboardSource).not.toContain('remoteDialogConv={remoteDialogConv}')
    expect(dashboardSource).not.toContain('cliStopDialogOpen={cliStopDialogOpen}')
    expect(dashboardSource).not.toContain('showOnboarding={showOnboarding}')
  })
})
