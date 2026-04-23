import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

describe('dashboard main view ui-state boundary cleanup', () => {
  it('moves local desktop chrome state out of DashboardMainView into a dedicated hook', () => {
    const mainViewSource = readSource('components/dashboard/DashboardMainView.tsx')

    expect(mainViewSource).not.toContain('const [inboxOpen')
    expect(mainViewSource).not.toContain('const [hiddenOpen')
    expect(mainViewSource).not.toContain('const [shortcutHelpOpen')
    expect(mainViewSource).not.toContain('const [newSessionOpen')
    expect(mainViewSource).not.toContain('const [guideNudgeVisible')
    expect(mainViewSource).not.toContain('const [guideTab')
    expect(mainViewSource).not.toContain('const [shortcutSection')
    expect(mainViewSource).toContain('useDashboardMainViewUiState(')
  })
})
