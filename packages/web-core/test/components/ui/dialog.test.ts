import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import Dialog, { DialogShell } from '../../../src/components/ui/Dialog'

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

    it('keeps the surface clear of the iOS PWA safe-area insets (RC32)', () => {
        const html = renderToStaticMarkup(h(Dialog, { open: true, onClose: () => {} }, 'x'))
        // Overlay padding accounts for the status bar / home indicator.
        expect(html).toContain('pt-[calc(16px+env(safe-area-inset-top,0px))]')
        expect(html).toContain('pb-[calc(16px+env(safe-area-inset-bottom,0px))]')
        // The surface max-height is capped inside the dynamic viewport + insets.
        expect(html).toContain('max-h-[calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-2rem)]')
    })

    it('gives the close button a >=44px tap target while preserving the 32px visual scale (RC32)', () => {
        const html = renderToStaticMarkup(h(Dialog, { open: true, onClose: () => {} }, 'x'))
        // Outer button owns the 44px hit area; inner span owns the 32px chrome;
        // the negative margin keeps the header layout footprint unchanged.
        expect(html).toContain('h-11 w-11')
        expect(html).toContain('h-8 w-8')
        expect(html).toContain('-m-1.5')
    })
})

describe('DialogShell', () => {
    it('renders nothing when open is false and defaults open to true', () => {
        const closed = renderToStaticMarkup(h(DialogShell, { open: false, onClose: () => {} }, 'x'))
        expect(closed).toBe('')
        const open = renderToStaticMarkup(h(DialogShell, { onClose: () => {} }, 'shell body'))
        expect(open).toContain('shell body')
    })

    it('chrome mode paints canonical overlay/surface styling and the z-scale tokens', () => {
        const html = renderToStaticMarkup(h(DialogShell, { onClose: () => {} }, 'x'))
        expect(html).toContain('role="dialog"')
        expect(html).toContain('aria-modal="true"')
        expect(html).toContain('z-index:var(--z-modal-backdrop)')
        expect(html).toContain('z-index:var(--z-modal)')
        expect(html).toContain('bg-black/60')
        expect(html).toContain('bg-surface-primary')
        expect(html).toContain('max-w-lg')
        expect(html).toContain('pt-[calc(16px+env(safe-area-inset-top,0px))]')
    })

    it.each([
        ['center', 'items-center justify-center'],
        ['sheet', 'items-end justify-center sm:items-center'],
        ['stretch', 'items-stretch justify-center md:items-center'],
    ] as const)('maps align %s to %s', (align, expected) => {
        const html = renderToStaticMarkup(h(DialogShell, { onClose: () => {}, align, chrome: false }, 'x'))
        expect(html).toContain(expected)
    })

    it('chrome={false} renders consumer classes verbatim without the default chrome or z styles', () => {
        const html = renderToStaticMarkup(
            h(DialogShell, {
                onClose: () => {},
                chrome: false,
                overlayClassName: 'z-[var(--z-modal)] bg-black/50 backdrop-blur-[2px]',
                surfaceClassName: 'card rounded-[24px] shadow-xl',
            }, 'bare body'),
        )
        expect(html).toContain('fixed inset-0 flex')
        expect(html).toContain('z-[var(--z-modal)] bg-black/50 backdrop-blur-[2px]')
        expect(html).toContain('card rounded-[24px] shadow-xl')
        expect(html).not.toContain('z-index:var(--z-modal-backdrop)')
        expect(html).not.toContain('bg-surface-primary')
        expect(html).not.toContain('max-w-lg')
        expect(html).toContain('bare body')
    })

    it('tailwind-merges consumer overrides over chrome defaults', () => {
        const html = renderToStaticMarkup(
            h(DialogShell, { onClose: () => {}, overlayClassName: 'bg-black/50' }, 'x'),
        )
        expect(html).toContain('bg-black/50')
        expect(html).not.toContain('bg-black/60')
    })

    it('wires aria labelling for bespoke consumers', () => {
        const html = renderToStaticMarkup(
            h(DialogShell, { onClose: () => {}, chrome: false, ariaLabelledBy: 'my-title' }, 'x'),
        )
        expect(html).toContain('aria-labelledby="my-title"')
        expect(html).toContain('role="dialog"')
    })
})
