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

  it('renders providers in the saved order even when none are detected on this machine, tagged as unavailable', () => {
    // Saved order references providers that are NOT in availableProviders (e.g.
    // this machine detects nothing). The full order must still render as
    // reorderable rows — not collapse into a warning banner — so the operator
    // can see and keep their configured order.
    const html = renderToStaticMarkup(
      React.createElement(ProviderPriorityEditor, {
        value: ['claude-cli', 'antigravity-cli'],
        availableProviders: [],
        onChange: () => {},
      }),
    )

    expect(html).toContain('claude-cli')
    expect(html).toContain('antigravity-cli')
    // Each undetected row is tagged, not hidden.
    expect(html).toContain('not on this machine')
    // Reorder controls still render for the undetected rows.
    expect(html).toContain('aria-label="Move up"')
    expect(html).toContain('aria-label="Move down"')
    // The old "no providers detected" warning banner is gone.
    expect(html).not.toContain('has no providers')
  })

  it('shows the empty-config warning only when the saved order is genuinely empty', () => {
    const html = renderToStaticMarkup(
      React.createElement(ProviderPriorityEditor, {
        value: [],
        availableProviders: [],
        onChange: () => {},
      }),
    )
    expect(html).toContain('No provider priority configured')
  })
})
