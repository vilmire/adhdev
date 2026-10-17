/**
 * Owner Inbox one-tap: mesh_approve's exact-button form reaches the owning
 * daemon as `resolve_action { approvalTarget, button, buttonIndex }`. The
 * coordinator daemon forwards it verbatim (it holds no session to check), and
 * the owner re-runs every exact-target guard: a replaced/stale episode is
 * refused, never answered.
 */
import { describe, expect, it, vi } from 'vitest'

import { DaemonCommandRouter } from '../../src/commands/router'
import { handleResolveAction } from '../../src/commands/chat-commands-write.js'
import { ProviderApprovalLifecycle } from '../../src/providers/spec/provider-approval-lifecycle.js'

const BUTTONS = ['Yes', "Yes, and don't ask again for npm test", 'No']
const modal = { message: 'Run npm test?', buttons: BUTTONS }

function createRouter(dispatchMeshCommand: ReturnType<typeof vi.fn>) {
    return new DaemonCommandRouter({
        commandHandler: { handle: vi.fn(async () => ({ success: false, error: 'ran locally' })) } as any,
        cliManager: { handleCliCommand: vi.fn(async () => ({ success: true })) } as any,
        cdpManagers: new Map(),
        providerLoader: { resolve: vi.fn(() => null), getMeta: vi.fn(() => null) } as any,
        instanceManager: { collectAllStates: () => [], listInstanceIds: () => [], getInstance: () => null } as any,
        detectedIdes: { value: [] },
        sessionRegistry: {} as any,
        sessionHostControl: { listSessions: vi.fn(async () => []) } as any,
        packageName: 'adhdev',
        statusVersion: '0.9.82',
        statusInstanceId: 'daemon_mach_coordinator',
        dispatchMeshCommand: dispatchMeshCommand as any,
    })
}

function episode() {
    const lifecycle = new ProviderApprovalLifecycle()
    const state: any = { id: 'permission', status: 'approval' }
    const parsed: any = { kind: 'approval', message: modal.message, buttons: BUTTONS.map((label, index) => ({ label, index })) }
    lifecycle.observe(state, parsed, 1000)
    const replace = () => { lifecycle.resolve(2000); lifecycle.observe({ id: 'busy', status: 'busy' } as any, null, 2100); lifecycle.observe(state, parsed, 3000) }
    return { lifecycle, replace }
}

function ownerHelper(lifecycle: ProviderApprovalLifecycle) {
    const resolveModalMatched = vi.fn(() => true)
    const adapter = { getStatus: () => ({ status: 'waiting_approval', activeModal: modal, providerApproval: lifecycle.read() }), resolveModalMatched }
    const helper: any = { getProvider: () => ({ type: 'codex-cli', category: 'cli' }), getCliAdapter: () => adapter,
        currentSession: { transport: 'pty', sessionId: 'worker', providerType: 'codex-cli' }, ctx: { instanceManager: { getInstance: () => null } } }
    return { helper, resolveModalMatched }
}

async function forwardThroughCoordinator(args: Record<string, unknown>) {
    const dispatchMeshCommand = vi.fn(async (_daemonId: string, _cmd: string, _args: any) => ({ success: true }))
    const router = createRouter(dispatchMeshCommand)
    vi.spyOn(router, 'resolveRemoteMeshSessionOwnerDaemonId').mockReturnValue('daemon_mach_owner')
    await router.execute('resolve_action', args)
    expect(dispatchMeshCommand).toHaveBeenCalledTimes(1)
    const [owner, cmd, forwarded] = dispatchMeshCommand.mock.calls[0]!
    expect(owner).toBe('daemon_mach_owner')
    expect(cmd).toBe('resolve_action')
    return forwarded as Record<string, unknown>
}

describe('resolve_action exact provider button — mesh forwarding to the owning daemon', () => {
    it('forwards button + buttonIndex together with the approvalTarget, and the owner presses exactly that button', async () => {
        const { lifecycle } = episode()
        const approvalTarget = { modalKey: lifecycle.read()!.modalKey!, attemptId: null, generation: null }
        const forwarded = await forwardThroughCoordinator({ sessionId: 'worker', targetSessionId: 'worker', action: 'approve', approvalTarget, button: BUTTONS[1], buttonIndex: 1 })
        expect(forwarded).toMatchObject({ targetSessionId: 'worker', action: 'approve', approvalTarget, button: BUTTONS[1], buttonIndex: 1 })

        const { helper, resolveModalMatched } = ownerHelper(lifecycle)
        expect(await handleResolveAction(helper, forwarded)).toMatchObject({ success: true, buttonIndex: 1, button: BUTTONS[1] })
        expect(resolveModalMatched).toHaveBeenCalledExactlyOnceWith(1)
    })

    it('a stale (replaced) episode is refused on the owner without writing keys', async () => {
        const { lifecycle, replace } = episode()
        const stale = { modalKey: lifecycle.read()!.modalKey!, attemptId: null, generation: null }
        const forwarded = await forwardThroughCoordinator({ sessionId: 'worker', targetSessionId: 'worker', action: 'approve', approvalTarget: stale, button: 'Yes', buttonIndex: 0 })
        replace()
        const { helper, resolveModalMatched } = ownerHelper(lifecycle)
        expect(await handleResolveAction(helper, forwarded)).toMatchObject({ success: false, stalePrompt: true })
        expect(resolveModalMatched).not.toHaveBeenCalled()
    })

    it('a mismatched target modalKey or a polarity mismatch is refused, not answered', async () => {
        const { lifecycle } = episode()
        const { helper, resolveModalMatched } = ownerHelper(lifecycle)
        const target = { modalKey: lifecycle.read()!.modalKey!, attemptId: null, generation: null }
        const wrongKey = await forwardThroughCoordinator({ targetSessionId: 'worker', action: 'approve', approvalTarget: { ...target, modalKey: 'modal:other' }, button: 'Yes' })
        expect(await handleResolveAction(helper, wrongKey)).toMatchObject({ success: false, stalePrompt: true })
        const polarity = await forwardThroughCoordinator({ targetSessionId: 'worker', action: 'approve', approvalTarget: target, button: 'No', buttonIndex: 2 })
        expect(await handleResolveAction(helper, polarity)).toMatchObject({ success: false, code: 'approval_button_action_mismatch' })
        expect(resolveModalMatched).not.toHaveBeenCalled()
    })
})
