import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

function readSource(relativePath: string): string {
  return readFileSync(resolve(__dirname, '../../src', relativePath), 'utf8')
}

describe('dashboard auto-read mark_session_seen payload', () => {
  it('passes the live completion marker observed by desktop auto-read to the daemon', () => {
    const source = readSource('pages/Dashboard.tsx')
    const commandIndex = source.indexOf("'mark_session_seen'")
    expect(commandIndex).toBeGreaterThan(-1)
    const payload = source.slice(commandIndex, commandIndex + 320)

    expect(payload).toContain('sessionId: activeConv.sessionId')
    expect(payload).toContain('providerSessionId: activeConv.providerSessionId')
    expect(payload).toContain('seenAt: readAt')
    expect(payload).toContain('completionMarker: autoReadPlan.completionMarker')
  })

  it('passes the live completion marker observed by mobile chat read handling to the daemon', () => {
    const source = readSource('components/dashboard/useDashboardMobileChatEffects.ts')
    const commandIndex = source.indexOf("'mark_session_seen'")
    expect(commandIndex).toBeGreaterThan(-1)
    const payload = source.slice(commandIndex, commandIndex + 320)

    expect(payload).toContain('sessionId: conversation.sessionId')
    expect(payload).toContain('providerSessionId: conversation.providerSessionId')
    expect(payload).toContain('seenAt: readAt')
    expect(payload).toContain('completionMarker: liveState.completionMarker')
  })
})
