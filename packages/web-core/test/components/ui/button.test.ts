import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import Button from '../../../src/components/ui/Button'

// `.ts` (not `.tsx`) so it matches the suite's `test/**/*.test.ts` include glob;
// JSX is expressed via React.createElement.
const h = React.createElement

describe('Button', () => {
    it('renders base .btn with the default secondary variant', () => {
        const html = renderToStaticMarkup(h(Button, null, 'Save'))
        expect(html).toContain('class="btn btn-secondary"')
        expect(html).toContain('>Save</button>')
        // Defaults to type="button" to avoid accidental form submits.
        expect(html).toContain('type="button"')
    })

    it.each([
        ['primary', 'btn-primary'],
        ['secondary', 'btn-secondary'],
        ['warning', 'btn-warning'],
        ['danger', 'btn-danger'],
        ['ghost', 'btn-ghost'],
    ] as const)('maps variant %s to canonical %s', (variant, expected) => {
        const html = renderToStaticMarkup(h(Button, { variant }, 'x'))
        expect(html).toContain('btn')
        expect(html).toContain(expected)
    })

    it('adds btn-sm only for size sm', () => {
        expect(renderToStaticMarkup(h(Button, { size: 'sm' }, 'x'))).toContain('btn-sm')
        expect(renderToStaticMarkup(h(Button, { size: 'md' }, 'x'))).not.toContain('btn-sm')
    })

    it('merges className last and forwards native attributes', () => {
        const html = renderToStaticMarkup(
            h(Button, { variant: 'primary', className: 'w-full', disabled: true }, 'x'),
        )
        expect(html).toContain('w-full')
        expect(html).toContain('btn-primary')
        expect(html).toContain('disabled')
    })

    it('honors an explicit type override', () => {
        const html = renderToStaticMarkup(h(Button, { type: 'submit' }, 'x'))
        expect(html).toContain('type="submit"')
    })
})
