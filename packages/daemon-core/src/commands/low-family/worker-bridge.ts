import { toReportResponse, toProgressResponse } from './worker-report.js';
import { daemonIdsEquivalent, meshNodeIdMatches } from '@adhdev/mesh-shared';
import { defineCommandSpecs } from '../command-registry.js';
import { unwrapMeshRelayResult } from '../mesh-relay-result.js';
import { readMeshSender } from '../mesh-sender.js';
import type { LowFamilyContext, LowFamilyHandler } from './types.js';
import { MeshRuntimeStore } from '../../mesh/mesh-runtime-store.js';
import { readMeshNodeDaemonId } from '../../mesh/mesh-node-identity.js';
import { resolveForwardedWorkerIdentity, acceptForwardedWorkerCompletionReport } from '../../mesh/worker-report-forwarded.js';
import { acceptForwardedWorkerProgressUpdate } from '../../mesh/worker-report-progress.js';
import { validateWorkerCompletionReport } from '../../mesh/worker-report-validation.js';
import { recordRefusedWorkerReportForIdentity, safeRefusalFields } from '../../mesh/worker-report.js';
import { bridgeCapability, bridgeIdentity, receiveBridgeDelivery, readBridgePolicy, setBridgePolicy, ensureBridgeSchema, bridgeDrainState, queryBridgePeer, BRIDGE_CAPABILITY_COMMAND, BRIDGE_DELIVERY_COMMAND, type BridgePolicy, type BridgeEnvelope, decodeBridgeEnvelope } from '../../mesh/worker-bridge.js';

function identity(ctx: LowFamilyContext) { return bridgeIdentity(ctx.deps.statusInstanceId ?? '', ctx.deps.statusVersion); }
function applyEnvelope(ctx: LowFamilyContext, e: BridgeEnvelope, nodeOwner: (nodeId: string) => string | undefined) {
    const sender = { senderDaemonId: readMeshSender({ _meshSenderDaemonId: e.senderDaemonId }), nodeDaemonId: nodeOwner };
    const isSelfDaemon = (value: string) => daemonIdsEquivalent(value, ctx.deps.statusInstanceId ?? '');
    const resolved = resolveForwardedWorkerIdentity(e, sender, Date.now(), isSelfDaemon);
    if ('refused' in resolved) return { success: false, error: 'unauthenticated', detail: resolved.refused };
    const proven = 'live' in resolved ? resolved.live : resolved.late;
    // eslint-disable-next-line no-restricted-syntax -- Immutable prepared envelope must match the resolved stored claim byte-for-byte.
    if (proven.nodeId !== e.nodeId || proven.sessionId !== e.sessionId || proven.taskId !== e.taskId || proven.attemptId !== e.attemptId) return { success: false, error: 'unauthenticated', detail: 'exact_identity_mismatch' };
    const payload = e.payload;
    if (e.kind === 'report') {
        if (Object.keys(payload).join() !== 'report') return { success: false, error: 'invalid_worker_bridge_payload' };
        const { report } = validateWorkerCompletionReport(payload.report);
        if (!report) return { success: false, error: 'invalid_worker_bridge_payload' };
        const result = acceptForwardedWorkerCompletionReport(e, report, { sender, isSelfDaemon, reportedAtMs: e.reportedAtMs });
        return toReportResponse(result);
    }
    if (e.kind === 'progress') {
        if (Object.keys(payload).join() !== 'note' || typeof payload.note !== 'string' || !payload.note.trim()) return { success: false, error: 'invalid_worker_bridge_payload' };
        const result = acceptForwardedWorkerProgressUpdate(e, payload.note, { sender, isSelfDaemon, reportedAtMs: e.reportedAtMs, deliveryId: e.deliveryId });
        return toProgressResponse(result);
    }
    if (Object.keys(payload).sort().join() !== 'fields,summaryLength' || !Array.isArray(payload.fields) || payload.fields.length > 16
        || stableFields(payload.fields) !== stableFields(safeRefusalFields(payload.fields))
        || !(payload.summaryLength === null || (Number.isSafeInteger(payload.summaryLength) && Number(payload.summaryLength) >= 0))) return { success: false, error: 'invalid_worker_bridge_payload' };
    const receipt = recordRefusedWorkerReportForIdentity(proven, { fields: payload.fields as string[], summaryLength: payload.summaryLength as number | null }, { generation: e.generation, deliveryId: e.deliveryId, reportedAtMs: e.reportedAtMs });
    return receipt?.recorded ? { success: false, error: 'invalid_report', receipt } : { success: false, error: 'storage_failed' };
}
function stableFields(value: unknown) { return JSON.stringify(value); }

