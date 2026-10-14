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
    [BRIDGE_CAPABILITY_COMMAND]: async (ctx, args) => bridgeCapability(MeshRuntimeStore.getInstance().db, identity(ctx), args?.meshId, args?.nonce, args?.deliveryClaim),
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
    // Local freeze/arm surface only. Reopening is unavailable for every caller.
    worker_bridge_control: async (ctx, args) => {
        const policy = args?.policy as BridgePolicy;
        // IPC/standalone reachability is not native release authority. No
        // enforceable supervisor transaction/lease contract exists yet, so
        // caller assertions, drained samples and peer counts cannot reopen.
        if (policy?.frozen === false) return { success: false, error: 'bridge_reopen_native_supervisor_authority_unavailable' };
        const store = MeshRuntimeStore.getInstance();
        ensureBridgeSchema(store.db);
        try { setBridgePolicy(store.db, policy); return { success: true, frozen: policy.frozen, rolloutId: policy.rolloutId }; }
        catch { return { success: false, error: 'invalid_bridge_policy' }; }
    },
    worker_bridge_verify: async (ctx, args) => {
        const policy = readBridgePolicy(MeshRuntimeStore.getInstance().db, args?.meshId);
        if (typeof args?.nonce !== 'string' || args.nonce.length < 8 || !policy || policy.ownerDaemonId !== args?.expectedHostDaemonId || !policy.roster || !Array.isArray(args?.peerBuilds) || !ctx.deps.dispatchMeshCommand) return { success: false, error: 'bridge_verification_manifest_required' };
        if (args.peerBuilds.some((peer: Record<string, unknown> | null) => !peer || typeof peer.daemonId !== 'string' || typeof peer.bootId !== 'string' || !peer.bootId)) return { success: false, error: 'bridge_peer_manifest_mismatch' };
        if (args.peerBuilds.some((peer: { daemonId: string }, index: number) => args.peerBuilds.some((prior: { daemonId: string }, other: number) => other < index && daemonIdsEquivalent(peer.daemonId, prior.daemonId)))) return { success: false, error: 'bridge_peer_manifest_mismatch' };
        const native = (await ctx.getMeshForCommand?.(args.meshId, undefined, { preferInline: true }))?.mesh;
        // The live mesh host reports its own id, which may name the same machine in a
        // different form than the stored policy owner. Match on identity, as the
        // roster/peer checks above and below already do, so an equivalent form of the
        // genuine coordinator is not reported as a mismatch.
        if (native?.meshHost?.hostDaemonId && !daemonIdsEquivalent(native.meshHost.hostDaemonId, policy.ownerDaemonId)) return { success: false, error: 'bridge_coordinator_identity_mismatch' };
        for (const expected of args.peerBuilds) {
            if (typeof expected.bootId !== 'string' || !expected.bootId || !policy.roster.some((node) => daemonIdsEquivalent(node.daemonId, expected.daemonId)) || !policy.builds.some((build) => build.commit === expected.commit && build.version === expected.version)) return { success: false, error: 'bridge_peer_manifest_mismatch' };
            const capability = await queryBridgePeer(ctx.deps.dispatchMeshCommand, expected.daemonId, policy.meshId, policy);
            if (!capability || capability.commit !== expected.commit || capability.version !== expected.version || capability.frozen !== true) return { success: false, error: 'bridge_peer_reconnect_unconfirmed' };
            const raw = await ctx.deps.dispatchMeshCommand(expected.daemonId, 'get_status_metadata', {});
            const peer = unwrapMeshRelayResult(raw, { command: 'get_status_metadata', peerDaemonId: expected.daemonId });
            const status = peer.status as Record<string, unknown> | undefined, build = peer.daemonBuild as Record<string, unknown> | undefined;
            if ((expected.bootId && peer.bootId !== expected.bootId) || peer.success !== true || !daemonIdsEquivalent(String(status?.instanceId ?? ''), expected.daemonId) || build?.commit !== expected.commit || status?.version !== expected.version) return { success: false, error: 'bridge_peer_identity_unconfirmed' };
        }
        return { success: true, nonce: args.nonce, p2p: args.peerBuilds.length > 0, coordinator: true, verifiedPeers: args.peerBuilds.map((peer: { daemonId: string }) => peer.daemonId) };
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
