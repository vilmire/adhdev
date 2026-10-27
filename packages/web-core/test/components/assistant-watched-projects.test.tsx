// @vitest-environment jsdom
/** "Following N" / "Follow projects": local watched threads + rc24 checkout-less remote project discovery & follow. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AssistantWatchedProjects from '../../src/components/dashboard/AssistantWatchedProjects'

let container: HTMLDivElement
let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const flush = async () => {
    await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
    })
}

describe('AssistantWatchedProjects', () => {
    it('remains visible even with zero threads so the owner can discover and follow remote projects', async () => {
        const send = vi.fn(async () => ({ success: true, threads: [], followedRemoteProjects: [] }))
        act(() => root.render(<AssistantWatchedProjects daemonId="daemon_mach_asst_b" sendCommand={send} />))
        await flush()
        const badge = container.querySelector<HTMLButtonElement>('.assistant-watched-badge')
        expect(badge).not.toBeNull()
        expect(badge?.textContent).toContain('Follow projects')
    })

    it('lists local followed projects and stops following one', async () => {
        let threads = [
            { meshId: 'm1', project: 'adhdev-cloud', openedAt: 1, lastSendAt: Date.now() - 60_000 },
            { meshId: 'm2', project: 'batrp', openedAt: 1, lastSendAt: Date.now() - 120_000 },
        ]
        const send = vi.fn(async (_d: string, command: string, args: any) => {
            if (command === 'assistant_thread_close') { threads = threads.filter(t => t.meshId !== args.meshId); return { success: true, closed: true } }
            return { success: true, threads, followedRemoteProjects: [] }
        })
        act(() => root.render(<AssistantWatchedProjects daemonId="d" sendCommand={send} />))
        await flush()
        const badge = container.querySelector<HTMLButtonElement>('.assistant-watched-badge')!
        expect(badge.textContent).toContain('Following 2')
        act(() => badge.click())
        await flush()
        expect(container.textContent).toContain('adhdev-cloud')
        const stopButtons = [...container.querySelectorAll<HTMLButtonElement>('li button')]
        await act(async () => { stopButtons[0]!.click() })
        await flush()
        expect(send).toHaveBeenCalledWith('d', 'assistant_thread_close', { meshId: 'm1' })
        expect(container.querySelector('.assistant-watched-badge')?.textContent).toContain('Following 1')
    })

    it('discovers remote projects, runs Allow this assistant and follow, separates Stop following from Remove access, and handles partial success + offline hosts', async () => {
        const HOST_A = 'daemon_mach_host_a_00001'
        const HOST_OFFLINE = 'daemon_mach_host_off_02'
        const ASST_B = 'daemon_mach_asst_b_00002'
        const MESH_ALPHA = 'mesh_sim_alpha'

        let threads: any[] = []
        let followedRemoteProjects: any[] = []
        let failNextPolicy = false
        let failNextFollow = false

        const send = vi.fn(async (targetId: string, command: string, args: any) => {
            if (targetId === ASST_B && command === 'assistant_threads') {
                return { success: true, threads, followedRemoteProjects }
            }
            if (targetId === HOST_A && command === 'assistant_remote_project_catalog') {
                return {
                    success: true,
                    hostDaemonId: HOST_A,
                    projects: [
                        {
                            hostDaemonId: HOST_A,
                            meshId: MESH_ALPHA,
                            name: 'AlphaSim',
                            sanitizedRepoIdentity: 'github.com/acme/alpha-sim',
                            coordinatorState: 'idle',
                            capabilities: { status: true, read: true, poll: true, report: true, send: true },
                            observedAt: '2026-10-20T00:00:00.000Z',
                        },
                    ],
                }
            }
            if (targetId === ASST_B && command === 'assistant_remote_follow' && args.action === 'ensure_binding') {
                return {
                    success: true,
                    ownerBinding: { accountSlot: 'personal', daemonId: ASST_B, bindingRevision: 1, boundAt: '2026-10-20T00:00:00.000Z' },
                }
            }
            if (targetId === HOST_A && command === 'assistant_remote_project_access' && args.action === 'grant') {
                return {
                    success: true,
                    action: 'grant',
                    access: {
                        hostDaemonId: HOST_A,
                        meshId: args.meshId,
                        accountSlot: 'personal',
                        activeDaemonId: ASST_B,
                        bindingRevision: args.bindingRevision,
                        grantRevision: 1,
                        status: 'active',
                        allowArtifactRead: args.allowArtifactRead,
                    },
                }
            }
            if (targetId === ASST_B && command === 'assistant_remote_follow' && args.action === 'follow') {
                if (failNextFollow) {
                    return { success: false, code: 'project_unreachable', error: 'host timed out during cursorOnly poll' }
                }
                const entry = {
                    key: `${HOST_A}::${args.meshId}`,
                    hostDaemonId: HOST_A,
                    hostLabel: args.hostLabel,
                    meshId: args.meshId,
                    name: args.name,
                    slug: 'alpha-sim',
                    sanitizedRepoIdentity: args.sanitizedRepoIdentity,
                    accountSlot: 'personal',
                    bindingRevision: args.bindingRevision,
                    grantRevision: args.grantRevision,
                    state: 'followed',
                    followedAt: '2026-10-20T00:00:00.000Z',
                    updatedAt: '2026-10-20T00:00:00.000Z',
                }
                followedRemoteProjects = [entry]
                threads = [
                    {
                        meshId: args.meshId,
                        project: 'alpha-sim',
                        openedAt: Date.now(),
                        lastSendAt: Date.now(),
                        hosting: 'remote_followed',
                        hostDaemonId: HOST_A,
                        hostLabel: args.hostLabel,
                        canonicalKey: entry.key,
                        grantRevision: args.grantRevision,
                        bindingRevision: args.bindingRevision,
                        remoteState: 'followed',
                    },
                ]
                return { success: true, entry }
            }
            if (targetId === ASST_B && command === 'assistant_remote_follow' && args.action === 'unfollow') {
                followedRemoteProjects = followedRemoteProjects.map(f => ({ ...f, state: 'unfollowed' }))
                threads = []
                return { success: true, closed: true }
            }
            if (targetId === HOST_A && command === 'assistant_remote_project_access' && args.action === 'revoke') {
                return { success: true, action: 'revoke', access: { status: 'revoked', grantRevision: 2 } }
            }
            if (targetId === HOST_A && command === 'assistant_remote_project_access' && args.action === 'set_policy') {
                if (failNextPolicy) { failNextPolicy = false; return { success: false, error: 'policy_boom' } }
                return {
                    success: true,
                    action: 'set_policy',
                    access: {
                        hostDaemonId: HOST_A,
                        meshId: args.meshId,
                        accountSlot: 'personal',
                        activeDaemonId: ASST_B,
                        bindingRevision: 1,
                        grantRevision: 1,
                        status: 'active',
                        allowCoordinatorLaunch: args.allowCoordinatorLaunch,
                        allowArtifactRead: args.allowArtifactRead,
                    },
                }
            }
            if (targetId === ASST_B && command === 'assistant_remote_follow' && args.action === 'mark_revoked') {
                followedRemoteProjects = followedRemoteProjects.map(f => ({ ...f, state: 'revoked' }))
                threads = []
                return { success: true, closed: true }
            }
            return { success: false, error: 'unexpected command' }
        })

        act(() =>
            root.render(
                <AssistantWatchedProjects
                    daemonId={ASST_B}
                    sendCommand={send}
                    remoteHosts={[
                        { id: HOST_A, label: 'DevLaptop-Sim', online: true },
                        { id: HOST_OFFLINE, label: 'OfflineMac', online: false },
                    ]}
                />,
            ),
        )
        await flush()

        // Open dialog from zero threads
        const badge = container.querySelector<HTMLButtonElement>('.assistant-watched-badge')!
        act(() => badge.click())
        await flush()

        // Catalog item is rendered with minimal scope note and 'Allow this assistant and follow'
        expect(container.textContent).toContain('AlphaSim')
        expect(container.textContent).toContain('github.com/acme/alpha-sim')
        expect(container.textContent).toContain('Minimal follower scope')

        // 1. Test partial success when host grant succeeds but local follow fails
        // 0. Pre-grant artifact-read checkbox defaults OFF; ticking it sends allowArtifactRead:true on grant
        const grantArtifact = container.querySelector<HTMLInputElement>(`[data-testid="grant-artifact-read-${MESH_ALPHA}"]`)!
        expect(grantArtifact).not.toBeNull()
        expect(grantArtifact.checked).toBe(false)
        act(() => { grantArtifact.click() })
        failNextFollow = true
        const allowBtn = container.querySelector<HTMLButtonElement>(`[data-testid="allow-and-follow-${MESH_ALPHA}"]`)!
        await act(async () => { allowBtn.click() })
        await flush()
        const partialBanner = container.querySelector('[data-testid="assistant-follow-partial-success"]')
        expect(partialBanner).not.toBeNull()
        expect(partialBanner?.textContent).toContain('Host access was granted')
        expect(send).toHaveBeenCalledWith(HOST_A, 'assistant_remote_project_access', expect.objectContaining({ action: 'grant', allowArtifactRead: true }))
        // grant calls always carry an explicit boolean
        const grantCalls = send.mock.calls.filter(c => c[1] === 'assistant_remote_project_access' && (c[2] as any).action === 'grant')
        expect(grantCalls.length).toBeGreaterThan(0)
        expect(grantCalls.every(c => typeof (c[2] as any).allowArtifactRead === 'boolean')).toBe(true)

        // 2. Retry follow succeeds
        failNextFollow = false
        await act(async () => { allowBtn.click() })
        await flush()
        expect(container.querySelector('[data-testid="assistant-follow-partial-success"]')).toBeNull()
        expect(container.querySelector('.assistant-watched-badge')?.textContent).toContain('Following 1')

        // 2b. Owner coordinator wake toggle defaults to ON and calls assistant_remote_project_access set_policy without grantRevision bump
        const wakeToggle = container.querySelector<HTMLInputElement>(`[data-testid="toggle-coordinator-wake-${MESH_ALPHA}"]`)!
        expect(wakeToggle).not.toBeNull()
        expect(wakeToggle.checked).toBe(true)
        send.mockClear()
        await act(async () => {
            wakeToggle.click()
        })
        await flush()
        expect(send).toHaveBeenCalledWith(HOST_A, 'assistant_remote_project_access', {
            action: 'set_policy',
            meshId: MESH_ALPHA,
            allowCoordinatorLaunch: false,
        })
        expect(wakeToggle.checked).toBe(false)

        // 2c. Artifact-read toggle: explicit opt-in (default OFF), set_policy carries only allowArtifactRead
        const artifactToggle = container.querySelector<HTMLInputElement>(`[data-testid="toggle-artifact-read-${MESH_ALPHA}"]`)!
        expect(artifactToggle).not.toBeNull()
        expect(artifactToggle.checked).toBe(false)
        send.mockClear()
        await act(async () => { artifactToggle.click() })
        await flush()
        expect(send).toHaveBeenCalledWith(HOST_A, 'assistant_remote_project_access', {
            action: 'set_policy',
            meshId: MESH_ALPHA,
            allowArtifactRead: true,
        })
        expect(artifactToggle.checked).toBe(true)
        // on -> off reflects the host's authoritative response
        await act(async () => { artifactToggle.click() })
        await flush()
        expect(send).toHaveBeenLastCalledWith(HOST_A, 'assistant_remote_project_access', {
            action: 'set_policy', meshId: MESH_ALPHA, allowArtifactRead: false,
        })
        expect(artifactToggle.checked).toBe(false)
        // failed set_policy reverts (checkbox keeps the last authoritative value)
        failNextPolicy = true
        await act(async () => { artifactToggle.click() })
        await flush()
        expect(artifactToggle.checked).toBe(false)
        expect(container.textContent).toContain('policy_boom')

        // 3. 'Stop following' is local-only (calls assistant_remote_follow unfollow, NEVER revokes host)
        send.mockClear()
        const stopBtn = container.querySelector<HTMLButtonElement>(`[data-testid="stop-following-${MESH_ALPHA}"]`)!
        await act(async () => { stopBtn.click() })
        await flush()
        expect(send).toHaveBeenCalledWith(ASST_B, 'assistant_remote_follow', expect.objectContaining({ action: 'unfollow', meshId: MESH_ALPHA }))
        expect(send).not.toHaveBeenCalledWith(HOST_A, 'assistant_remote_project_access', expect.objectContaining({ action: 'revoke' }))
        expect(container.textContent).toContain('Unfollowed locally (host grant still active)')

        // 4. 'Remove access' revokes on remote host AND marks local entry revoked
        send.mockClear()
        const removeAccessBtn = container.querySelector<HTMLButtonElement>(`[data-testid="remove-access-${MESH_ALPHA}"]`)!
        await act(async () => { removeAccessBtn.click() })
        await flush()
        expect(send).toHaveBeenCalledWith(HOST_A, 'assistant_remote_project_access', { action: 'revoke', meshId: MESH_ALPHA })
        expect(send).toHaveBeenCalledWith(ASST_B, 'assistant_remote_follow', expect.objectContaining({ action: 'mark_revoked', meshId: MESH_ALPHA }))
        expect(container.textContent).toContain('Access removed on host')

        // 5. Selecting an offline host shows truthful offline status without calling catalog
        const select = container.querySelector<HTMLSelectElement>('[data-testid="assistant-remote-host-select"]')!
        await act(async () => {
            select.value = HOST_OFFLINE
            select.dispatchEvent(new Event('change', { bubbles: true }))
        })
        await flush()
        expect(container.querySelector('[data-testid="assistant-remote-host-offline"]')).not.toBeNull()
    })
})

