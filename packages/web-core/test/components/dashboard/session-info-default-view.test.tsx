// @vitest-environment jsdom
//
// SessionInfoDialog default view vs Technical details (UI simplification
// 2026-09-27). The default view answers what a person asks about a session —
// provider, workspace, machine, when it started, git state — and the ids,
// launch arguments, runtime JSON and injected prompt sit in ONE collapsed
// "Technical details" disclosure plus a "Copy diagnostics" button. There is no
// Refresh button and no raw millisecond timestamp in the default view.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import SessionInfoDialog from '../../../src/components/dashboard/SessionInfoDialog'
import { TransportProvider } from '../../../src/context/TransportContext'

const SPAWNED_AT = Date.now() - 5 * 60_000

const SESSION_INFO = {
    success: true,
    session: {
        sessionId: 'sess_0123456789abcdef',
        providerType: 'claude-cli',
        providerName: 'Claude Code',
        transport: 'pty',
        workspace: '/Users/dev/work/adhdev',
        spawnedAtMs: SPAWNED_AT,
        providerSessionId: 'prov-9999',
        launch: { command: 'claude', args: ['--resume', 'x'], cwd: '/Users/dev/work/adhdev' },
        runtimeMetadata: { runtimeId: 'rt-1', lifecycle: 'running', restoredFromStorage: false },
    },
    coordinator: {
        meshId: 'mesh_abc',
        cliType: 'claude-cli',
        startedAt: SPAWNED_AT,
        systemPrompt: 'FINAL SYSTEM PROMPT BODY',
    },
    machineNickname: 'devbox',
}

describe('SessionInfoDialog — short default view, one Technical details disclosure', () => {
    let container: HTMLDivElement
    let root: Root
    const writeText = vi.fn(async () => {})

    beforeEach(() => {
        container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
        writeText.mockClear()
    })

    afterEach(() => {
        act(() => root.unmount())
        container.remove()
    })

    async function render() {
        const sendCommand = vi.fn(async () => SESSION_INFO)
        await act(async () => {
            root.render(
                <TransportProvider value={{ sendCommand }}>
                    <SessionInfoDialog
                        sessionId="sess_0123456789abcdef"
                        daemonId="daemon-1"
                        conv={{ git: { branch: 'main', dirty: true, ahead: 2, behind: 0 } } as any}
                        onClose={() => {}}
                    />
                </TransportProvider>,
            )
            await Promise.resolve()
            await Promise.resolve()
        })
        return sendCommand
    }

    const dialog = () => document.body.querySelector('[role="dialog"]') as HTMLElement
    const summary = () => dialog().querySelector('[data-testid="session-info-summary"]') as HTMLElement
    const technical = () => dialog().querySelector('[data-testid="session-info-technical-details"]') as HTMLDetailsElement

    it('default view shows provider, workspace name, machine, relative start and git — nothing raw', async () => {
        await render()
        // Visible text only: tooltips keep the full path / exact time in an
        // sr-only description, which is the point (one hover away).
        const visible = summary().cloneNode(true) as HTMLElement
        visible.querySelectorAll('.sr-only').forEach(node => node.remove())
        const text = visible.textContent || ''
        expect(summary().textContent).toContain('/Users/dev/work/adhdev')
        expect(text).toContain('Claude Code')
        expect(text).toContain('adhdev')
        expect(text).not.toContain('/Users/dev/work/adhdev')
        expect(text).toContain('devbox')
        expect(text).toMatch(/5 min\. ago/)
        expect(text).toContain('main')
        expect(text).toContain('↑2')
        expect(text).toContain('Mesh coordinator')
        // Ids, launch args and the injected prompt are NOT in the default view…
        expect(text).not.toContain('sess_0123456789abcdef')
        expect(text).not.toContain('--resume')
        expect(text).not.toContain(String(SPAWNED_AT))
        // …and the "not a coordinator" essay is gone.
        expect(dialog().textContent).not.toContain("This isn't a mesh coordinator session")
    })

    it('ids, launch, runtime and prompt sit in ONE collapsed Technical details disclosure', async () => {
        await render()
        expect(dialog().querySelectorAll('[data-testid="session-info-technical-details"]')).toHaveLength(1)
        expect(technical().open).toBe(false)
        const text = technical().textContent || ''
        expect(text).toContain('Technical details')
        expect(text).toContain('sess_0123456789abcdef')
        expect(text).toContain('/Users/dev/work/adhdev')
        expect(text).toContain('--resume x')
        expect(text).toContain('mesh_abc')
        expect(text).toContain('Raw runtime metadata')
        expect(text).toContain('Final system prompt')
        // Runtime yes/no values are localized words, not 'yes'/'no' literals.
        expect(text).toContain('Restored from storage')
        expect(text).toContain('No')
    })

    it('footer has Copy diagnostics and Close — no Refresh', async () => {
        await render()
        const footerButtons = Array.from(dialog().querySelectorAll('button')).map(button => button.textContent?.trim())
        expect(footerButtons).toContain('Copy diagnostics')
        expect(footerButtons).toContain('Close')
        expect(footerButtons).not.toContain('Refresh')

        const copy = dialog().querySelector<HTMLButtonElement>('[data-testid="session-info-copy-diagnostics"]')!
        await act(async () => { copy.click(); await Promise.resolve() })
        expect(writeText).toHaveBeenCalledTimes(1)
        const copied = JSON.parse(writeText.mock.calls[0][0] as string)
        expect(copied.sessionId).toBe('sess_0123456789abcdef')
        expect(copied.session.launch.command).toBe('claude')
        expect(copied.coordinator.meshId).toBe('mesh_abc')
    })
})
