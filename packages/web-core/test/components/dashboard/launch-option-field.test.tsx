// @vitest-environment jsdom
/**
 * LaunchOptionField — the shared model / thinking-level picker used by the
 * new-session dialog, the slot editor, launch defaults and the assistant menu.
 */
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import LaunchOptionField, { withSavedOption } from '../../../src/components/dashboard/LaunchOptionField'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })

function Harness({ initial, options, allowCustom }: { initial: string; options: string[]; allowCustom?: boolean }) {
    const [value, setValue] = useState(initial)
    return <><LaunchOptionField value={value} options={options} onChange={setValue} allowCustom={allowCustom} /><output>{value}</output></>
}
const values = () => Array.from(host.querySelectorAll('option')).map(o => o.value)
function pick(value: string) {
    const select = host.querySelector('select')!
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value)
        select.dispatchEvent(new Event('change', { bubbles: true }))
    })
}

describe('LaunchOptionField', () => {
    it('lists provider default, then the advertised options', () => {
        act(() => root.render(<Harness initial="" options={['low', 'high']} />))
        expect(values()).toEqual(['', 'low', 'high'])
    })

    it('keeps a saved value the list does not contain, selected', () => {
        act(() => root.render(<Harness initial="xhigh" options={['low', 'high']} />))
        expect(values()).toEqual(['', 'low', 'high', 'xhigh'])
        expect(host.querySelector('select')!.value).toBe('xhigh')
        expect(withSavedOption(['a'], ' ')).toEqual(['a'])
    })

    it('a CLI that advertises nothing gets a text box, not an invented list', () => {
        act(() => root.render(<Harness initial="" options={[]} />))
        expect(host.querySelector('select')).toBeNull()
        expect(host.querySelector('input[type=text]')).not.toBeNull()
    })

    it('Custom… switches to a text box with a way back to the list', () => {
        act(() => root.render(<Harness initial="opus" options={['sonnet', 'opus']} allowCustom />))
        expect(values()).toEqual(['', 'sonnet', 'opus', '__custom__'])
        pick('__custom__')
        expect(host.querySelector('select')).toBeNull()
        expect(host.querySelector('output')!.textContent).toBe('')
        act(() => host.querySelector('button')!.click())
        expect(host.querySelector('select')).not.toBeNull()
    })
})
