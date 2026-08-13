/**
 * runWizardPolicyCommit — the setup wizard's final-commit orchestration.
 *
 * The contract this pins:
 *  - Application ORDER: per-node slots → mesh policy patch → quota overrides.
 *    Slots are node writes, policy/quota are mesh writes; a user reading a
 *    partial failure must be able to trust what came before what.
 *  - A stage with nothing staged issues NO command at all (skipping a step
 *    must never write).
 *  - Stages are independent: one failing stage does not abort the rest, and
 *    every failure is collected (partial commit is explicit, never silent).
 *  - The scheduling write maps the 2-mode façade to the raw strategy
 *    (distributionToStrategy) and merges the patch OVER the current policy,
 *    exactly like MeshDetailView's onUpdatePolicy.
 */
import { describe, expect, it } from 'vitest'
import { runWizardPolicyCommit, type WizardPolicyCommitOptions } from '../../../src/components/setup-wizard/wizardCommit'

interface Call { daemonId: string; type: string; payload: any }

function makeTransport(respond?: (call: Call) => any) {
    const calls: Call[] = []
    const sendCommand = async (daemonId: string, type: string, payload?: any) => {
        const call = { daemonId, type, payload }
        calls.push(call)
        return respond ? respond(call) : { success: true }
    }
    return { calls, sendCommand }
}

const base = (overrides: Partial<WizardPolicyCommitOptions>): WizardPolicyCommitOptions => ({
    sendCommand: async () => ({ success: true }),
    unwrapResult: (raw: any) => raw,
    targetDaemonId: 'daemon-1',
    meshId: 'mesh-1',
    currentPolicy: { schedulingStrategy: 'first_eligible', requireApprovalForPush: true },
    ...overrides,
})

describe('runWizardPolicyCommit', () => {
    it('writes nothing when no step staged anything', async () => {
        const { calls, sendCommand } = makeTransport()
        const result = await runWizardPolicyCommit(base({ sendCommand }))
        expect(calls).toEqual([])
        expect(result).toEqual({ ok: true, applied: [], errors: [] })
    })

    it('applies slots → policy → quota in order', async () => {
        const { calls, sendCommand } = makeTransport()
        const result = await runWizardPolicyCommit(base({
            sendCommand,
            slotsByNodeId: { 'node-a': [{ provider: 'claude-cli' } as any] },
            distribution: 'smart',
            approvalPatch: { requireApprovalForPush: false },
            quotaRouting: { sessionMinRemainingPercent: 25 },
        }))
        expect(calls.map(c => c.type)).toEqual(['update_mesh_node', 'update_mesh', 'mesh_quota_routing_set'])
        expect(result.ok).toBe(true)
        expect(result.applied).toEqual(['slots', 'policy', 'quota'])
    })

    it('maps the distribution façade to the raw strategy and merges over current policy', async () => {
        const { calls, sendCommand } = makeTransport()
        await runWizardPolicyCommit(base({ sendCommand, distribution: 'smart' }))
        const policyCall = calls.find(c => c.type === 'update_mesh')
        expect(policyCall?.payload).toEqual({
            meshId: 'mesh-1',
            policy: { schedulingStrategy: 'fitness', requireApprovalForPush: true },
        })
    })

    it('writes one update_mesh_node per staged node with a minimal slots-only patch', async () => {
        const { calls, sendCommand } = makeTransport()
        const slots = [{ provider: 'codex-cli' } as any]
        await runWizardPolicyCommit(base({
            sendCommand,
            slotsByNodeId: { 'node-a': slots, 'node-b': [] },
        }))
        const nodeCalls = calls.filter(c => c.type === 'update_mesh_node')
        expect(nodeCalls).toHaveLength(2)
        expect(nodeCalls[0].payload).toEqual({ meshId: 'mesh-1', nodeId: 'node-a', policy: { slots } })
        // An explicit empty array clears the node's slots (legacy-routing fallback).
        expect(nodeCalls[1].payload).toEqual({ meshId: 'mesh-1', nodeId: 'node-b', policy: { slots: [] } })
    })

    it('a failing stage does not abort the remaining stages', async () => {
        const { calls, sendCommand } = makeTransport(call =>
            call.type === 'update_mesh' ? { success: false, error: 'policy rejected' } : { success: true })
        const result = await runWizardPolicyCommit(base({
            sendCommand,
            distribution: 'in_order',
            quotaRouting: { weeklyMinRemainingPercent: 40 },
        }))
        expect(calls.map(c => c.type)).toEqual(['update_mesh', 'mesh_quota_routing_set'])
        expect(result.ok).toBe(false)
        expect(result.applied).toEqual(['quota'])
        expect(result.errors).toEqual([{ stage: 'policy', nodeId: undefined, message: 'policy rejected' }])
    })

    it('collects per-node slot failures with the node id attached', async () => {
        const { sendCommand } = makeTransport(call =>
            call.payload?.nodeId === 'node-b' ? { success: false, error: 'unknown node' } : { success: true })
        const result = await runWizardPolicyCommit(base({
            sendCommand,
            slotsByNodeId: { 'node-a': [], 'node-b': [] },
        }))
        expect(result.ok).toBe(false)
        expect(result.applied).toEqual([]) // slots stage not fully applied
        expect(result.errors).toEqual([{ stage: 'slots', nodeId: 'node-b', message: 'unknown node' }])
    })

    it('surfaces transport exceptions as stage errors, not throws', async () => {
        const result = await runWizardPolicyCommit(base({
            sendCommand: async () => { throw new Error('daemon unreachable') },
            quotaRouting: {},
        }))
        expect(result.ok).toBe(false)
        expect(result.errors[0]).toEqual({ stage: 'quota', nodeId: undefined, message: 'daemon unreachable' })
    })

    it('honors the platform unwrapResult seam (cloud nested result)', async () => {
        const { calls, sendCommand } = makeTransport(() => ({ result: { success: true } }))
        const result = await runWizardPolicyCommit(base({
            sendCommand,
            unwrapResult: (raw: any) => raw?.result ?? raw,
            distribution: 'smart',
        }))
        expect(calls).toHaveLength(1)
        expect(result.ok).toBe(true)
    })
})
