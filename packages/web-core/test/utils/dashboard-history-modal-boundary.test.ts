import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

describe('dashboard history modal boundary cleanup', () => {
  it('moves saved-history and history-modal orchestration out of Dashboard root into a dedicated hook', () => {
    const dashboardSource = readSource('pages/Dashboard.tsx')

    expect(dashboardSource).not.toContain('const [historyModalOpen')
    expect(dashboardSource).not.toContain('const [savedHistorySessions')
    expect(dashboardSource).not.toContain('const [isSavedHistoryLoading')
    expect(dashboardSource).not.toContain('const [resumingSavedHistorySessionId')
    expect(dashboardSource).not.toContain('savedHistoryRefreshKeyRef')
    expect(dashboardSource).not.toContain('const handleRefreshSavedHistory')
    expect(dashboardSource).not.toContain('const handleResumeSavedHistorySession')
    expect(dashboardSource).toContain('useDashboardHistoryModalState(')
  })
})
