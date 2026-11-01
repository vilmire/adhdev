/** LIGHT-TASK tools: land captured light results, or discard them (daemon: light_land / light_discard, mesh host only). */
import type { MeshContext } from './mesh-tools.js';

async function run(ctx: MeshContext, command: 'light_land' | 'light_discard', payload: Record<string, unknown>): Promise<string> {
    try {
        const raw: any = await ctx.transport.command(command, { meshId: ctx.mesh.id, ...payload });
        return JSON.stringify(raw && typeof raw === 'object' ? raw : { success: false, error: 'empty daemon answer' }, null, 2);
    } catch (e: any) {
        return JSON.stringify({ success: false, error: e?.message || String(e) });
    }
}

export async function meshLightLand(ctx: MeshContext, args: { task_ids?: string[]; mode?: string; dry_run?: boolean; accept_paths_outside_owned?: boolean; partial?: boolean; approved_publish_shas?: string[] }): Promise<string> {
    const taskIds = Array.isArray(args.task_ids) ? args.task_ids.filter(t => typeof t === 'string' && t.trim()) : [];
    if (!taskIds.length) return JSON.stringify({ success: false, code: 'bad_request', error: 'mesh_light_land requires task_ids (the light tasks to land, in order).' });
    return run(ctx, 'light_land', {
        taskIds,
        mode: args.mode === 'apply_to_checkout' ? 'apply_to_checkout' : 'refine',
        dryRun: args.dry_run === true,
        acceptPathsOutsideOwned: args.accept_paths_outside_owned === true,
        partial: args.partial === true,
        ...(Array.isArray(args.approved_publish_shas) ? { approvedPublishShas: args.approved_publish_shas } : {}),
        // A PTY-hosted mesh coordinator routes work and never edits its checkout; only interactive MCP-only sessions may apply.
        callerIsCoordinator: !!ctx.coordinatorSessionId,
    });
}

export async function meshLightDiscard(ctx: MeshContext, args: { task_ids?: string[] }): Promise<string> {
    const taskIds = Array.isArray(args.task_ids) ? args.task_ids.filter(t => typeof t === 'string' && t.trim()) : [];
    if (!taskIds.length) return JSON.stringify({ success: false, code: 'bad_request', error: 'mesh_light_discard requires task_ids.' });
    return run(ctx, 'light_discard', { taskIds });
}
