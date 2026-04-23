import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

describe('dashboard notifications utils daemon authority', () => {
  it('does not keep browser-local overlay persistence helpers in notification utils', () => {
    const source = readSource('utils/dashboard-notifications.ts')

    expect(source).not.toContain('localStorage')
    expect(source).not.toContain('DashboardNotificationOverlayRecord')
    expect(source).not.toContain('forceUnread')
    expect(source).not.toContain('readDashboardNotificationOverlays')
    expect(source).not.toContain('writeDashboardNotificationOverlays')
    expect(source).not.toContain('applyDashboardNotificationOverlays')
    expect(source).not.toContain('reduceDashboardNotificationOverlays')
  })

  it('does not keep unused local notification reducer/mutation helpers in utils', () => {
    const source = readSource('utils/dashboard-notifications.ts')

    expect(source).not.toContain('reduceDashboardNotifications(')
    expect(source).not.toContain('markDashboardNotificationRead(')
    expect(source).not.toContain('markDashboardNotificationUnread(')
    expect(source).not.toContain('markDashboardNotificationTargetRead(')
    expect(source).not.toContain('deleteDashboardNotification(')
    expect(source).not.toContain('buildDashboardNotificationStateBySessionId(')
  })
})
