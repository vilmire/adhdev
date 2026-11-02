/**
 * Project file transfer commands.
 *
 * Owner commands (create / approve / cancel / browse / list ...) require a trusted OWNER
 * ingress proof (p2p DataChannel or standalone HTTP/WS): agents (ipc), workers and mesh
 * peers can never approve. `project_transfer_peer` is the daemon<->daemon control op
 * carried over the authenticated mesh relay; the sender id is the transport-stamped one.
 */
import { defineCommandSpecs } from '../command-registry.js';
import { COMMAND_SOURCE_ARG, isTrustedOwnerIngress } from '../command-args.js';
import { readMeshSender } from '../mesh-sender.js';
import { readAuthenticatedMcpCommand, readAuthenticatedMcpScope } from '../mcp-command-ingress.js';
import { stripRouterInternalArgs } from '../router-internal-args.js';
import { getProjectTransferEngine } from '../../transfer/runtime.js';
import { runAgentTransfer } from '../../transfer/agent-transfer.js';
import { resolveMeshScope } from '../../transfer/workspace-scope.js';
import type { TransferRecord } from '../../transfer/store.js';
import type { LowFamilyContext } from './types.js';

type R = { success: boolean; [k: string]: unknown };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function ownerOnly(args: unknown): R | null {
    return isTrustedOwnerIngress(args)
        ? null
        : { success: false, code: 'OWNER_INGRESS_REQUIRED', error: 'Project transfer requires a verified owner connection' };
}

function unavailable(): R {
    return { success: false, code: 'TRANSFER_UNAVAILABLE', error: 'This daemon cannot transfer project files' };
}

function fromEngine(r: { ok: boolean; [k: string]: unknown }): R {
    if (r.ok) { const { ok: _ok, ...rest } = r; return { success: true, ...rest }; }
    return { success: false, code: str(r.code) || 'FAILED', error: str(r.code) || 'FAILED', ...(r.detail ? { detail: r.detail } : {}), ...(r.overwrite ? { overwrite: r.overwrite } : {}) };
}

/** Owner-visible projection. File names are shown to the owner only; keys/paths of the peer never. */
function view(rec: TransferRecord) {
    return {
        id: rec.id, role: rec.role, peerDaemonId: rec.peerDaemonId, state: rec.state, errorCode: rec.errorCode,
        finalName: rec.selection.finalName, publishedName: rec.publishedName,
        sourceWorkspaceId: rec.selection.sourceWorkspaceId, targetWorkspaceId: rec.selection.targetWorkspaceId,
        selectionDigest: rec.selectionDigest, createdAt: rec.createdAt, previewExpiresAt: rec.previewExpiresAt,
        totalBytes: rec.totalBytes, bytesDone: rec.bytesDone,
        fileCount: rec.selection.entries.filter((e) => e.kind === 'file').length,
        entries: rec.selection.entries, excluded: rec.selection.excluded,
        localApproved: !!rec.localApproval, peerApproved: rec.peerApproved === true,
        // Network path of the latest established link; `relay` = bytes crossed a TURN relay (still end-to-end encrypted).
        path: rec.path,
        targetMode: rec.selection.targetMode ?? 'new_folder',
        // Who asked, when a coordinator or the assistant (not the owner's dashboard) created it.
        ...(rec.requestedBy ? { requestedBy: rec.requestedBy } : {}),
        // existing_path preview (names are for the owner's dashboard only): what is new and what would be replaced.
        ...(rec.overwrite ? {
            overwrite: {
                targetDir: rec.overwrite.targetDir, digest: rec.overwrite.digest,
                newCount: rec.overwrite.newFiles.length, replacedCount: rec.overwrite.replaced.length,
                replaced: rec.overwrite.replaced.map((r) => ({ path: r.path, size: r.size })),
                reverted: rec.overwrite.reverted === true,
                revertible: rec.role === 'target' && rec.state === 'completed' && rec.overwrite.replaced.length > 0 && rec.overwrite.reverted !== true,
            },
        } : {}),
        ...(rec.decision ? { decision: rec.decision } : {}),
    };
}

