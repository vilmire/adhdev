import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import Dialog from '../../../src/components/ui/Dialog'

const h = React.createElement

// In the vitest `node` environment there is no `document`, so Dialog renders
// inline (its SSR fallback) rather than through a portal — which is exactly
// what makes renderToStaticMarkup usable here.

describe('Dialog', () => {
    it('renders nothing when closed', () => {
        const html = renderToStaticMarkup(h(Dialog, { open: false, onClose: () => {} }, 'body'))
        expect(html).toBe('')
    })

    it('renders a labelled dialog surface with body content when open', () => {
        const html = renderToStaticMarkup(
            h(Dialog, { open: true, onClose: () => {}, title: 'Confirm' }, h('p', null, 'body content')),
        )
        expect(html).toContain('role="dialog"')
        expect(html).toContain('aria-modal="true"')
        expect(html).toContain('Confirm')
        expect(html).toContain('body content')
    })

    it('uses the canonical z-index scale tokens', () => {
        const html = renderToStaticMarkup(h(Dialog, { open: true, onClose: () => {} }, 'x'))
        expect(html).toContain('z-index:var(--z-modal-backdrop)')
        expect(html).toContain('z-index:var(--z-modal)')
    })

    it.each([
        ['sm', 'max-w-md'],
        ['md', 'max-w-lg'],
        ['lg', 'max-w-3xl'],
    ] as const)('maps size %s to %s', (size, expected) => {
        const html = renderToStaticMarkup(h(Dialog, { open: true, onClose: () => {}, size }, 'x'))
        expect(html).toContain(expected)
    })

    it('renders the footer slot when provided', () => {
        const html = renderToStaticMarkup(
            h(Dialog, { open: true, onClose: () => {}, footer: h('button', null, 'Go') }, 'x'),
        )
        expect(html).toContain('>Go</button>')
    })

    it('omits the header when there is no title and showClose is false', () => {
        const html = renderToStaticMarkup(
            h(Dialog, { open: true, onClose: () => {}, showClose: false }, 'x'),
        )
        expect(html).not.toContain('aria-label="Close dialog"')
    })

    it('renders the close button by default and falls back to ariaLabel with no title', () => {
        const html = renderToStaticMarkup(
            h(Dialog, { open: true, onClose: () => {}, ariaLabel: 'Settings' }, 'x'),
        )
        expect(html).toContain('aria-label="Close dialog"')
        expect(html).toContain('aria-label="Settings"')
    })
})
