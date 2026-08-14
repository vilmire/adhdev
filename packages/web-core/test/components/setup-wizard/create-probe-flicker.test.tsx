// @vitest-environment jsdom
//
// Regression test for the "Checking the workspace..." flicker during Create
// Mesh. Root cause: SetupWizard's create-probe useEffect depended on `meshes`
// (an array), and useMeshList's loadMeshes() produces a brand-new array
// reference on every call — even when the mesh list content is unchanged
// (setMeshes(next) has no content-equality guard, unlike DaemonContext's
// injectEntries/daemonArraysEqual pattern).
//
// loadMeshes() re-runs whenever its own identity changes (useMeshList.ts:
// [daemonIdsKey, primaryDaemonId, sendCommand, unwrapResult, normalizeMesh,
// features.createDaemonPicker]) — which happens for real callers whenever
// unwrapResult/normalizeMesh are passed as inline closures that are recreated
// on every parent render (web-cloud's SetupWizardPage does exactly this: see
// packages/web-cloud/src/pages/SetupWizard.tsx). This test reproduces that:
// a parent re-render passes a NEW (but behaviorally identical) unwrapResult
// closure while the create form is open, which forces a real second
// list_meshes round-trip and a real new `meshes` array reference — not a
// simulation of internal state.
//
// Assertion: the create probe (plan_mesh_onboarding) must not re-fire from
// that reload alone. Reverting the meshesKey fix (depending on `meshes`
// directly again) turns this red — verified below.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SetupWizard from '../../../src/components/setup-wizard/SetupWizard'
import { STANDALONE_FEATURES, type RepoMeshDaemonEntry } from '../../../src/context/RepoMeshContext'

const PLAN_OK = {
    success: true,
    plan: { kind: 'create_mesh_and_onboard' },
    discovery: { repoRoot: '/repo', repoIdentity: 'github.com/acme/repo', defaultBranch: 'main' },
}

function daemon(id: string): RepoMeshDaemonEntry {
    return { id, hostname: id, workspaces: [{ path: '/repo', label: '/repo' }] }
}

async function setValue(el: HTMLSelectElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('SetupWizard create probe — meshes reference stability', () => {
    let container: HTMLDivElement
    let root: Root

    beforeEach(() => {
        vi.useFakeTimers()
        container = document.createElement('div')
        document.body.appendChild(container)
    })

    afterEach(() => {
        act(() => { root.unmount() })
        container.remove()
        vi.useRealTimers()
    })

    it('does not re-fire plan_mesh_onboarding when a parent re-render reloads meshes with a new-but-equal array', async () => {
        // list_meshes always returns equal CONTENT ([]); useMeshList's .map()
        // still gives each call a fresh array reference — the exact shape of
        // the bug (content-equal, identity-different).
        const sendCommand = vi.fn(async (_daemonId: string, type: string) => {
            if (type === 'list_meshes') return { success: true, meshes: [] }
            if (type === 'plan_mesh_onboarding') return PLAN_OK
            throw new Error(`unexpected command ${type}`)
        })
        const normalizeMesh = (raw: any) => raw
        const daemons = [daemon('daemon_1')]

        function renderWith(unwrapResult: (raw: any) => any) {
            return act(async () => {
                root.render(
                    <SetupWizard
                        daemons={daemons}
                        features={STANDALONE_FEATURES}
                        sendCommand={sendCommand}
                        unwrapResult={unwrapResult}
                        normalizeMesh={normalizeMesh}
                        onClose={() => {}}
                    />,
                )
            })
        }

        await act(async () => { root = createRoot(container) })
        // First mount with one unwrapResult closure instance.
        await renderWith((raw: any) => raw)
        await act(async () => { await Promise.resolve(); await Promise.resolve() })

        const listMeshesCalls = () => sendCommand.mock.calls.filter(c => c[1] === 'list_meshes').length
        expect(listMeshesCalls()).toBe(1)

        // Open the create form and pick the workspace — fires the debounced probe.
        const createButton = Array.from(container.querySelectorAll('button'))
            .find(b => /create/i.test(b.textContent || ''))
        expect(createButton).toBeTruthy()
        await act(async () => { createButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

        const select = container.querySelector('select') as HTMLSelectElement | null
        expect(select).toBeTruthy()
        await act(async () => { await setValue(select!, '/repo') })

        await act(async () => { vi.advanceTimersByTime(350) })
        await act(async () => { await Promise.resolve(); await Promise.resolve() })

        const planCallsAfterFirstSettle = sendCommand.mock.calls.filter(c => c[1] === 'plan_mesh_onboarding').length
        expect(planCallsAfterFirstSettle).toBe(1)

        // Re-render with a NEW unwrapResult closure (same behavior, new
        // reference) — this is exactly what a real caller like web-cloud's
        // SetupWizardPage does on every one of its own re-renders. That forces
        // loadMeshes' identity to change, re-running the mount effect and
        // producing a real second list_meshes call + a new `meshes` array.
        await renderWith((raw: any) => raw)
        await act(async () => { await Promise.resolve(); await Promise.resolve() })
        expect(listMeshesCalls()).toBe(2)

        await act(async () => { vi.advanceTimersByTime(350) })
        await act(async () => { await Promise.resolve(); await Promise.resolve() })

        // The probe must NOT have re-fired: the workspace field never changed,
        // only `meshes`'s array identity did.
        const planCallsFinal = sendCommand.mock.calls.filter(c => c[1] === 'plan_mesh_onboarding').length
        expect(planCallsFinal).toBe(1)
    })
})
