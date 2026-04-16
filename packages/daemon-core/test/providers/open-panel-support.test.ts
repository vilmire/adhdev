import { describe, expect, it } from 'vitest'
import { getProviderSessionCapabilities, providerHasOpenPanelSupport } from '../../src/providers/open-panel-support.js'

describe('open panel provider support helpers', () => {
  it('detects explicit openPanel support from extension and ide provider scripts', () => {
    expect(providerHasOpenPanelSupport({
      category: 'extension',
      scripts: {
        openPanel: () => '(() => JSON.stringify({ opened: true, visible: true }))()',
      },
    } as any)).toBe(true)

    expect(providerHasOpenPanelSupport({
      category: 'ide',
      scripts: {
        webviewOpenPanel: () => '(() => JSON.stringify({ opened: true, visible: true }))()',
      },
    } as any)).toBe(true)

    expect(providerHasOpenPanelSupport({
      category: 'ide',
      scripts: {
        focusEditor: () => '(() => JSON.stringify({ focused: true }))()',
      },
    } as any)).toBe(false)
  })

  it('only adds open_panel to session capabilities when provider scripts actually support it', () => {
    expect(getProviderSessionCapabilities({
      category: 'extension',
      scripts: {
        focusEditor: () => '(() => JSON.stringify({ focused: true }))()',
      },
    } as any, ['read_chat', 'send_message'])).not.toContain('open_panel')

    expect(getProviderSessionCapabilities({
      category: 'extension',
      scripts: {
        openPanel: () => '(() => JSON.stringify({ opened: true, visible: true }))()',
      },
    } as any, ['read_chat', 'send_message'])).toContain('open_panel')
  })
})
