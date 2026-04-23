import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

describe('dashboard notifications command-only runtime', () => {
  it('does not keep no-op browser-local notification mutation helpers in the notifications hook', () => {
    const source = readSource('hooks/useDashboardNotifications.ts')

    expect(source).not.toContain('const markRead =')
    expect(source).not.toContain('const markUnread =')
    expect(source).not.toContain('const markTargetRead =')
    expect(source).not.toContain('const remove =')
    expect(source).not.toContain('deleteNotification: remove')
  })

  it('does not call frontend-local notification mutation helpers before sending daemon commands', () => {
    const source = readSource('pages/Dashboard.tsx')

    expect(source).not.toContain('markDashboardNotificationRead(')
    expect(source).not.toContain('markDashboardNotificationUnread(')
    expect(source).not.toContain('markDashboardNotificationTargetRead(')
    expect(source).not.toContain('deleteDashboardNotification(')
  })
})
