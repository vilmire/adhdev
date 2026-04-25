import { describe, expect, it } from 'vitest'
import { getPaneGroupContentChildVisibility } from '../../../src/components/dashboard/PaneGroupContent'

describe('PaneGroupContent child visibility propagation', () => {
  it('treats omitted parent visibility as visible for legacy pane callers', () => {
    expect(getPaneGroupContentChildVisibility(undefined, true)).toBe(true)
    expect(getPaneGroupContentChildVisibility(undefined, false)).toBe(false)
  })

  it('forces dockview-hidden conversation panels to report child panes as hidden', () => {
    expect(getPaneGroupContentChildVisibility(false, true)).toBe(false)
    expect(getPaneGroupContentChildVisibility(false, false)).toBe(false)
  })

  it('allows visible dockview panels to use the local chat/terminal visibility state', () => {
    expect(getPaneGroupContentChildVisibility(true, true)).toBe(true)
    expect(getPaneGroupContentChildVisibility(true, false)).toBe(false)
  })
})
