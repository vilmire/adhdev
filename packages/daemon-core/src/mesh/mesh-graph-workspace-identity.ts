/**
 * GRAPH-ORCHESTRATION Phase D — deterministic workspace identity.
 *
 * Design SoT: docs/design/2026-08-18-graph-orchestration-full.md :441-511.
 * The server derives a branch/name suffix from graph id + workspace ref so
 * clone/bind/compensate share one idempotency key. Owner tags are stamped on
 * the prepared worktree (git config, never a working-tree file — a working-tree
 * stamp would dirty the tree and then refuse its own compensation).
 */

export const WORKSPACE_OWNER_GIT_CONFIG_KEY = 'adhdev.workspaceOwner';

/** Lease duration for one saga step. Expired leases are taken over with a higher generation. */
export const WORKSPACE_SAGA_LEASE_MS = 60_000;

const UNSAFE_BRANCH_CHARS = /[/\\:*?"<>|\s]+/g;

/** design :467 — deterministic branch/name suffix from graph ID plus workspace ref. */
export function deriveWorkspaceBranchIdentity(graphId: string, workspaceRef: string, purpose?: string): string {
    const graphStem = sanitizeIdentityPart(graphId).slice(0, 8);
    const refStem = sanitizeIdentityPart(workspaceRef).slice(0, 40);
    const purposeStem = purpose ? sanitizeIdentityPart(purpose).slice(0, 24) : '';
    const parts = ['graph', graphStem, refStem];
    if (purposeStem && purposeStem !== refStem) parts.push(purposeStem);
    return parts.join('-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/** Ownership stamp verified before any compensation delete (design :497-504). */
export function deriveWorkspaceOwnerTag(graphId: string, workspaceRef: string, leaseGeneration: number): string {
    return `adhdev-graph-ws:${graphId}:${workspaceRef}:g${Math.max(0, leaseGeneration)}`;
}

/** Idempotency key for the external clone step — graph/workspace ids, never a new UUID. */
export function deriveWorkspaceCloneIdempotencyKey(graphId: string, workspaceRef: string): string {
    return `graph-ws-clone:${graphId}:${workspaceRef}`;
}

export function workspaceWorktreeAffinityTag(branchIdentity: string): string {
    return `worktree=${branchIdentity}`;
}

export function readWorkspaceRefFromSpec(baseSpec: unknown): string | undefined {
    if (!baseSpec || typeof baseSpec !== 'object' || Array.isArray(baseSpec)) return undefined;
    const raw = (baseSpec as Record<string, unknown>).workspace_ref;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function sanitizeIdentityPart(value: string): string {
    return value.replace(UNSAFE_BRANCH_CHARS, '-').replace(/^\.+|\.+$/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'ws';
}