export const workerBridgeHandlers: Record<string, LowFamilyHandler> = {
    [BRIDGE_CAPABILITY_COMMAND]: async (ctx, args) => bridgeCapability(MeshRuntimeStore.getInstance().db, identity(ctx), args?.meshId, args?.nonce),
    [BRIDGE_DELIVERY_COMMAND]: async (ctx, args) => {
        if (!ctx.deps.dispatchMeshCommand || args?.meshId !== args?.envelope?.meshId) return { success: false, error: 'worker_protocol_unsupported' };
        const envelope = decodeBridgeEnvelope(args.envelope);
        if (!envelope) return { success: false, error: 'invalid_worker_bridge_envelope' };
        // Never journal a rejected body. Valid reports/progress are private
        // local envelopes; refusals have only allow-listed metadata.
        const payload = envelope.payload;
        const validPayload = envelope.kind === 'report' ? Object.keys(payload).join() === 'report' && !!validateWorkerCompletionReport(payload.report).report
            : envelope.kind === 'progress' ? Object.keys(payload).join() === 'note' && typeof payload.note === 'string' && !!payload.note.trim()
            : Object.keys(payload).sort().join() === 'fields,summaryLength' && Array.isArray(payload.fields) && payload.fields.length <= 16
                && stableFields(payload.fields) === stableFields(safeRefusalFields(payload.fields))
                && (payload.summaryLength === null || (Number.isSafeInteger(payload.summaryLength) && Number(payload.summaryLength) >= 0));
        if (!validPayload) return { success: false, error: 'invalid_worker_bridge_payload' };
        const native = (await ctx.getMeshForCommand?.(args.meshId, undefined, { preferInline: true }))?.mesh;
        const policy = readBridgePolicy(MeshRuntimeStore.getInstance().db, args.meshId);
        const mesh = native ?? { nodes: policy?.roster?.map((node) => ({ id: node.nodeId, daemonId: node.daemonId })) };
        const nodeOwner = (nodeId: string) => {
            const node = mesh?.nodes?.find((candidate: Parameters<typeof meshNodeIdMatches>[0]) => meshNodeIdMatches(candidate, nodeId));
            return node ? readMeshNodeDaemonId(node) : undefined;
        };
        return receiveBridgeDelivery(MeshRuntimeStore.getInstance().db, args.envelope, readMeshSender(args), identity(ctx), ctx.deps.dispatchMeshCommand,
            (e) => applyEnvelope(ctx, e, nodeOwner));
    },
    // Local operator surface only. Remote workers cannot arm/unfreeze a rollout.
    worker_bridge_control: async (ctx, args) => {
        const store = MeshRuntimeStore.getInstance();
        ensureBridgeSchema(store.db);
        const policy = args?.policy as BridgePolicy;
        if (policy?.frozen === false) {
            const existing = readBridgePolicy(store.db, policy.meshId), drain = bridgeDrainState(store.db, policy.meshId);
            if (!existing || existing.rolloutId !== policy.rolloutId || drain.openAttempts || drain.correctionOrLivenessHolds || drain.pendingDeliveries
                || args?.verification?.ledgerDigest !== drain.ledgerDigest || !ctx.deps.dispatchMeshCommand) return { success: false, error: 'bridge_reopen_requires_staged_verification' };
            const states = ctx.deps.instanceManager.collectAllStates();
            if (states.some((state) => ['generating','starting','finalizing','waiting_approval','waiting_choice'].includes(String(state.status)) || Number((state as unknown as Record<string, unknown>).pendingOutboundCount) > 0)) return { success: false, error: 'bridge_reopen_not_idle' };
            const mesh = (await ctx.getMeshForCommand?.(policy.meshId, undefined, { preferInline: true }))?.mesh;
            if (!Array.isArray(mesh?.nodes) || !mesh.nodes.length) return { success: false, error: 'bridge_roster_unresolved' };
            for (const node of mesh.nodes) {
                const daemonId = readMeshNodeDaemonId(node);
                if (!daemonId) return { success: false, error: 'bridge_roster_unresolved' };
                if (daemonIdsEquivalent(daemonId, ctx.deps.statusInstanceId ?? '')) continue;
                const peer = await queryBridgePeer(ctx.deps.dispatchMeshCommand, daemonId, policy.meshId, existing);
                if (!peer || peer.openAttempts !== 0 || peer.correctionOrLivenessHolds !== 0 || peer.pendingDeliveries !== 0) return { success: false, error: 'bridge_peer_not_drained' };
            }
        }
        try { setBridgePolicy(store.db, policy); return { success: true, frozen: policy.frozen, rolloutId: policy.rolloutId }; }
        catch { return { success: false, error: 'invalid_bridge_policy' }; }
    },
    worker_bridge_verify: async (ctx, args) => {
        const policy = readBridgePolicy(MeshRuntimeStore.getInstance().db, args?.meshId);
        if (!policy || policy.ownerDaemonId !== args?.expectedHostDaemonId || !policy.roster || !Array.isArray(args?.peerBuilds) || !ctx.deps.dispatchMeshCommand) return { success: false, error: 'bridge_verification_manifest_required' };
        const native = (await ctx.getMeshForCommand?.(args.meshId, undefined, { preferInline: true }))?.mesh;
        if (native?.meshHost?.hostDaemonId && native.meshHost.hostDaemonId !== policy.ownerDaemonId) return { success: false, error: 'bridge_coordinator_identity_mismatch' };
        for (const expected of args.peerBuilds) {
            if (!policy.roster.some((node) => daemonIdsEquivalent(node.daemonId, expected.daemonId)) || !policy.builds.some((build) => build.commit === expected.commit && build.version === expected.version)) return { success: false, error: 'bridge_peer_manifest_mismatch' };
            const raw = await ctx.deps.dispatchMeshCommand(expected.daemonId, 'get_status_metadata', {});
            const peer = unwrapMeshRelayResult(raw, { command: 'get_status_metadata', peerDaemonId: expected.daemonId });
            const status = peer.status as Record<string, unknown> | undefined, build = peer.daemonBuild as Record<string, unknown> | undefined;
            if (peer.success !== true || !daemonIdsEquivalent(String(status?.instanceId ?? ''), expected.daemonId) || build?.commit !== expected.commit || status?.version !== expected.version) return { success: false, error: 'bridge_peer_identity_unconfirmed' };
        }
        return { success: true, p2p: true, coordinator: true, verifiedPeers: args.peerBuilds.map((peer: { daemonId: string }) => peer.daemonId) };
    },
    worker_bridge_status: async (_ctx, args) => {
        const db = MeshRuntimeStore.getInstance().db;
        ensureBridgeSchema(db);
        const policy = readBridgePolicy(db, args?.meshId);

        return { success: true, policy, ...bridgeDrainState(db, args?.meshId), identity: identity(_ctx), launchNonceDigest: process.env.ADHDEV_WORKER_BRIDGE_LAUNCH_NONCE ? (await import('node:crypto')).createHash('sha256').update(process.env.ADHDEV_WORKER_BRIDGE_LAUNCH_NONCE).digest('hex') : null };
    },
};
export const workerBridgeSpecs = defineCommandSpecs('low', workerBridgeHandlers, {
    [BRIDGE_CAPABILITY_COMMAND]: { sources: ['mesh'], meshSender: 'roster' },
    [BRIDGE_DELIVERY_COMMAND]: { sources: ['mesh'], meshSender: 'roster' },
    worker_bridge_control: { sources: ['ipc', 'standalone'] },
    worker_bridge_verify: { sources: ['ipc', 'standalone'] },
    worker_bridge_status: { sources: ['ipc', 'standalone'] },
});
