import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

describe('dashboard overlay dialog boundary cleanup', () => {
  it('moves remote-dialog and cli-stop dialog orchestration out of Dashboard root into a dedicated hook', () => {
    const dashboardSource = readSource('pages/Dashboard.tsx')

    expect(dashboardSource).not.toContain('const [cliStopDialogOpen')
    expect(dashboardSource).not.toContain('const [cliStopTargetConv')
    expect(dashboardSource).not.toContain('useDashboardRemoteDialogState(')
    expect(dashboardSource).not.toContain('const performActiveCliStop')
    expect(dashboardSource).not.toContain('const handleActiveCliStop')
    expect(dashboardSource).toContain('useDashboardOverlayDialogsState(')
  })
})
