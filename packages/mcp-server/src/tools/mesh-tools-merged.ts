// Mesh tool implementations — the merged tools of the 2026-09-26 tool-surface
// consolidation (60 → 48 published tools).
//
// Each merged tool is a thin dispatcher over the per-verb handlers that already
// existed; no verb changed behaviour. The discriminator (`action`, `kind` or
// `mode`) and the per-verb argument sets are validated BEFORE dispatch by
// validate-tool-args.ts (MESH_TOOL_ACTIONS), so an argument belonging to a
// different verb never reaches these functions through the MCP server. The
// defaults below still guard direct callers (tests, other in-process code).
//
// The retired tool names do not forward here: they answer with an error naming
// the replacement (mesh-shared RETIRED_MESH_TOOLS), so a coordinator on an old
// prompt learns the new spelling instead of depending on a silent alias.

import type { CommandTransport } from '../transports/mode.js';
import type { MeshContext } from './mesh-tools-internal.js';
import { meshNodeSlotsList, meshNodeSlotsSet } from './mesh-tools-slots.js';
import { meshNodeSlotsPropose } from './mesh-tools-slot-autodetect.js';
import { meshForgetNote, meshRecordNote } from './mesh-tools-mission.js';
import { meshChangeImpactConfig, meshInit, meshRefineConfig, meshReinit, meshWriteMeshJsonConfig } from './mesh-tools-refine.js';
import { meshCreate, meshPlanOnboarding } from './mesh-tools-crud.js';
import { meshCleanupSessions, meshPruneStaleDirect } from './mesh-tools-session.js';

type Args = Record<string, any>;

/** Shared refusal for a missing/unknown discriminator (a direct caller bypassing validation). */
function invalidDiscriminator(tool: string, key: string, value: unknown, allowed: readonly string[]): string {
    return JSON.stringify({
        success: false,
        code: `invalid_${key}`,
        error: `${tool}: invalid or missing '${key}' (${JSON.stringify(value)}). Expected one of: ${allowed.map(a => `'${a}'`).join(' | ')}.`,
    });
}

/** Drop the discriminator so each per-verb handler sees exactly its pre-merge argument bag. */
function without(args: Args, key: string): Args {
    const { [key]: _dropped, ...rest } = args;
    return rest;
}

/** `mesh_node_slots` — list / propose / set a node's capability slots. */
export async function meshNodeSlots(ctx: MeshContext, args: Args = {}): Promise<string> {
    const rest = without(args, 'action');
    switch (args.action) {
        case 'list':
            return meshNodeSlotsList(ctx, rest);
        case 'propose':
            return meshNodeSlotsPropose(ctx, rest);
        case 'set':
            return meshNodeSlotsSet(ctx, rest);
        default:
            return invalidDiscriminator('mesh_node_slots', 'action', args.action, ['list', 'propose', 'set']);
    }
}

/** `mesh_note` — record / forget a mesh operating note. */
export async function meshNote(ctx: MeshContext, args: Args = {}): Promise<string> {
    const rest = without(args, 'action');
    switch (args.action) {
        case 'record':
            return meshRecordNote(ctx, rest);
        case 'forget':
            return meshForgetNote(ctx, rest);
        default:
            return invalidDiscriminator('mesh_note', 'action', args.action, ['record', 'forget']);
    }
}

/** `mesh_config` — refine / change_impact (read-only helpers) / mesh_json (gated write). */
export async function meshConfig(ctx: MeshContext, args: Args = {}): Promise<string> {
    const rest = without(args, 'kind');
    switch (args.kind) {
        case 'refine':
            return meshRefineConfig(ctx, rest);
        case 'change_impact':
            return meshChangeImpactConfig(ctx, rest);
        case 'mesh_json':
            return meshWriteMeshJsonConfig(ctx, rest);
        default:
            return invalidDiscriminator('mesh_config', 'kind', args.kind, ['refine', 'change_impact', 'mesh_json']);
    }
}

/** `mesh_init` — first-time onboarding (mode=init, default) or re-onboarding (mode=reinit). */
export async function meshInitOrReinit(ctx: MeshContext, args: Args = {}): Promise<string> {
    const rest = without(args, 'mode');
    switch (args.mode ?? 'init') {
        case 'init':
            return meshInit(ctx, rest);
        case 'reinit':
            return meshReinit(ctx, rest);
        default:
            return invalidDiscriminator('mesh_init', 'mode', args.mode, ['init', 'reinit']);
    }
}

/**
 * `mesh_create` — create a mesh (mode=create, default) or run the read-only
 * onboarding planner (mode=plan). Transport-level, like the handlers it wraps,
 * because standard mode (no mesh yet) publishes it too; `defaultMeshId` is the
 * active mesh in mesh mode, which the planner validates against by default.
 */
export async function meshCreateOrPlan(transport: CommandTransport, args: Args = {}, defaultMeshId?: string): Promise<string> {
    const rest = without(args, 'mode');
    switch (args.mode ?? 'create') {
        case 'create':
            return meshCreate(transport, rest as any);
        case 'plan':
            return meshPlanOnboarding(transport, rest as any, defaultMeshId);
        default:
            return invalidDiscriminator('mesh_create', 'mode', args.mode, ['create', 'plan']);
    }
}

/**
 * `mesh_cleanup_sessions` — a node's delegated session records (the four
 * session modes), or mode=prune_stale_direct for mesh-wide orphaned staleDirect
 * dispatch records. The session modes pass `mode` through unchanged (the daemon
 * command reads it); prune takes its own execute/dry_run/include_terminal.
 */
export async function meshCleanupSessionsOrPrune(ctx: MeshContext, args: Args = {}): Promise<string> {
    if (args.mode === 'prune_stale_direct') return meshPruneStaleDirect(ctx, without(args, 'mode'));
    return meshCleanupSessions(ctx, args as any);
}
