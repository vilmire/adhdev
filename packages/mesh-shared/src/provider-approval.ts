/** Provider permissions are runtime decisions, never owner write ratification. */
export interface ProviderApproval {
    source: 'provider_modal';
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