const handlers: Record<string, (ctx: LowFamilyContext, args: any) => Promise<R>> = {
    project_transfer_capabilities: async (_ctx, args) => {
        const denied = ownerOnly(args);
        if (denied) return denied;
        const engine = getProjectTransferEngine();
        if (!engine) return { success: true, supported: false, reasons: ['TRANSFER_UNAVAILABLE'] };
        return { success: true, ...engine.capabilities() };
    },
    // Per-machine option (default ON): allow falling back to a TURN relay when a direct connection fails.
    project_transfer_set_relay: async (_ctx, args) => {
        const denied = ownerOnly(args);
        if (denied) return denied;
        const engine = getProjectTransferEngine();
        if (!engine) return unavailable();
        if (typeof args?.allowRelay !== 'boolean') return { success: false, code: 'INVALID_ARGS', error: 'allowRelay (boolean) required' };
        engine.setRelayAllowed(args.allowRelay);
        return { success: true, relayAllowed: engine.relayAllowed() };
    },
    // Per-machine option (default OFF): agent-requested transfers that replace nothing may skip the owner when BOTH machines allow it.
    project_transfer_set_agent_auto_approve: async (_ctx, args) => {
        const denied = ownerOnly(args);
        if (denied) return denied;
        const engine = getProjectTransferEngine();
        if (!engine) return unavailable();
        if (typeof args?.allow !== 'boolean') return { success: false, code: 'INVALID_ARGS', error: 'allow (boolean) required' };
        engine.setAgentAutoApprove(args.allow);
        return { success: true, agentAutoApprove: engine.agentAutoApproveAllowed() };
    },
    project_transfer_revert: async (_ctx, args) => {
        const denied = ownerOnly(args);
        if (denied) return denied;
        const engine = getProjectTransferEngine();
        if (!engine) return unavailable();
        const r = engine.revert(str(args?.transferId));
        return r.ok ? { success: true, restored: r.result.restored.length, conflicts: r.result.conflicts, transfer: view(r.record) } : fromEngine(r);
    },
    project_transfer_browse: async (_ctx, args) => {
        const denied = ownerOnly(args);
        if (denied) return denied;
        const engine = getProjectTransferEngine();
        if (!engine) return unavailable();
        return fromEngine(engine.browse(str(args?.workspaceId), str(args?.path)));
    },
    project_transfer_create: async (_ctx, args) => {
        const denied = ownerOnly(args);
        if (denied) return denied;
        const engine = getProjectTransferEngine();
        if (!engine) return unavailable();
        const selected = Array.isArray(args?.selected) ? args.selected.filter((s: unknown) => typeof s === 'string') : [];
        const r = await engine.create({
            workspaceId: str(args?.workspaceId), selected, targetDaemonId: str(args?.targetDaemonId),
            targetWorkspaceId: str(args?.targetWorkspaceId), finalName: str(args?.finalName),
            ...(args?.targetMode !== undefined ? { targetMode: args.targetMode } : {}),
            ...(args?.targetDir !== undefined ? { targetDir: str(args.targetDir) } : {}),
        });
        return r.ok ? { success: true, transferId: r.transferId, transfer: view(r.record) } : fromEngine(r);
    },
    project_transfer_approve: async (_ctx, args) => {
        const denied = ownerOnly(args);
        if (denied) return denied;
        const engine = getProjectTransferEngine();
        if (!engine) return unavailable();
        const r = await engine.approve(str(args?.transferId), str(args?.selectionDigest), typeof args?.replaceDigest === 'string' ? args.replaceDigest : undefined);
        return r.ok ? { success: true, transfer: view(r.record) } : fromEngine(r);
    },
    project_transfer_revoke_approval: async (_ctx, args) => {
        const denied = ownerOnly(args);
        if (denied) return denied;
        const engine = getProjectTransferEngine();
        return engine ? fromEngine(await engine.revokeApproval(str(args?.transferId))) : unavailable();
    },
    project_transfer_cancel: async (_ctx, args) => {
        const denied = ownerOnly(args);
        if (denied) return denied;
        const engine = getProjectTransferEngine();
        return engine ? fromEngine(await engine.cancel(str(args?.transferId))) : unavailable();
    },
    project_transfer_list: async (_ctx, args) => {
        const denied = ownerOnly(args);
        if (denied) return denied;
        const engine = getProjectTransferEngine();
        if (!engine) return { success: true, transfers: [], supported: false };
        return { success: true, transfers: engine.list().map(view), supported: engine.capabilities().supported };
    },
    project_transfer_status: async (_ctx, args) => {
        const denied = ownerOnly(args);
        if (denied) return denied;
        const rec = getProjectTransferEngine()?.get(str(args?.transferId));
        return rec ? { success: true, transfer: view(rec) } : { success: false, code: 'NOT_FOUND', error: 'NOT_FOUND' };
    },
    project_transfer_peer: async (_ctx, args) => {
        const engine = getProjectTransferEngine();
        if (!engine) return unavailable();
        const sender = readMeshSender(args);
        if (!sender) return { success: false, code: 'PEER_UNAUTHORIZED', error: 'PEER_UNAUTHORIZED' };
        const reply = await engine.handlePeerOp(sender, args ?? {});
        return { success: reply.ok === true, ...reply };
    },
};

