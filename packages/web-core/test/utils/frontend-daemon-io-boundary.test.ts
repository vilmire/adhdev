import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

describe('frontend daemon IO boundary', () => {
  it('does not keep browser-local pending chat or system-message ledgers in dashboard command hooks', () => {
    const conversationCommands = readSource('hooks/useDashboardConversationCommands.ts')
    const sessionCommands = readSource('hooks/useDashboardSessionCommands.ts')
    const eventManagerHook = readSource('hooks/useDashboardEventManager.ts')

    expect(conversationCommands).not.toContain('setLocalUserMessages')
    expect(conversationCommands).not.toContain('useLocalPendingMessage')
    expect(conversationCommands).not.toContain("const userMsg =")
    expect(sessionCommands).not.toContain('setLocalUserMessages')
    expect(eventManagerHook).not.toContain('setLocalUserMessages')
    expect(eventManagerHook).not.toContain('onSystemMessage(')
    expect(eventManagerHook).not.toContain('onClearSystemMessage(')
  })

  it('does not keep dashboard-level localUserMessages state once transcript ownership is daemon-side', () => {
    const dashboardPage = readSource('pages/Dashboard.tsx')
    expect(dashboardPage).not.toContain('localUserMessages')
    expect(dashboardPage).not.toContain('setLocalUserMessages')
  })
})
