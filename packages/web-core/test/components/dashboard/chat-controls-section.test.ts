import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ProviderControlSchema } from '@adhdev/daemon-core'
import ChatControlsSection from '../../../src/components/dashboard/ChatControlsSection'
import { getStoredControlsBarVisibility } from '../../../src/hooks/useControlsBarVisibility'

describe('ChatControlsSection visibility preference', () => {
  it('defaults to hiding the controls bar until the user opts in', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatControlsSection, {
        routeId: 'daemon-1',
        providerType: 'codex',
        displayLabel: 'Codex',
        isActive: true,
        isCliTerminal: false,
        controls: [
          {
            id: 'reasoning_mode',
            type: 'select',
            label: 'Reasoning mode',
            placement: 'bar',
          } satisfies ProviderControlSchema,
        ],
        controlValues: { reasoning_mode: 'high' },
      }),
    )

    expect(html).toBe('')
    expect(html).not.toContain('Reasoning mode')
    expect(html).not.toContain('high')
  })

  it('does not render a toggle when there are no visible bar controls', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChatControlsSection, {
        routeId: 'daemon-1',
        providerType: 'codex',
        displayLabel: 'Codex',
        isActive: true,
        isCliTerminal: false,
        controls: [
          {
            id: 'reasoning_mode',
            type: 'select',
            label: 'Reasoning mode',
            placement: 'menu',
          } satisfies ProviderControlSchema,
        ],
        controlValues: { reasoning_mode: 'high' },
      }),
    )

    expect(html).toBe('')
  })

  it('defaults to hidden and restores a stored visible preference', () => {
    const hiddenStorage = {
      getItem: () => null,
    }
    const visibleStorage = {
      getItem: () => '1',
    }

    expect(getStoredControlsBarVisibility(hiddenStorage)).toBe(false)
    expect(getStoredControlsBarVisibility(visibleStorage)).toBe(true)
  })
})
