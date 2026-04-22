import { describe, expect, it } from 'vitest'
import {
  getAutoCliTerminalScaleForViewport,
  getAutoCliTerminalScaleForWidth,
  shouldPreferFitCliTerminal,
} from '../../src/utils/cli-terminal-scale'

describe('cli terminal scale helpers', () => {
  it('starts mobile terminal view at the minimum zoom for phone-sized widths', () => {
    expect(getAutoCliTerminalScaleForWidth(360)).toBe(0.5)
    expect(getAutoCliTerminalScaleForWidth(390)).toBe(0.5)
    expect(getAutoCliTerminalScaleForWidth(430)).toBe(0.5)
    expect(getAutoCliTerminalScaleForWidth(480)).toBe(0.5)
  })

  it('keeps desktop-sized widths at the normal scale', () => {
    expect(getAutoCliTerminalScaleForWidth(481)).toBe(1)
    expect(getAutoCliTerminalScaleForWidth(1280)).toBe(1)
  })

  it('respects a custom minimum scale when callers lower the mobile floor', () => {
    expect(getAutoCliTerminalScaleForWidth(390, { minScale: 0.55 })).toBe(0.55)
  })

  it('scales measured terminals from the actual viewport instead of width-only mobile buckets', () => {
    expect(getAutoCliTerminalScaleForViewport(390, 640)).toBe(0.82)
    expect(getAutoCliTerminalScaleForViewport(390, 520)).toBe(0.68)
    expect(getAutoCliTerminalScaleForViewport(960, 720)).toBe(1)
  })

  it('prefers fit mode for narrow mobile and portrait panes', () => {
    expect(shouldPreferFitCliTerminal(390, 844)).toBe(true)
    expect(shouldPreferFitCliTerminal(640, 700)).toBe(true)
    expect(shouldPreferFitCliTerminal(900, 680)).toBe(false)
    expect(shouldPreferFitCliTerminal(820, 680)).toBe(false)
    expect(shouldPreferFitCliTerminal(700, 820)).toBe(false)
  })
})
