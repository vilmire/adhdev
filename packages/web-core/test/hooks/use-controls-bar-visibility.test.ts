import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getStoredControlsBarVisibility } from '../../src/hooks/useControlsBarVisibility'

describe('useControlsBarVisibility', () => {
  it('defaults to hidden when storage is unavailable or unreadable', () => {
    expect(getStoredControlsBarVisibility(null)).toBe(false)
    expect(getStoredControlsBarVisibility({ getItem: () => { throw new Error('blocked') } })).toBe(false)
  })

  it('does not emit cross-component visibility events from inside a React state updater', () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, '../../src/hooks/useControlsBarVisibility.ts'),
      'utf8',
    )
    const toggleBody = source.match(/const toggleVisibility = useCallback\(\(\) => \{([\s\S]*?)\n    \}, \[/)?.[1] || ''

    expect(toggleBody).not.toContain('setIsVisible(current =>')
    expect(toggleBody).not.toContain('emitControlsBarVisibilityChange(next)')
  })
})
