// @vitest-environment jsdom
/**
 * D5 (the 2026-09-25 graph orchestration simplification) — the
 * Blueprint Blocked-section gate row gets Release/Abandon/Extend 24h buttons
 * plus a distinct `expired` badge with age, and blocked task rows get a
 * "blocked by: <gate>, <elapsed>" one-liner. This supersedes the 2026-08-24
 * "gate verbs are coordinator-only" decision recorded on MeshBlueprintView.
 *
 * Two kinds of assertions:
 *  - pure payload builders (blueprintViewModel) — the exact wire shape sent
 *    to sendDaemonCommand for mesh_graph_gate_release/abandon/extend
 *  - render + click, through MeshBlueprintList exactly as MeshBlueprintView
 *    wires it (real i18n, real theme, jsdom + react-dom/client + act), so a
 *    button click really dispatches the command with that payload.
 */
import { act } from 'react'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import MeshBlueprintList from '../../src/components/MeshGraph/MeshBlueprintList'
import { getMeshGraphTheme } from '../../src/components/MeshGraph/meshGraphTheme'
import {
    BLUEPRINT_GATE_EXTEND_SECONDS,
    buildGateAbandonArgs,
    buildGateExtendArgs,
    buildGateReleaseArgs,
    elapsedMsSince,
    formatBlueprintAge,
} from '../../src/components/MeshGraph/blueprintViewModel'

vi.mock('../../src/components/MeshGraph/MeshMiniDag', () => ({
    default: () => null,
}))

const meshTheme = getMeshGraphTheme('dark')

/* ── Pure payload builders ─────────────────────────────────────────────── */

describe('D5 gate command payload builders', () => {
    it('mesh_graph_gate_release: snake_case, outcome required, evidence trimmed+optional', () => {
        expect(buildGateReleaseArgs('mesh-1', 'gate-1', 'passed')).toEqual({
            mesh_id: 'mesh-1', gate_id: 'gate-1', outcome: 'passed',
        })
        expect(buildGateReleaseArgs('mesh-1', 'gate-1', 'failed', '  looks broken  ')).toEqual({
            mesh_id: 'mesh-1', gate_id: 'gate-1', outcome: 'failed', evidence: 'looks broken',
        })
        // Blank evidence must not send an empty-string field.
        expect(buildGateReleaseArgs('mesh-1', 'gate-1', 'passed', '   ')).toEqual({
            mesh_id: 'mesh-1', gate_id: 'gate-1', outcome: 'passed',
        })
    })

    it('mesh_graph_gate_abandon: snake_case, reason trimmed', () => {
        expect(buildGateAbandonArgs('mesh-1', 'gate-1', '  cleaning up stranded branch  ')).toEqual({
            mesh_id: 'mesh-1', gate_id: 'gate-1', reason: 'cleaning up stranded branch',
        })
    })

    it('mesh_graph_gate_extend: defaults to 24h in seconds, snake_case', () => {
        expect(BLUEPRINT_GATE_EXTEND_SECONDS).toBe(86400)
        expect(buildGateExtendArgs('mesh-1', 'gate-1')).toEqual({
            mesh_id: 'mesh-1', gate_id: 'gate-1', extend_seconds: 86400,
        })
        expect(buildGateExtendArgs('mesh-1', 'gate-1', 3600)).toEqual({
            mesh_id: 'mesh-1', gate_id: 'gate-1', extend_seconds: 3600,
        })
    })

    it('formatBlueprintAge buckets coarsely (s/m/h/d)', () => {
        expect(formatBlueprintAge(45_000)).toBe('45s')
        expect(formatBlueprintAge(5 * 60_000)).toBe('5m')
        expect(formatBlueprintAge(3 * 3_600_000)).toBe('3h')
        expect(formatBlueprintAge(2 * 86_400_000)).toBe('2d')
    })

    it('elapsedMsSince clamps to >= 0 and tolerates missing/invalid timestamps', () => {
        const now = Date.parse('2026-09-25T12:00:00Z')
        expect(elapsedMsSince('2026-09-25T11:00:00Z', now)).toBe(3_600_000)
        expect(elapsedMsSince('2026-09-25T13:00:00Z', now)).toBe(0)
        expect(elapsedMsSince(undefined, now)).toBeUndefined()
        expect(elapsedMsSince('not-a-date', now)).toBeUndefined()
    })
})

/* ── Render + click, through the real component tree ─────────────────────
 * MeshBlueprintList is rendered exactly the way MeshBlueprintView wires it:
 * tasks + status + graphs + daemonId/meshId/sendDaemonCommand, and a gate row
 * comes from graphs[].gates the same way blueprint-list-render.test.tsx
 * already exercises. */

const NOW_ISO = '2026-09-25T12:00:00Z'

function baseStatus() {
    return { meshId: 'mesh-1', meshName: 'Mesh', repoIdentity: 'repo', refreshedAt: NOW_ISO, nodes: [] } as any
}

