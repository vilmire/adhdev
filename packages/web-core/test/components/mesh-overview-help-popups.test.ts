import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MeshHelpPanel, MeshHelpToggle } from '../../src/components/MeshGraph/MeshHelpPanel'
import { getMeshGraphTheme } from '../../src/components/MeshGraph/meshGraphTheme'

// The per-card "?" help popovers were consolidated into a single MeshHelpPanel
// reachable from one "?" toggle in the dialog tab bar (oss 779dd8d3). These tests
// assert that consolidated help surface: one accessible toggle, and one panel that
// documents every mesh concept the end user needs to understand.
const meshTheme = getMeshGraphTheme('dark')

function renderToggle(open = false): string {
  return renderToStaticMarkup(
    React.createElement(MeshHelpToggle, { meshTheme, open, onToggle: () => {} }),
  )
}

function renderPanel(): string {
  return renderToStaticMarkup(
    React.createElement(MeshHelpPanel, { meshTheme, onClose: () => {} }),
  )
}

describe('Mesh consolidated help panel', () => {
  it('exposes a single accessible "?" help toggle', () => {
    const html = renderToggle()

    // One labelled, keyboard-focusable toggle carrying the help icon. It reports
    // its open/closed state for assistive tech.
    expect(html).toContain('aria-label="Mesh help"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('type="button"')
    expect(html).toContain('<svg')
  })

  it('reflects the open state on the toggle', () => {
    expect(renderToggle(true)).toContain('aria-expanded="true"')
  })

  it('renders an accessible help region documenting every mesh concept', () => {
    const html = renderPanel()

    // The panel is a labelled region (replaces the scattered per-card popovers).
    expect(html).toContain('role="region"')
    expect(html).toContain('aria-label="Mesh concept help"')

    // One definition entry per concept the end user needs to understand. The
    // consolidated panel covers them all in one place instead of one "?" per card.
    expect(html).toContain('Node')
    expect(html).toContain('Session')
    expect(html).toContain('Task')
    expect(html).toContain('Mission')
    expect(html).toContain('Refinery (refine)')
    expect(html).toContain('Completion model')
    expect(html).toContain('Branch convergence states')

    // It is a real definition list so each term/summary pair is semantically paired.
    expect(html).toContain('<dl')
    expect(html).toContain('<dt')
    expect(html).toContain('<dd')
  })

  it('defines a plain-language summary for every mesh concept', () => {
    // The user-facing copy is the payload; assert the key phrasing from the
    // rendered panel so a future edit that drops or muddles a definition is caught.
    const html = renderPanel()

    expect(html).toContain('isolated git worktree')                   // Node
    expect(html).toContain('durable record')                          // Mission
    expect(html).toContain('pending → assigned → completed')          // Task
    expect(html).toContain('Idle nodes claim from the queue')         // Queue/Task
    expect(html).toContain('persisted to the queue')                  // completion model
    expect(html).toContain('converging and merging')                  // Refinery
  })
})
