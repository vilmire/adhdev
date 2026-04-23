import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

describe('dashboard notifications daemon authority', () => {
  it('does not persist browser-local notification overlays once daemon notification state is authoritative', () => {
    const source = readSource('hooks/useDashboardNotifications.ts')

    expect(source).not.toContain('readDashboardNotificationOverlays')
    expect(source).not.toContain('writeDashboardNotificationOverlays')
    expect(source).not.toContain('notificationOverlays')
    expect(source).not.toContain('localStorage')
  })
})
