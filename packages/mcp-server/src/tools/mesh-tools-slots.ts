/**
 * mesh_node_slots_* — the coordinator's surface for PROPOSING and APPLYING node
 * capability-slot changes (ORCHESTRATION_NODE_SLOTS.md §5: orchestrator autonomous
 * adjustment, propose → approve).
 *
 * A node's capability slots (policy.slots) are the single source of truth for
 * task→node fitness routing and MAGI fan-out. Previously only the human operator
 * could edit them (NodeSlotEditor). This lets the orchestrator, MID-RUN, suggest a
 * profile change — "add an opus slot to node X so difficult tasks route there" —
 * and apply it, but ONLY behind an explicit user-approval gate.
 *
 * The gate reuses the mesh_magi_kind_panel_set precedent exactly: default to a
 * dry-run (write=false) that returns the current-vs-proposed slot lists so the
 * coordinator can present the diff for approval, and only mutate on an explicit
 * write=true re-call. No new pending/approval storage is needed — the coordinator
 * presents the dry-run diff in chat, the user approves in chat, the coordinator
 * re-calls with write=true (same flow the design doc prescribes).
 *
 * Apply path reuses the existing seam: commandForNode(update_mesh_node,
 * { policy: { slots } }) → daemon med-family updateNode shallow-merges policy.slots.
 * No daemon change required — update_mesh_node already accepts slots.
 */
import { normalizeNodeCapabilitySlots } from '@adhdev/mesh-shared';
import {
    commandForNode,
    findNodeWithRefresh,
    unwrapCommandPayload,
    type MeshContext,
} from './mesh-tools-internal.js';

/** Read the node's currently-persisted capability slots (normalized). */
function readNodeSlots(node: any): ReturnType<typeof normalizeNodeCapabilitySlots> {
    return normalizeNodeCapabilitySlots(node?.policy?.slots);
}

/**
 * List a node's capability slots. Read-only — the sibling of the set command,
 * used to confirm the current profile and to diff before a proposed overwrite.
 */
export async function meshNodeSlotsList(
    ctx: MeshContext,
    args: { node_id?: string; nodeId?: string } = {},
): Promise<string> {
    const nodeId = String(args.node_id || args.nodeId || '').trim();
    if (!nodeId) return JSON.stringify({ success: false, error: 'node_id required' });
    try {
        const node = await findNodeWithRefresh(ctx, nodeId);
        return JSON.stringify({
            success: true,
            nodeId: node.id,
            slots: readNodeSlots(node),
        }, null, 2);
    } catch (e: any) {
        return JSON.stringify({ success: false, error: e?.message || String(e) });
    }
}

/**
 * Propose (dry-run) or apply (write=true) a node's capability-slot list.
 *
 * WHOLESALE REPLACEMENT: the passed `slots` become the node's complete new slot
 * list (policy.slots) — any prior slot not in the new list is dropped. So this
 * requires explicit user approval before a write; the default dry-run returns the
 * current-vs-proposed lists for the coordinator to present.
 */
export async function meshNodeSlotsSet(
    ctx: MeshContext,
    args: { node_id?: string; nodeId?: string; slots?: unknown; write?: boolean; reason?: string },
): Promise<string> {
    const nodeId = String(args.node_id || args.nodeId || '').trim();
    if (!nodeId) return JSON.stringify({ success: false, error: 'node_id required' });
    const write = args.write === true;
    try {
        const node = await findNodeWithRefresh(ctx, nodeId);
        const current = readNodeSlots(node);
        // Normalize the proposal with the SAME normalizer the daemon would apply, so
        // the preview and the eventual write agree on the exact stored shape.
        const proposed = normalizeNodeCapabilitySlots(args.slots);

        if (!write) {
            return JSON.stringify({
                success: true,
                dryRun: true,
                nodeId: node.id,
                replacement: true,
                ...(typeof args.reason === 'string' && args.reason.trim() ? { reason: args.reason.trim() } : {}),
                currentSlots: current,
                proposedSlots: proposed,
                note: 'Dry-run only — nothing written. This is a WHOLESALE replacement of the node\'s capability slots (policy.slots): currentSlots would be fully replaced by proposedSlots. Present this diff to the user and re-run with write=true ONLY after explicit approval.',
            }, null, 2);
        }

        // Apply via the existing update_mesh_node seam — daemon shallow-merges
        // policy.slots. Send the normalized proposal so the stored value is clean.
        const raw = await commandForNode(ctx, node, 'update_mesh_node', {
            meshId: ctx.mesh.id,
            nodeId: node.id,
            policy: { slots: proposed },
        });
        const result = unwrapCommandPayload(raw);
        if (result?.success === false) {
            return JSON.stringify({ success: false, error: result.error || 'update_mesh_node failed' });
        }
        return JSON.stringify({
            success: true,
            written: true,
            nodeId: node.id,
            replacement: true,
            previousSlots: current,
            slots: proposed,
            nextAction: 'Verify with mesh_node_slots_list. Slot-fitness routing picks these up on the next queue drain.',
        }, null, 2);
    } catch (e: any) {
        return JSON.stringify({ success: false, error: e?.message || String(e) });
    }
}
