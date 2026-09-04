import { describe, expect, it, vi } from 'vitest'

import { DaemonCliManager } from '../../src/commands/cli-manager.js'

// CANCEL-STOP-TASK-SCOPE — end-to-end through the real agent_command handler.
//
// The sibling unit suite (mesh-stop-task-scope.test.ts) pins the decision function. This one
// proves the WIRING: that the handler reads the session's real task identity and that a
// refusal actually prevents stopSession from running (a hard stop that removes the instance).
//
//   DEFECT   — cancelling task1 must not kill a session that has moved on to task2.
//   CONTROL  — cancelling task1 MUST still kill a session genuinely running task1.

function createManager(opts: {
    /** adapter.currentTurnTaskId — the per-turn binding. */
    currentTurnTaskId?: string
    /** settings.meshActiveTaskId, read via the instance manager. */
    meshActiveTaskId?: string
} = {}) {
    const shutdown = vi.fn()
    const adapter = {
        cliType: 'hermes-cli',
        cliName: 'Hermes Agent',
        workingDir: '/repo',
        spawn: vi.fn(async () => {}),
        sendMessage: vi.fn(async () => {}),
        getStatus: vi.fn(() => ({ status: 'generating', activeModal: null, messages: [] })),
        getScriptParsedStatus: vi.fn(() => ({ status: 'generating', activeModal: null, messages: [] })),
        getPartialResponse: vi.fn(() => ''),
        shutdown,
        cancel: vi.fn(),
        isProcessing: vi.fn(() => true),
        isReady: vi.fn(() => false),
        setOnStatusChange: vi.fn(),
        ...(opts.currentTurnTaskId ? { currentTurnTaskId: opts.currentTurnTaskId } : {}),
    }
    const instance = {
        getState: () => ({
            status: 'generating',
            settings: opts.meshActiveTaskId ? { meshActiveTaskId: opts.meshActiveTaskId } : {},
        }),
    }
    const manager = new DaemonCliManager({
        getServerConn: () => null,
        getP2p: () => null,
        onStatusChange: vi.fn(),
        removeAgentTracking: vi.fn(),
        getInstanceManager: () => ({ getInstance: () => instance }) as any,
    }, {
        resolve: vi.fn(() => ({ type: 'hermes-cli', category: 'cli' })),
        getMeta: vi.fn(() => ({ type: 'hermes-cli', category: 'cli' })),
    } as any)
    manager.adapters.set('session-1', adapter as any)
    // stopSession is the hard kill under test — spy on it so a refusal is provable as
    // "the session was never touched", not merely "the response said no".
    const stopSession = vi.spyOn(manager, 'stopSession').mockResolvedValue(undefined as any)
    return { manager, adapter, stopSession }
}

function stopCommand(taskId?: string) {
    return {
        targetSessionId: 'session-1',
        agentType: 'hermes-cli',
        cliType: 'hermes-cli',
        action: 'stop',
        ...(taskId ? { meshContext: { meshId: 'mesh-1', taskId } } : {}),
    }
}

describe('DaemonCliManager stop — task scoping (defect)', () => {
    it('refuses to stop a session that has moved on to a DIFFERENT task', async () => {
        // Live 2026-09-02: session finished task1 (queue row stuck in 'assigned'), picked up
        // task2, and the cancel of task1 destroyed task2's work.
        const { manager, stopSession } = createManager({ currentTurnTaskId: 'task2' })

        const result = await manager.handleCliCommand('agent_command', stopCommand('task1'))

        expect(result).toMatchObject({
            success: false,
            stopped: false,
            reason: 'stop_task_mismatch',
            requestedTaskId: 'task1',
            sessionTaskId: 'task2',
        })
        expect(stopSession).not.toHaveBeenCalled()
    })

    it('refuses when only the session scalar shows the session moved on', async () => {
        const { manager, stopSession } = createManager({ meshActiveTaskId: 'task2' })

        const result = await manager.handleCliCommand('agent_command', stopCommand('task1'))

        expect(result).toMatchObject({ stopped: false, reason: 'stop_task_mismatch', sessionTaskId: 'task2' })
        expect(stopSession).not.toHaveBeenCalled()
    })

    it('trusts the per-turn binding over a STALE scalar still naming the cancelled task', async () => {
        const { manager, stopSession } = createManager({
            currentTurnTaskId: 'task2',
            meshActiveTaskId: 'task1', // lagging last-write-wins scalar
        })

        const result = await manager.handleCliCommand('agent_command', stopCommand('task1'))

        expect(result).toMatchObject({ stopped: false, sessionTaskId: 'task2' })
        expect(stopSession).not.toHaveBeenCalled()
    })
})

describe('DaemonCliManager stop — original intent preserved (control group)', () => {
    // Without these, the fix is indistinguishable from having disabled the cancel-stop.
    it('STILL stops a session genuinely running the cancelled task', async () => {
        const { manager, stopSession } = createManager({ currentTurnTaskId: 'task1' })

        const result = await manager.handleCliCommand('agent_command', stopCommand('task1'))

        expect(result).toMatchObject({ success: true, stopped: true, stoppedTaskId: 'task1' })
        expect(stopSession).toHaveBeenCalledWith('session-1')
    })

    it('STILL stops when only the session scalar identifies the cancelled task', async () => {
        const { manager, stopSession } = createManager({ meshActiveTaskId: 'task1' })

        const result = await manager.handleCliCommand('agent_command', stopCommand('task1'))

        expect(result).toMatchObject({ success: true, stopped: true })
        expect(stopSession).toHaveBeenCalledWith('session-1')
    })

    it('STILL stops when the session exposes no task identity at all (fails open)', async () => {
        // A worker mid-boot is the likeliest holder of the task — refusing here would be a
        // worse regression than the defect being fixed.
        const { manager, stopSession } = createManager({})

        const result = await manager.handleCliCommand('agent_command', stopCommand('task1'))

        expect(result).toMatchObject({ success: true, stopped: true })
        expect(stopSession).toHaveBeenCalledWith('session-1')
    })

    it('leaves an UNSCOPED stop (dashboard / operator) completely unchanged', async () => {
        const { manager, stopSession } = createManager({ currentTurnTaskId: 'task_unrelated' })

        const result = await manager.handleCliCommand('agent_command', stopCommand())

        expect(result).toEqual({ success: true, stopped: true })
        expect(stopSession).toHaveBeenCalledWith('session-1')
    })
})
