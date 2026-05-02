import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

describe('frontend daemon IO boundary', () => {
  it('does not keep browser-local pending chat or system-message ledgers in dashboard command hooks', () => {
    const conversationCommands = readSource('hooks/useDashboardConversationCommands.ts')
    const sessionCommands = readSource('hooks/useDashboardSessionCommands.ts')
    const eventManagerHook = readSource('hooks/useDashboardEventManager.ts')
    const eventManager = readSource('managers/EventManager.ts')

    expect(conversationCommands).not.toContain('setLocalUserMessages')
    expect(conversationCommands).not.toContain('useLocalPendingMessage')
    expect(conversationCommands).not.toContain("const userMsg =")
    expect(sessionCommands).not.toContain('setLocalUserMessages')
    for (const source of [eventManagerHook, eventManager]) {
      expect(source).not.toContain('localUserMessages')
      expect(source).not.toContain('setLocalUserMessages')
      expect(source).not.toContain('onSystemMessage(')
      expect(source).not.toContain('onClearSystemMessage(')
    }
  })

  it('does not keep dashboard-level localUserMessages state once transcript ownership is daemon-side', () => {
    const dashboardPage = readSource('pages/Dashboard.tsx')
    expect(dashboardPage).not.toContain('localUserMessages')
    expect(dashboardPage).not.toContain('setLocalUserMessages')
  })

  it('useWorkspaceGitStatus uses sendCommand transport, not native fetch', () => {
    const hookSource = readSource('hooks/useWorkspaceGitStatus.ts')
    // Must use sendCommand from transport context
    expect(hookSource).toContain('sendCommand')
    // Must not use native fetch directly
    expect(hookSource).not.toContain('fetch(')
    expect(hookSource).not.toContain('XMLHttpRequest')
  })

  it('useWorkspaceGitStatus does not infer git state from text parsing (no transcript scraping)', () => {
    const hookSource = readSource('hooks/useWorkspaceGitStatus.ts')
    // Must not contain patterns that would parse text transcript to infer git state
    expect(hookSource).not.toMatch(/\.includes\(['"]modified['"]\)/)
    expect(hookSource).not.toMatch(/\.includes\(['"]untracked['"]\)/)
    expect(hookSource).not.toMatch(/\.match\(\/\\+\\d\+\/\)/)
    expect(hookSource).not.toMatch(/parseInt.*transcript/)
    // Must read structured fields from daemon response, not raw strings
    expect(hookSource).toContain('body.status')
    expect(hookSource).toContain('body.diffSummary')
  })

  it('GitStatusDialog sends git_diff_file via sendCommand, not fetch', () => {
    const dialogSource = readSource('components/git/GitStatusDialog.tsx')
    // Must use sendCommand for all git operations
    expect(dialogSource).toContain("sendCommand(daemonId, 'git_diff_file'")
    // Must not bypass the transport layer
    expect(dialogSource).not.toContain('fetch(')
    expect(dialogSource).not.toContain('XMLHttpRequest')
  })
})
