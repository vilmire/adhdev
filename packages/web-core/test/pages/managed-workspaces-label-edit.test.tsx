// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    canEditWorkspaceLabel,
    WorkspaceLabelEditor,
} from '../../src/pages/machine/ManagedWorkspacesSection'

vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}))

describe('canEditWorkspaceLabel — mesh workspace gate', () => {
    it('allows only paths in the mesh workspace set (slash/case normalized)', () => {
        const mesh = new Set(['/repos/adhdev'])
        expect(canEditWorkspaceLabel('/repos/adhdev', mesh)).toBe(true)
        expect(canEditWorkspaceLabel('/repos/adhdev/', mesh)).toBe(true)
        expect(canEditWorkspaceLabel('/Repos/Adhdev', mesh)).toBe(true)
        expect(canEditWorkspaceLabel('/repos/other', mesh)).toBe(false)
        expect(canEditWorkspaceLabel('/repos/adhdev', new Set())).toBe(false)
    })
})

describe('WorkspaceLabelEditor', () => {
    let container: HTMLDivElement
    let root: Root

    beforeEach(() => {
        ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
        container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
    })

    afterEach(() => {
        act(() => root.unmount())
        container.remove()
    })

    it('shows the display label and a rename control until the pencil is clicked', () => {
        act(() => {
            root.render(
                <WorkspaceLabelEditor
                    displayLabel="Mesh Lab"
                    path="/repos/adhdev"
                    busy={false}
                    onSave={async () => true}
                />,
            )
        })
        expect(container.textContent).toContain('Mesh Lab')
        expect(container.querySelector('input')).toBeNull()
        const rename = container.querySelector('button[aria-label="machine.managedWorkspaces.rename"]')
        expect(rename).not.toBeNull()
    })

    it('opens an input on pencil click and saves the draft', async () => {
        const onSave = vi.fn(async (_path: string, label: string) => {
            expect(_path).toBe('/repos/adhdev')
            expect(label).toBe('New Name')
            return true
        })
        act(() => {
            root.render(
                <WorkspaceLabelEditor
                    displayLabel="Mesh Lab"
                    path="/repos/adhdev"
                    busy={false}
                    onSave={onSave}
                />,
            )
        })
        act(() => {
            container.querySelector('button[aria-label="machine.managedWorkspaces.rename"]')?.dispatchEvent(
                new MouseEvent('click', { bubbles: true }),
            )
        })
        const input = container.querySelector('input') as HTMLInputElement | null
        expect(input).not.toBeNull()
        act(() => {
            if (!input) return
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
            setter?.call(input, 'New Name')
            input.dispatchEvent(new Event('input', { bubbles: true }))
        })
        await act(async () => {
            container.querySelector('button[aria-label="machine.managedWorkspaces.saveName"]')?.dispatchEvent(
                new MouseEvent('click', { bubbles: true }),
            )
        })
        expect(onSave).toHaveBeenCalledTimes(1)
        expect(onSave).toHaveBeenCalledWith('/repos/adhdev', 'New Name')
    })

    it('selects the entire input text upon entering edit mode', () => {
        act(() => {
            root.render(
                <WorkspaceLabelEditor
                    displayLabel="Mesh Lab"
                    path="/repos/adhdev"
                    busy={false}
                    onSave={async () => true}
                />,
            )
        })
        act(() => {
            container.querySelector('button[aria-label="machine.managedWorkspaces.rename"]')?.dispatchEvent(
                new MouseEvent('click', { bubbles: true }),
            )
        })
        const input = container.querySelector('input') as HTMLInputElement | null
        expect(input).not.toBeNull()
        expect(document.activeElement).toBe(input)
        expect(input?.selectionStart).toBe(0)
        expect(input?.selectionEnd).toBe('Mesh Lab'.length)
    })
})

