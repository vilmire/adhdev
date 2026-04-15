import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import SavedHistoryLaunchSection from '../../src/components/SavedHistoryLaunchSection'

function renderSection(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    React.createElement(SavedHistoryLaunchSection, {
      busy: false,
      savedSessionsLoading: false,
      savedSessionsError: '',
      selectedSession: null,
      onRefresh: () => {},
      onOpenHistory: () => {},
      onClearSelection: () => {},
      ...overrides,
    }),
  )
}

describe('SavedHistoryLaunchSection', () => {
  it('gives both launch surfaces the same simplified saved-history entrypoint', () => {
    const html = renderSection()

    expect(html).toContain('Saved history')
    expect(html).toContain('Open saved history')
    expect(html).toContain('Start fresh, or open saved history when you want continuity.')
    expect(html).not.toContain('Resume-ready only')
    expect(html).not.toContain('Search title or preview')
    expect(html).not.toContain('<select')
  })

  it('shows the same compact selected-history summary regardless of entry surface', () => {
    const html = renderSection({
      selectedSession: {
        title: 'Unify saved history launch section',
        providerSessionId: 'shared-sess-7',
        workspace: '/workspaces/adhdev',
        summaryMetadata: {
          items: [{ id: 'model', label: 'Model', value: 'gpt-5.4', order: 10 }],
        },
        messageCount: 9,
        lastMessageAt: 1711111111111,
        preview: 'Use one shared component for dashboard and machine launch flows.',
      },
    })

    expect(html).toContain('Selected saved history')
    expect(html).toContain('Unify saved history launch section')
    expect(html).toContain('shared-sess-7')
    expect(html).toContain('/workspaces/adhdev')
    expect(html).toContain('gpt-5.4')
    expect(html).toContain('9 msgs')
    expect(html).toContain('Clear')
  })
})