function awaitingGraph(overrides: Record<string, unknown> = {}) {
    return {
        graphId: 'g1',
        status: 'waiting_gate',
        edges: [],
        createdAt: '2026-09-25T10:00:00Z',
        nodes: [
            { nodeId: 'review_land', ref: 'review_land', kind: 'coordinator_gate', state: 'awaiting_coordinator', materializationVersion: 1 },
        ],
        gates: [
            { gateId: 'gate-1', nodeId: 'review_land', state: 'awaiting_coordinator', action: 'approval', onTimeout: 'hold', leaseGeneration: 0, instructions: 'Review and land the branch' },
        ],
        ...overrides,
    } as any
}

function mountList(props: Partial<React.ComponentProps<typeof MeshBlueprintList>> = {}): { container: HTMLDivElement; unmount: () => void } {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    act(() => {
        root.render(
            <MeshBlueprintList
                tasks={[]}
                status={baseStatus()}
                graphs={[awaitingGraph()]}
                meshTheme={meshTheme}
                onTaskOpen={() => {}}
                onGateOpen={() => {}}
                daemonId="daemon-1"
                meshId="mesh-1"
                {...props}
            />,
        )
    })
    return { container, unmount: () => act(() => root.unmount()) }
}

describe('Blueprint gate row — D5 actions', () => {
    it('renders Release/Abandon/Extend 24h only when sendDaemonCommand is provided', () => {
        const { container: withoutCommand, unmount: unmount1 } = mountList()
        expect(withoutCommand.textContent).not.toContain('Release')
        expect(withoutCommand.textContent).not.toContain('Abandon')
        unmount1()

        const { container: withCommand, unmount: unmount2 } = mountList({ sendDaemonCommand: vi.fn().mockResolvedValue({ success: true }) })
        expect(withCommand.textContent).toContain('Release')
        expect(withCommand.textContent).toContain('Abandon')
        expect(withCommand.textContent).toContain('Extend 24h')
        unmount2()
    })

    it('Release: opens the inline outcome form and sends mesh_graph_gate_release with the chosen outcome + evidence', async () => {
        const sendDaemonCommand = vi.fn().mockResolvedValue({ success: true })
        const onGatesChanged = vi.fn()
        const { container, unmount } = mountList({ sendDaemonCommand, onGatesChanged })

        const releaseButton = [...container.querySelectorAll('button')].find(b => b.textContent === 'Release')!
        await act(async () => { releaseButton.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

        // Default outcome is "passed" (first radio) — pick "failed" instead.
        const failedRadio = [...container.querySelectorAll('input[type="radio"]')]
            .find(r => (r as HTMLInputElement).nextSibling?.textContent?.includes('Failed')
                || r.parentElement?.textContent?.includes('Failed')) as HTMLInputElement
        expect(failedRadio).toBeTruthy()
        await act(async () => { failedRadio.click() })

        const evidenceInput = container.querySelector('input[type="text"]') as HTMLInputElement
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
        await act(async () => {
            setter.call(evidenceInput, 'CI is red on main')
            evidenceInput.dispatchEvent(new Event('input', { bubbles: true }))
        })

        const submitButton = [...container.querySelectorAll('button')].find(b => b.textContent === 'Submit release')!
        await act(async () => { submitButton.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

        expect(sendDaemonCommand).toHaveBeenCalledWith('daemon-1', 'mesh_graph_gate_release', {
            mesh_id: 'mesh-1', gate_id: 'gate-1', outcome: 'failed', evidence: 'CI is red on main',
        })
        expect(onGatesChanged).toHaveBeenCalled()
        unmount()
    })

    it('Abandon: requires a reason and sends mesh_graph_gate_abandon with it', async () => {
        const sendDaemonCommand = vi.fn().mockResolvedValue({ success: true })
        const { container, unmount } = mountList({ sendDaemonCommand })

        const abandonButton = [...container.querySelectorAll('button')].find(b => b.textContent === 'Abandon')!
        await act(async () => { abandonButton.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

        // Submitting with no reason must not send a command — inline validation.
        const submitAbandon = [...container.querySelectorAll('button')].find(b => b.textContent === 'Submit abandon')!
        await act(async () => { submitAbandon.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
        expect(sendDaemonCommand).not.toHaveBeenCalled()
        expect(container.textContent).toContain('A reason is required to abandon a gate.')

        const reasonInput = container.querySelector('input[type="text"]') as HTMLInputElement
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
        await act(async () => {
            setter.call(reasonInput, 'stranded worktree cleanup')
            reasonInput.dispatchEvent(new Event('input', { bubbles: true }))
        })
        await act(async () => { submitAbandon.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

        expect(sendDaemonCommand).toHaveBeenCalledWith('daemon-1', 'mesh_graph_gate_abandon', {
            mesh_id: 'mesh-1', gate_id: 'gate-1', reason: 'stranded worktree cleanup',
        })
        unmount()
    })

    it('Extend 24h: confirms in-app (no window.confirm) then sends mesh_graph_gate_extend with extend_seconds=86400', async () => {
        const sendDaemonCommand = vi.fn().mockResolvedValue({ success: true })
        const confirmSpy = vi.spyOn(window, 'confirm')
        const { container, unmount } = mountList({ sendDaemonCommand })

        const extendButton = [...container.querySelectorAll('button')].find(b => b.textContent === 'Extend 24h')!
        await act(async () => { extendButton.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

        // The in-app ConfirmDialog renders its own confirm button (same label);
        // there are now two "Extend 24h" texts on the page (the row button and
        // the dialog's confirm button) — click the LAST one (the dialog).
        const confirmButtons = [...container.ownerDocument.querySelectorAll('button')].filter(b => b.textContent === 'Extend 24h')
        expect(confirmButtons.length).toBeGreaterThanOrEqual(1)
        await act(async () => { confirmButtons[confirmButtons.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true })) })

        expect(sendDaemonCommand).toHaveBeenCalledWith('daemon-1', 'mesh_graph_gate_extend', {
            mesh_id: 'mesh-1', gate_id: 'gate-1', extend_seconds: 86400,
        })
        // window.confirm must never be used (embedded webviews auto-dismiss it).
        expect(confirmSpy).not.toHaveBeenCalled()
        unmount()
    })

    it('surfaces a failed command inline rather than throwing/toasting', async () => {
        const sendDaemonCommand = vi.fn().mockResolvedValue({ success: false, error: 'gate already released' })
        const { container, unmount } = mountList({ sendDaemonCommand })

        const abandonButton = [...container.querySelectorAll('button')].find(b => b.textContent === 'Abandon')!
        await act(async () => { abandonButton.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
        const reasonInput = container.querySelector('input[type="text"]') as HTMLInputElement
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
        await act(async () => {
            setter.call(reasonInput, 'test')
            reasonInput.dispatchEvent(new Event('input', { bubbles: true }))
        })
        const submitAbandon = [...container.querySelectorAll('button')].find(b => b.textContent === 'Submit abandon')!
        await act(async () => { submitAbandon.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

        expect(container.textContent).toContain('gate already released')
        unmount()
    })

    it('renders a distinct "Expired" badge with age for an expired gate', () => {
        const expiredGraph = awaitingGraph({
            nodes: [{ nodeId: 'review_land', ref: 'review_land', kind: 'coordinator_gate', state: 'expired', materializationVersion: 1 }],
            gates: [{
                gateId: 'gate-1', nodeId: 'review_land', state: 'expired', action: 'approval', onTimeout: 'hold', leaseGeneration: 0,
                deadlineAt: '2026-09-25T09:00:00Z',
            }],
        })
        const { container, unmount } = mountList({ graphs: [expiredGraph] })
        expect(container.textContent).toContain('Expired')
        // Should NOT show the generic "Needs you" badge for an expired gate —
        // it is a visually distinct state.
        expect(container.textContent).not.toContain('Needs you')
        unmount()
    })
})

describe('Blueprint task row — "blocked by" one-liner (D5)', () => {
    it('names the gate holding the task and how long, via the graph node blockedByGateId', () => {
        const graph = {
            graphId: 'g2',
            status: 'waiting_gate',
            edges: [{ from: 'review_land', to: 'worker-1', kind: 'gate', omitOnSkip: false, active: true }],
            createdAt: '2026-09-25T10:00:00Z',
            nodes: [
                { nodeId: 'review_land', ref: 'review_land', kind: 'coordinator_gate', state: 'awaiting_coordinator', materializationVersion: 1 },
                { nodeId: 'worker-1', ref: 'worker-1', kind: 'worker_task', state: 'materialized', taskId: 't-1', blockedByGateId: 'gate-1', materializationVersion: 1 },
            ],
            gates: [
                { gateId: 'gate-1', nodeId: 'review_land', state: 'awaiting_coordinator', action: 'approval', onTimeout: 'hold', leaseGeneration: 0 },
            ],
        } as any
        const task = {
            id: 't-1', meshId: 'mesh-1', message: 'wait for review', status: 'pending',
            createdAt: '2026-09-25T10:00:00Z', updatedAt: '2026-09-25T10:00:00Z',
        } as any
        const { container, unmount } = mountList({ graphs: [graph], tasks: [task] })
        expect(container.textContent).toContain('blocked by: review_land')
        unmount()
    })

    it('a queue task behind a failed/cancelled dependency reads "blocked by failed/cancelled dependency", not "waiting on"', () => {
        const mk = (id: string, status: string, dependsOn?: string[]) => ({
            id, meshId: 'mesh-1', message: `task ${id}`, status, ...(dependsOn ? { dependsOn } : {}),
            createdAt: '2026-09-25T10:00:00Z', updatedAt: '2026-09-25T10:00:00Z',
        }) as any
        const { container, unmount } = mountList({ graphs: [], tasks: [mk('dead-root-0001', 'cancelled'), mk('waiter-00002', 'pending', ['dead-root-0001'])] })
        const line = container.querySelector('[data-testid="blueprint-waiting-on"]')
        expect(line?.textContent).toContain('blocked by failed/cancelled dependency:')
        expect(line?.textContent).not.toContain('waiting on:')
        unmount()
    })
})
