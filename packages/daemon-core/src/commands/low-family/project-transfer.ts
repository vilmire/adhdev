/**
 * Project file transfer commands.
 *
 * Owner commands (create / approve / cancel / browse / list ...) require a trusted OWNER
 * ingress proof (p2p DataChannel or standalone HTTP/WS): agents (ipc), workers and mesh
 * peers can never approve. `project_transfer_peer` is the daemon<->daemon control op
 * carried over the authenticated mesh relay; the sender id is the transport-stamped one.
 */
import { defineCommandSpecs } from '../command-registry.js';
import { isTrustedOwnerIngress } from '../command-args.js';
import { readMeshSender } from '../mesh-sender.js';
import { getProjectTransferEngine } from '../../transfer/runtime.js';
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
    return { success: false, code: str(r.code) || 'FAILED', error: str(r.code) || 'FAILED', ...(r.detail ? { detail: r.detail } : {}) };
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
        });
        return r.ok ? { success: true, transferId: r.transferId, transfer: view(r.record) } : fromEngine(r);
    },
    project_transfer_approve: async (_ctx, args) => {
        const denied = ownerOnly(args);
        if (denied) return denied;
        const engine = getProjectTransferEngine();
        if (!engine) return unavailable();
        const r = await engine.approve(str(args?.transferId), str(args?.selectionDigest));
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

const OWNER_SOURCES = ['p2p', 'standalone'] as const;

export const projectTransferSpecs = defineCommandSpecs('low', handlers, {
    project_transfer_capabilities: { sources: OWNER_SOURCES },
    project_transfer_browse: { sources: OWNER_SOURCES },
    project_transfer_create: { sources: OWNER_SOURCES },
    project_transfer_approve: { sources: OWNER_SOURCES },
    project_transfer_revoke_approval: { sources: OWNER_SOURCES },
    project_transfer_cancel: { sources: OWNER_SOURCES },
    project_transfer_list: { sources: OWNER_SOURCES },
    project_transfer_status: { sources: OWNER_SOURCES },
    project_transfer_peer: { sources: ['mesh'], meshSender: 'authenticated_peer' },
});
