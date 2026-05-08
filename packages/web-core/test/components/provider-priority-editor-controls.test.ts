import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ProviderPriorityEditor from '../../src/components/provider-priority/ProviderPriorityEditor'
import type { AvailableCliProviderOption } from '../../src/utils/provider-priority'

const providers: AvailableCliProviderOption[] = [
  { type: 'hermes-cli', label: 'Hermes', statusLabel: 'Detected at /usr/local/bin/hermes' },
  { type: 'codex-cli', label: 'Codex', statusLabel: 'Detected at /usr/local/bin/codex' },
  { type: 'claude-cli', label: 'Claude Code', statusLabel: 'Detected at /usr/local/bin/claude' },
]

function renderEditor() {
  return renderToStaticMarkup(
    React.createElement(ProviderPriorityEditor, {
      value: ['hermes-cli', 'codex-cli', 'claude-cli'],
      availableProviders: providers,
      onChange: () => {},
    }),
  )
}

describe('ProviderPriorityEditor reorder controls', () => {
  it('keeps provider text readable while limiting reorder actions to compact icon-only up/down buttons', () => {
    const html = renderEditor()

    expect(html).toContain('hermes-cli')
    expect(html).toContain('Hermes · Detected at /usr/local/bin/hermes')
    expect(html).toContain('aria-label="Move up"')
    expect(html).toContain('title="Move up"')
    expect(html).toContain('aria-label="Move down"')
    expect(html).toContain('title="Move down"')
    expect(html).toContain('<svg')
    expect(html).not.toContain('>Top<')
    expect(html).not.toContain('>Bottom<')
    expect(html).not.toContain('>Up<')
    expect(html).not.toContain('>Down<')
  })

  it('still disables move-up on the first provider and move-down on the last provider', () => {
    const html = renderEditor()

    expect(html).toContain('aria-label="Move up" disabled=""')
    expect(html).toContain('aria-label="Move down" disabled=""')
  })
})
