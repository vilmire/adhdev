/**
 * mesh_node_slots action=propose — detect a node's installed CLI providers and draft a
 * capability-slot profile from them.
 *
 * This closes the one gap between two pieces that already existed: per-node CLI
 * detection (the status snapshot's `availableProviders`) and slot application
 * (`mesh_node_slots` action=set, dry-run by default). Nothing previously turned the
 * former into a draft of the latter — filling a node's slots was 100% manual.
 *
 * ─── Read-only by construction ───────────────────────────────────────────────
 *
 * This tool NEVER writes. It probes, drafts, and returns — deliberately stopping
 * one step short of `mesh_node_slots` action=set, whose existing dry-run → approve →
 * write=true flow remains the ONLY path that mutates a node profile. No new
 * approval gate was added, because adding a second gate for the same decision is
 * how gates get bypassed. The response carries a ready-to-paste `slots` payload
 * for that existing tool.
 *
 * ─── Why the destructive-diff reporting is prominent ─────────────────────────
 *
 * Slot writes are WHOLESALE replacements. A detection-derived draft reflects only
 * what is installed, so any hand-tuned slot the operator added — a capability tag,
 * a tuned maxParallel, a provider that is configured but not currently on PATH —
 * is silently destroyed by an approve-without-reading. So `droppedSlots` and a
 * loud `warning` are computed up front rather than left for the reviewer to
 * derive from two lists.
 */
import {
    buildSlotProposal,
    normalizeNodeCapabilitySlots,
    type DetectedCliProvider,
} from '@adhdev/mesh-shared';
import { findNodeWithRefresh, type MeshContext } from './mesh-tools-internal.js';
import { unwrapCommandPayload } from './mesh-session-helpers.js';
import { readNodeRuntime } from './mesh-held-node-state.js';

/**
 * Pull installed CLI providers out of a provider catalog (`availableProviders`,
 * the same provider-loader availability data the dashboard's provider list
 * reads — the coordinator's own, or the catalog a member pushed).
 *
 * Filters to `category === 'cli'` and `installed === true`. IDE providers are out of
 * scope, and `extension` reports `installed: false` unconditionally, so neither
 * can leak in. `installed === undefined` is treated as
 * NOT installed — under-proposing is recoverable, over-proposing puts a slot on
 * a node that cannot run it.
 */
export function extractInstalledCliProviders(raw: unknown): DetectedCliProvider[] {
    const payload = unwrapCommandPayload(raw) as any;
    const list = payload?.status?.availableProviders
        ?? payload?.availableProviders
        ?? (raw as any)?.status?.availableProviders;
    if (!Array.isArray(list)) return [];

    const out: DetectedCliProvider[] = [];
    for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        if (entry.category !== 'cli') continue;
        if (entry.installed !== true) continue;
        const type = typeof entry.type === 'string' ? entry.type.trim() : '';
        if (!type) continue;
        const displayName = typeof entry.displayName === 'string' && entry.displayName.trim()
            ? entry.displayName.trim()
            : (typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined);
        const version = typeof entry.providerVersion === 'string' && entry.providerVersion.trim()
            ? entry.providerVersion.trim()
            : undefined;
        out.push({ type, ...(displayName ? { displayName } : {}), ...(version ? { version } : {}) });
    }
    return out;
}

/**
 * Detect installed CLI providers on a node and return a proposed capability-slot
 * profile. READ-ONLY — apply via `mesh_node_slots` action=set.
 */
