import type { ProviderApprovalTarget } from '@adhdev/mesh-shared';
import type { DaemonData } from '../../types';
import type { PendingApprovalItem } from './PendingApprovalsInbox';

/** Owner dashboard metadata is already roster-authorized. Hidden/muted chat policy
 * deliberately does not filter this separate provider decision lane. */
export function deriveProviderApprovalInbox(ides: DaemonData[], connections: Record<string, string>): PendingApprovalItem[] {
    const items = new Map<string, PendingApprovalItem>();
    for (const ide of ides) {
        const approval = ide.activeChat?.providerApproval;
        if (!approval || approval.source !== 'provider_modal' || approval.lifecycle !== 'pending') continue;
        const sessionId = approval.sessionId || ide.sessionId;
        const daemonId = ide.ownerDaemonId || ide.daemonId;
        if (!sessionId || !daemonId) continue;
        const connected = ['connected', 'ready'].includes(connections[ide.machineId || daemonId]);
        const live = connected && approval.evidence === 'live';
        const completeModal = Array.isArray(approval.buttons) && approval.buttons.some(button => typeof button === 'string' && button.trim());
        const actionable = completeModal && live && approval.actionable && approval.type === 'tool_permission' && !!approval.modalKey;
        const target: ProviderApprovalTarget | undefined = actionable ? {
            modalKey: approval.modalKey!, attemptId: approval.attemptId ?? null, generation: approval.generation ?? null,
        } : undefined;
        const item: PendingApprovalItem = {
            nodeId: daemonId, sessionId, providerType: approval.providerType || ide.type,
            machineLabel: ide.ownerMachineName || ide.hostname || daemonId,
            runtimeDirectory: approval.runtimeDirectory, displayedDirectory: approval.displayedDirectory,
            waitingSince: approval.createdAt, actionable, approvalTarget: target,
            approvalType: approval.type, evidence: !connected || approval.evidence === 'cached' ? 'cached' : !completeModal ? 'unavailable' : approval.evidence,
            // Full provider text belongs to the exact session modal, never this lane.
            detail: null,
        };
        const key = `${daemonId}:${sessionId}`;
        const old = items.get(key);
        if (!old || (item.actionable && !old.actionable)) items.set(key, item);
    }
    return [...items.values()].sort((a, b) => (a.waitingSince ?? Infinity) - (b.waitingSince ?? Infinity));
}
