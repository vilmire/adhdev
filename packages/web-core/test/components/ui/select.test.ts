import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import Select from '../../../src/components/ui/Select'

const h = React.createElement

describe('Select', () => {
    it('renders canonical Input-matching surface classes', () => {
        const html = renderToStaticMarkup(h(Select, null))
        expect(html).toContain('rounded-xl')
        expect(html).toContain('border-border-subtle')
        expect(html).toContain('bg-bg-secondary')
        expect(html).toContain('focus:border-accent')
        expect(html).toContain('cursor-pointer')
    })

    it('renders options from the options prop', () => {
        const html = renderToStaticMarkup(
            h(Select, {
                value: 'a',
                onChange: () => {},
                options: [
                    { value: 'a', label: 'Alpha' },
                    { value: 'b', label: 'Beta', disabled: true },
                ],
            }),
        )
        expect(html).toContain('value="a"')
        expect(html).toContain('>Alpha</option>')
        expect(html).toContain('>Beta</option>')
        expect(html).toContain('disabled')
    })

    it('prefers children over the options prop', () => {
        const html = renderToStaticMarkup(
            h(
                Select,
                { options: [{ value: 'a', label: 'Alpha' }] },
                h('option', { value: 'z' }, 'Zeta'),
            ),
        )
        expect(html).toContain('>Zeta</option>')
        expect(html).not.toContain('Alpha')
    })

    it('merges className last', () => {
        const html = renderToStaticMarkup(h(Select, { className: 'max-w-xs' }))
        expect(html).toContain('max-w-xs')
    })
})
