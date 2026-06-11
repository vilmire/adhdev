import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import SpecFormBuilder, { type SpecModel } from '../../../src/components/dashboard/SpecFormBuilder'

const model: SpecModel = {
  $schema: 'adhdev:cli/spec@4', id: 'x', name: 'X', binary: 'x',
  send_message: { submit_key: '\r' },
  sections: { body: {}, footer: {}, status: {}, modal: {} },
  states: [
    { id: 'starting', label: 'Starting', initial: true },
    { id: 'idle', label: 'Ready' },
    { id: 'busy', label: 'Generating' },
  ],
  transitions: [
    { from: 'starting', to: 'idle', when: { elapsed_ms: 4000 } },
    { from: 'idle', to: 'busy', when: { any: [{ section: 'body', matches: 'spinner' }] } },
    { from: 'busy', to: 'idle', min_hold_ms: 400, when: { all: [{ not: { section: 'body', matches: 'x' } }, { stable_ms: 1200, cursor_above: 5 }] } },
  ],
}

describe('SpecFormBuilder', () => {
  it('renders states, transitions and nested conditions', () => {
    const html = renderToStaticMarkup(
      React.createElement(SpecFormBuilder, { model, onChange: () => {}, onPreview: () => {}, preview: {} })
    )
    expect(html).toContain('States')
    expect(html).toContain('Transitions')
    // from/to dropdowns constrained to existing states
    expect(html).toContain('starting')
    expect(html).toContain('busy')
    // condition leaf fields rendered
    expect(html).toContain('elapsed_ms')
    expect(html).toContain('stable_ms')
    // section dropdown options
    expect(html).toContain('body')
    expect(html).toContain('footer')
  })
})
