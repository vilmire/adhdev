import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import LaunchSectionCard from '../../src/components/LaunchSectionCard'

function renderCard(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    React.createElement(LaunchSectionCard, {
      title: 'Workspace',
      description: 'Saved workspace is preferred. Home and custom folders are still available.',
      action: React.createElement('button', { type: 'button' }, 'Browse…'),
      children: React.createElement('div', null, 'BODY'),
      ...overrides,
    }),
  )
}

describe('LaunchSectionCard', () => {
  it('renders the shared launch section framing used across dashboard and machine flows', () => {
    const html = renderCard()

    expect(html).toContain('Workspace')
    expect(html).toContain('Saved workspace is preferred. Home and custom folders are still available.')
    expect(html).toContain('Browse…')
    expect(html).toContain('BODY')
  })

  it('supports sections without description or action slots', () => {
    const html = renderCard({ description: undefined, action: undefined })

    expect(html).toContain('Workspace')
    expect(html).toContain('BODY')
    expect(html).not.toContain('Browse…')
  })
})
