import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

describe('dashboard overlays history-filter boundary cleanup', () => {
  it('does not keep saved-history filter state inside DashboardOverlays once history modal state owns it', () => {
    const overlaysSource = readSource('components/dashboard/DashboardOverlays.tsx')

    expect(overlaysSource).not.toContain('createSavedHistoryFilterState')
    expect(overlaysSource).not.toContain('const [savedHistoryFilters')
    expect(overlaysSource).not.toContain('onSavedHistoryFiltersChange={setSavedHistoryFilters}')
  })
})
