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

  it('keeps dashboard message surfaces on daemon conversation state without snapshot overlay aliases', () => {
    const dashboardSource = readSource('pages/Dashboard.tsx')

    expect(dashboardSource).not.toContain('messageSnapshotConversations')
    expect(dashboardSource).not.toContain('messageSnapshotVisibleConversations')
    expect(dashboardSource).toContain('conversations,')
    expect(dashboardSource).toContain('visibleConversations,')
    expect(dashboardSource).toContain('visibleConversations={visibleConversations}')
    expect(dashboardSource).toContain('mobileChatConversations={mobileChatConversations}')
    expect(dashboardSource).not.toContain('applyConversationMessageSnapshots')
    expect(dashboardSource).not.toContain('warmChatTailSnapshots')
    expect(dashboardSource).not.toContain('inboxPreviewConversations')
    expect(dashboardSource).not.toContain('inboxPreviewVisibleConversations')
  })
})