/**
 * Coordinator verb: request / status / cancel the coordinator's own transfers. Never approves.
 * The caller is the router-recorded MCP capability (MCP_ROLE_CLASSIFIED_COMMANDS), never a payload field;
 * workers and credential-less callers (the owner's CLI uses the owner commands) are refused.
 */
export const PROJECT_TRANSFER_AGENT = 'project_transfer_agent';

export function classifyTransferAgentCaller(raw: Record<string, unknown>): { ok: true; sessionId: string; meshId: string } | { ok: false; error: string } {
    if (raw.bind !== undefined || raw.token !== undefined || raw.mcpSessionCredential !== undefined) return { ok: false, error: 'worker credentials cannot request transfers' };
    const mcp = readAuthenticatedMcpCommand(raw, PROJECT_TRANSFER_AGENT);
    const scope = mcp.present && mcp.valid ? readAuthenticatedMcpScope(raw, PROJECT_TRANSFER_AGENT) : null;
    if (!scope?.sessionId || scope.isCoordinator !== true || !scope.meshId) {
        return { ok: false, error: `${raw[COMMAND_SOURCE_ARG] === 'ipc' ? 'only a mesh coordinator session' : 'this transport'} can request project transfers` };
    }
    return { ok: true, sessionId: scope.sessionId, meshId: scope.meshId };
}

handlers.project_transfer_agent = async (_ctx, rawArgs) => {
    const raw = (rawArgs ?? {}) as Record<string, unknown>;
    const caller = classifyTransferAgentCaller(raw);
    if (!caller.ok) return { success: false, code: 'transfer_agent_not_allowed', error: caller.error };
    const args = stripRouterInternalArgs(raw) as Record<string, unknown>;
    // The coordinator may export only workspaces of the nodes of its OWN mesh on this machine.
    const engine = getProjectTransferEngine();
    const scope = engine ? resolveMeshScope(caller.meshId, engine.selfId()) : null;
    return runAgentTransfer({ role: 'coordinator', sessionId: caller.sessionId, meshId: caller.meshId }, args, {
        sourceWorkspaceIds: scope ? new Set(scope.workspaces.map((w) => w.id)) : null,
    });
};

const OWNER_SOURCES = ['p2p', 'standalone'] as const;

export const projectTransferSpecs = defineCommandSpecs('low', handlers, {
    project_transfer_capabilities: { sources: OWNER_SOURCES },
    project_transfer_set_relay: { sources: OWNER_SOURCES },
    project_transfer_set_agent_auto_approve: { sources: OWNER_SOURCES },
    project_transfer_revert: { sources: OWNER_SOURCES },
    project_transfer_agent: { sources: ['ipc'] },
    project_transfer_browse: { sources: OWNER_SOURCES },
    project_transfer_create: { sources: OWNER_SOURCES },
    project_transfer_approve: { sources: OWNER_SOURCES },
    project_transfer_revoke_approval: { sources: OWNER_SOURCES },
    project_transfer_cancel: { sources: OWNER_SOURCES },
    project_transfer_list: { sources: OWNER_SOURCES },
    project_transfer_status: { sources: OWNER_SOURCES },
    project_transfer_peer: { sources: ['mesh'], meshSender: 'authenticated_peer' },
});
