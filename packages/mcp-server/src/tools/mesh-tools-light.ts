/** LIGHT-TASK tools: land / discard / continue-to-integration (daemon light_* IPC, mesh host only). */
import type { MeshContext } from './mesh-tools.js';

async function run(ctx: MeshContext, command: 'light_land' | 'light_discard' | 'light_continue_integration', payload: Record<string, unknown>): Promise<string> {
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

export async function meshLightContinueIntegration(ctx: MeshContext, args: {
    task_id: string; expected_revision?: number; owner_decision_id?: string;
    owner_option_id?: string; owner_answer_revision?: number; dry_run?: boolean;
}): Promise<string> {
    const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
    const ownerDecisionId = typeof args.owner_decision_id === 'string' ? args.owner_decision_id.trim() : '';
    const ownerOptionId = typeof args.owner_option_id === 'string' ? args.owner_option_id.trim() : '';
    const expectedRevision = args.expected_revision;
    const ownerAnswerRevision = args.owner_answer_revision;
    if (!taskId || !ownerDecisionId || !ownerOptionId
        || typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
        || typeof ownerAnswerRevision !== 'number' || !Number.isSafeInteger(ownerAnswerRevision) || ownerAnswerRevision < 1
        || (args.dry_run !== undefined && typeof args.dry_run !== 'boolean')) {
        return JSON.stringify({ success: false, code: 'bad_request', error: 'mesh_light_continue_integration requires task_id, expected_revision, owner_decision_id, owner_option_id and owner_answer_revision.' });
    }
    return run(ctx, 'light_continue_integration', {
        sourceTaskId: taskId,
        expectedRevision,
        ownerAnswer: { decisionId: ownerDecisionId, optionId: ownerOptionId, revision: ownerAnswerRevision },
        dryRun: args.dry_run === true,
    });
}
