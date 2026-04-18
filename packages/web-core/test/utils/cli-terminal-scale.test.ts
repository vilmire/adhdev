import { describe, expect, it } from 'vitest'
import { getAutoCliTerminalScaleForWidth } from '../../src/utils/cli-terminal-scale'

describe('cli terminal scale helpers', () => {
  it('starts mobile terminal view at the minimum zoom for phone-sized widths', () => {
    expect(getAutoCliTerminalScaleForWidth(360)).toBe(0.6)
    expect(getAutoCliTerminalScaleForWidth(390)).toBe(0.6)
    expect(getAutoCliTerminalScaleForWidth(430)).toBe(0.6)
    expect(getAutoCliTerminalScaleForWidth(480)).toBe(0.6)
  })

  it('keeps desktop-sized widths at the normal scale', () => {
    expect(getAutoCliTerminalScaleForWidth(481)).toBe(1)
    expect(getAutoCliTerminalScaleForWidth(1280)).toBe(1)
  })

  it('respects a custom minimum scale when callers lower the mobile floor', () => {
    expect(getAutoCliTerminalScaleForWidth(390, { minScale: 0.55 })).toBe(0.55)
  })
})
