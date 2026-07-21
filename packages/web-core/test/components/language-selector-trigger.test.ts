import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import LanguageSelector from '../../src/components/LanguageSelector'

function render(props: Record<string, unknown> = {}): string {
    return renderToStaticMarkup(React.createElement(LanguageSelector, props))
}

describe('LanguageSelector trigger', () => {
    it('renders the icon-only trigger when the sidebar is collapsed (no label/caret)', () => {
        const html = render({ collapsed: true })
        // Root + trigger present.
        expect(html).toContain('lang-switch-trigger')
        expect(html).toContain('aria-haspopup="listbox"')
        // Collapsed = centered icon-only, no text label / caret.
        expect(html).toContain('justify-center')
        expect(html).not.toContain('lang-switch-label')
        expect(html).not.toContain('lang-switch-caret')
    })

    it('renders the labelled trigger when the sidebar is expanded', () => {
        const html = render({ collapsed: false })
        expect(html).toContain('lang-switch-label')
        expect(html).toContain('lang-switch-caret')
        expect(html).not.toContain('justify-center')
    })

    it('exposes the current language in the trigger accessible name', () => {
        // Test harness pins language to English (test/setup.ts).
        const html = render({ collapsed: false })
        expect(html).toMatch(/aria-label="[^"]*English"/)
        expect(html).toContain('aria-expanded="false"')
    })

    it('keeps the closed popover out of the DOM until opened (portaled on interaction)', () => {
        const html = render({ collapsed: true })
        // The listbox is only rendered when open; SSR renders the closed trigger only.
        expect(html).not.toContain('role="listbox"')
    })
})
