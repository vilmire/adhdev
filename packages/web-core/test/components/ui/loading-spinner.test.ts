import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import LoadingSpinner from '../../../src/components/ui/LoadingSpinner'

const h = React.createElement

describe('LoadingSpinner', () => {
    it('renders the dashboard ring defaults with semantic accent tokens', () => {
        const html = renderToStaticMarkup(h(LoadingSpinner))
        expect(html).toContain('rounded-full animate-spin')
        expect(html).toContain('width:28px')
        expect(html).toContain('height:28px')
        expect(html).toContain('var(--accent-primary)')
        expect(html).toContain('var(--accent-primary-light)')
        expect(html).toContain('aria-hidden="true"')
    })

    it('accepts contextual size, thickness, color, and accessible label props', () => {
        const html = renderToStaticMarkup(h(LoadingSpinner, {
            size: 12,
            thickness: 2,
            color: 'success',
            label: 'Generating',
            className: 'extra',
        }))
        expect(html).toContain('width:12px')
        expect(html).toContain('border:2px solid')
        expect(html).toContain('var(--status-online)')
        expect(html).toContain('class="block shrink-0 rounded-full animate-spin extra"')
        expect(html).toContain('role="status"')
        expect(html).toContain('aria-label="Generating"')
        expect(html).not.toContain('aria-hidden')
    })
})