export async function meshNodeSlotsPropose(
    ctx: MeshContext,
    args: { node_id?: string; nodeId?: string } = {},
): Promise<string> {
    const nodeId = String(args.node_id || args.nodeId || '').trim();
    if (!nodeId) return JSON.stringify({ success: false, error: 'node_id required' });

    try {
        const node = await findNodeWithRefresh(ctx, nodeId);

        // The node's provider catalog as the coordinator daemon answers it (its own
        // status, or the catalog the member pushed) — the member is never read.
        const runtime = await readNodeRuntime(ctx, node);
        if (!runtime.known) {
            return JSON.stringify({
                success: false,
                nodeId: node.id,
                code: 'detection_unavailable',
                error: 'The coordinator holds no provider catalog for this node yet (the member has not pushed its runtime).',
                nextAction: 'Node may be offline. Retry when it is online, or set slots manually with mesh_node_slots (action "set").',
            }, null, 2);
        }

        const detected = extractInstalledCliProviders({ availableProviders: runtime.probe.providers ?? [] });
        const currentSlots = normalizeNodeCapabilitySlots((node as any)?.policy?.slots);

        if (detected.length === 0) {
            // Empty detection is NOT an empty proposal to apply — proposing []
            // would wipe the node's profile. Refuse to draft instead.
            return JSON.stringify({
                success: true,
                nodeId: node.id,
                detectedCliProviders: [],
                currentSlots,
                proposedSlots: [],
                note: 'No installed CLI providers detected on this node — nothing to propose. '
                    + 'This is NOT a proposal to clear the node\'s slots: applying an empty slot list would '
                    + 'wipe the existing profile. Left unchanged.',
                nextAction: currentSlots.length
                    ? 'Node keeps its current slots. If detection is wrong, check the node daemon\'s provider list.'
                    : 'Install a CLI agent on the node, or configure slots manually with mesh_node_slots (action "set").',
            }, null, 2);
        }

        const proposal = buildSlotProposal(detected, currentSlots);

        const warnings: string[] = [];
        if (proposal.destructive) {
            warnings.push(
                `DESTRUCTIVE: applying this proposal would REMOVE ${proposal.droppedSlots.length} existing slot(s)`
                + `${proposal.droppedProviders.length ? `, dropping provider(s) entirely: ${proposal.droppedProviders.join(', ')}` : ''}`
                + '. mesh_node_slots action "set" replaces the slot list wholesale — hand-tuned slots (capability tags, tuned '
                + 'maxParallel, providers not currently on PATH) are NOT preserved. Review droppedSlots before approving.',
            );
        }
        if (proposal.unknownProviders.length) {
            warnings.push(
                `Unrecognized provider(s) with no mapping entry: ${proposal.unknownProviders.join(', ')}. `
                + 'Proposed with a conservative default (difficulty medium, maxParallel 1).',
            );
        }
        if (proposal.provisionalProviders.length) {
            warnings.push(
                `Provisional (estimated, not observed) placement for: ${proposal.provisionalProviders.join(', ')}. `
                + 'Adjust after real usage.',
            );
        }

        return JSON.stringify({
            success: true,
            dryRun: true,
            nodeId: node.id,
            detectionSource: 'coordinator node runtime → provider catalog (category=cli, installed=true)',
            detectedCliProviders: detected,
            currentSlots,
            proposedSlots: proposal.proposedSlots,
            rationale: proposal.entries.map(e => ({
                provider: e.slot.provider,
                ...(e.slot.model ? { model: e.slot.model } : {}),
                ...(e.slot.difficulty ? { difficulty: e.slot.difficulty } : {}),
                ...(e.slot.maxParallel !== undefined ? { maxParallel: e.slot.maxParallel } : {}),
                ...(e.unknownProvider ? { unknownProvider: true } : {}),
                ...(e.provisional ? { provisional: true } : {}),
                ...(e.rationale ? { why: e.rationale } : {}),
            })),
            droppedSlots: proposal.droppedSlots,
            droppedProviders: proposal.droppedProviders,
            destructive: proposal.destructive,
            ...(warnings.length ? { warnings } : {}),
            note: 'PROPOSAL ONLY — nothing was written. This tool never mutates node config.',
            nextAction: 'Present this diff to the user. On approval, apply with '
                + 'mesh_node_slots({ action: "set", node_id, slots: proposedSlots, write: true }). '
                + 'Its own dry-run (write omitted) will restate the same current-vs-proposed diff.',
        }, null, 2);
    } catch (e: any) {
        return JSON.stringify({ success: false, error: e?.message || String(e) });
    }
}
