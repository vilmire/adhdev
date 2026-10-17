import { readProviderDecision, isActionableProviderApproval } from '@adhdev/mesh-shared';
import type { ProviderApprovalTarget } from '@adhdev/mesh-shared';
import type { DaemonData } from '../../types';
import type { PendingApprovalItem } from './PendingApprovalsInbox';

/** Owner dashboard metadata is already roster-authorized. Hidden/muted chat policy
 * deliberately does not filter this separate provider decision lane. */
export function deriveProviderApprovalInbox(ides: DaemonData[], connections: Record<string, string>): PendingApprovalItem[] {
    const items = new Map<string, PendingApprovalItem>();
    for (const ide of ides) {
        if (ide.activeInteractivePrompt || /choice|stopped|exited|terminated|failed/.test(ide.activeChat?.status || ide.status)) continue;
        const waiting = /^(waiting|awaiting)_approval$/.test(ide.activeChat?.status || ide.status);
        const approval = readProviderDecision(ide.activeChat?.providerApproval, waiting, !!ide.activeChat?.activeModal?.buttons?.length);
        if (!approval || approval.lifecycle !== 'pending') continue;
        const sessionId = ide.sessionId || approval.sessionId;
        const daemonId = ide.ownerDaemonId || ide.daemonId;
        if (!sessionId || !daemonId) continue;
        const connected = ['connected', 'ready'].includes(connections[ide.machineId || daemonId]);
        const live = connected && approval.evidence === 'live';
        const completeModal = Array.isArray(approval.buttons) && approval.buttons.some(button => typeof button === 'string' && button.trim());
        const actionable = (!approval.sessionId || approval.sessionId === sessionId) && waiting && live && ide.transport === 'pty' && isActionableProviderApproval(approval);
        const target: ProviderApprovalTarget | undefined = actionable ? {
            modalKey: approval.modalKey!, attemptId: approval.attemptId ?? null, generation: approval.generation ?? null,
        } : undefined;
        const item: PendingApprovalItem = {
            nodeId: daemonId, sessionId, providerType: approval.providerType || ide.type,
            machineLabel: ide.ownerMachineName || ide.hostname || daemonId,
            runtimeDirectory: approval.runtimeDirectory, displayedDirectory: approval.displayedDirectory,
            waitingSince: approval.createdAt, actionable, approvalTarget: target,
            // Exact provider buttons only for a live tool-permission request; labels go
            // back verbatim through the guarded exact-button resolve_action.
            ...(actionable && approval.type === 'tool_permission' && approval.buttons.length > 0 ? { options: [...approval.buttons] } : {}),
            compatibility: approval.compatibility || (approval.source === 'provider_modal' ? ide.transport === 'pty' ? 'exact' : 'session_only' : 'unknown'),
            approvalType: approval.type, evidence: !connected || approval.evidence === 'cached' ? 'cached' : !waiting || !completeModal ? 'unavailable' : approval.evidence,
            // Full provider text belongs to the exact session modal, never this lane.
            detail: null,
        };
        const key = `${daemonId}:${sessionId}`;
        const old = items.get(key);
        if (!old || (item.actionable && !old.actionable)) items.set(key, item);
    }
    return [...items.values()].sort((a, b) => (a.waitingSince ?? Infinity) - (b.waitingSince ?? Infinity));
}
