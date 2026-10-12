/** Provider permissions are runtime decisions, never owner write ratification. */
export interface ProviderApproval {
    source: 'provider_modal' | 'legacy_provider' | 'status_only' | 'ledger_approval';
    /** Exact Inbox actions or the existing session handler; never inferred consent. */
    compatibility?: 'exact' | 'session_only' | 'unknown';
    type: 'tool_permission' | 'provider_setup' | 'unknown';
    evidence: 'live' | 'cached' | 'unavailable';
    lifecycle: 'pending' | 'resolved';
    modalKey: string | null;
    createdAt: number | null;
    resolvedAt: number | null;
    description: string;
    runtimeDirectory?: string;
    displayedDirectory?: string | null;
    buttons: string[];
    actionable: boolean;
    providerType?: string;
    sessionId?: string;
    nodeId?: string | null;
    meshId?: string | null;
    taskId?: string | null;
    attemptId?: string | null;
    generation?: number | null;
}

/** Exact resource identity required by the approvals-only action path. */
export interface ProviderApprovalTarget {
    modalKey: string;
    attemptId: string | null;
    generation: number | null;
}

/** Confirmed authority for the new Inbox path. Legacy handlers retain their own checks. */
export function isActionableProviderApproval(approval: ProviderApproval | null | undefined): boolean {
    return !!approval && approval.source === 'provider_modal' && approval.type === 'tool_permission'
        && approval.lifecycle === 'pending' && approval.evidence === 'live' && approval.actionable
        && !!approval.modalKey && Array.isArray(approval.buttons)
        && approval.buttons.some(button => typeof button === 'string' && !!button.trim());
}

/** An explicit null suppresses the resource; only missing metadata uses compatibility. */
export function readProviderDecision(approval: ProviderApproval | null | undefined, waiting: boolean, hasModal = false): ProviderApproval | null {
    if (approval !== undefined) return approval && ['provider_modal', 'legacy_provider', 'status_only', 'ledger_approval'].includes(approval.source) ? approval : null;
    if (!waiting) return null;
    return { source: hasModal ? 'legacy_provider' : 'status_only', type: 'unknown',
        compatibility: hasModal ? 'session_only' : 'unknown', evidence: 'unavailable',
        lifecycle: 'pending', modalKey: null, createdAt: null, resolvedAt: null,
        description: '', buttons: [], actionable: false };
}

/** Host metadata is durable: identity and clocks only, never modal text or directories. */
export function providerApprovalSnapshot(approval: ProviderApproval | null | undefined): ProviderApproval | null {
    if (!approval) return null;
    const { source, type, lifecycle, modalKey, createdAt, resolvedAt, providerType, sessionId,
        nodeId, meshId, taskId, attemptId, generation } = approval;
    return { source, type, lifecycle, modalKey, createdAt, resolvedAt, providerType, sessionId,
        nodeId, meshId, taskId, attemptId, generation, evidence: 'cached', actionable: false,
        description: '', buttons: [] };
}
