import type { ProviderApproval, ProviderApprovalTarget } from '@adhdev/mesh-shared';
import { resolveTurnAttemptRow } from '../mesh/mesh-turn-presentation.js';

/** Attach current turn authority without fabricating tasks for pre-claim setup gates. */
export function projectProviderApproval(approval: ProviderApproval | null | undefined, sessionId: string, providerType: string, waiting = false): ProviderApproval | null {
    if (!approval) return waiting ? { source: 'provider_modal', type: 'unknown', evidence: 'unavailable', lifecycle: 'pending', modalKey: null, createdAt: null, resolvedAt: null, description: '', buttons: [], actionable: false, sessionId, providerType } : null;
    const candidate = resolveTurnAttemptRow({ sessionId });
    const row = (approval.attemptId && candidate?.attemptId !== approval.attemptId) || approval.type === 'provider_setup' && candidate && ['completed', 'failed', 'cancelled'].includes(candidate.stage) ? null : candidate;
    const suspended = row?.providerSuspension;
    const current = suspended?.generation === row?.generation && suspended?.modalKey === approval.modalKey;
    const boundElsewhere = row?.providerSuspension && !current;
    const terminal = row && ['completed', 'failed', 'cancelled'].includes(row.stage);
    return {
        ...approval, sessionId, providerType,
        nodeId: row?.nodeId ?? approval.nodeId ?? null, meshId: row?.meshId ?? approval.meshId ?? null, taskId: row?.taskId ?? approval.taskId ?? null,
        attemptId: row?.attemptId ?? approval.attemptId ?? null, generation: row?.generation ?? approval.generation ?? null,
        createdAt: current ? suspended!.at : approval.createdAt,
        resolvedAt: current ? suspended!.resolvedAt ?? approval.resolvedAt : approval.resolvedAt,
        lifecycle: terminal || (current && suspended!.resolvedAt !== null) ? 'resolved' : approval.lifecycle,
        actionable: approval.actionable && !boundElsewhere && !terminal && !(current && suspended!.resolvedAt !== null),
    };
}

/** Fail closed before any PTY write, including replay against a replacement modal. */
export function matchesProviderApprovalTarget(approval: ProviderApproval | null, target: ProviderApprovalTarget): boolean {
    return !!approval && approval.source === 'provider_modal' && approval.type === 'tool_permission' && approval.evidence === 'live'
        && approval.lifecycle === 'pending' && approval.actionable && !!approval.modalKey
        && Array.isArray(approval.buttons) && approval.buttons.some(button => typeof button === 'string' && button.trim())
        && approval.modalKey === target.modalKey
        && (approval.attemptId ?? null) === target.attemptId
        && (approval.generation ?? null) === target.generation;
}
