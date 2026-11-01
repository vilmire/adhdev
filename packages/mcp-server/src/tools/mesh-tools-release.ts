// Mesh tool implementations — release objects (docs/design/2026-11-01-release-objects.md §5).
// Thin wrappers over the daemon's release_* commands. Authority (coordinator / owner / assistant, never a
// worker) is enforced by the daemon from the credential the transport presents — nothing here decides it.
import { unwrapCommandPayload } from './mesh-session-helpers.js';
import type { MeshContext } from './mesh-tools-internal.js';

type Obj = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

async function call(ctx: MeshContext, command: string, args: Obj): Promise<string> {
    try {
        const res = unwrapCommandPayload(await ctx.transport.command(command, { meshId: ctx.mesh.id, ...args })) as Obj | undefined;
        if (!res || res.success !== true) {
            return JSON.stringify({ success: false, error: (res as Obj | undefined)?.error ?? `${command} failed`, ...((res as Obj | undefined)?.code ? { code: (res as Obj).code } : {}) });
        }
        const { success: _s, meshId: _m, ...rest } = res;
        return JSON.stringify({ success: true, ...rest }, null, 2);
    } catch (e: any) {
        return JSON.stringify({ success: false, error: e?.message || String(e) });
    }
}

export async function meshReleaseUpsert(ctx: MeshContext, args: { release_id?: string; releaseId?: string; name?: string; channel?: string; status?: string; version?: string; note?: string } = {}): Promise<string> {
    return call(ctx, 'release_upsert', {
        ...(str(args.release_id ?? args.releaseId) ? { releaseId: str(args.release_id ?? args.releaseId) } : {}),
        ...(typeof args.name === 'string' ? { name: args.name } : {}),
        ...(typeof args.channel === 'string' ? { channel: args.channel } : {}),
        ...(typeof args.status === 'string' ? { status: args.status } : {}),
        ...(typeof args.version === 'string' ? { version: args.version } : {}),
        ...(typeof args.note === 'string' ? { note: args.note } : {}),
    });
}

export async function meshReleaseScope(ctx: MeshContext, args: { release_id?: string; releaseId?: string; add?: unknown; move?: unknown; remove?: unknown; note?: string } = {}): Promise<string> {
    const releaseId = str(args.release_id ?? args.releaseId);
    if (!releaseId) return JSON.stringify({ success: false, error: 'release_id is required' });
    const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : undefined);
    const move = Array.isArray(args.move)
        ? args.move.map((m: any) => ({ missionId: str(m?.mission_id ?? m?.missionId), toReleaseId: str(m?.to_release_id ?? m?.toReleaseId) })).filter(m => m.missionId && m.toReleaseId)
        : undefined;
    return call(ctx, 'release_scope', {
        releaseId,
        ...(ids(args.add) ? { add: ids(args.add) } : {}),
        ...(move ? { move } : {}),
        ...(ids(args.remove) ? { remove: ids(args.remove) } : {}),
        ...(typeof args.note === 'string' ? { note: args.note } : {}),
    });
}

export async function meshReleaseList(ctx: MeshContext, args: { release_id?: string; releaseId?: string; status?: unknown; include?: unknown } = {}): Promise<string> {
    const include = Array.isArray(args.include) ? args.include.filter((x): x is string => typeof x === 'string') : [];
    const statuses = Array.isArray(args.status) ? args.status.filter((x): x is string => typeof x === 'string') : undefined;
    return call(ctx, 'release_list', {
        ...(str(args.release_id ?? args.releaseId) ? { releaseId: str(args.release_id ?? args.releaseId) } : {}),
        ...(statuses?.length ? { statuses } : {}),
        include,
    });
}

export async function meshReleaseRecordDeploy(ctx: MeshContext, args: { release_id?: string; releaseId?: string; channel?: string; version?: string; commit?: string; base_commit?: string; baseCommit?: string; targets?: unknown; name?: string; actor?: string } = {}): Promise<string> {
    return call(ctx, 'release_record_deploy', {
        releaseId: str(args.release_id ?? args.releaseId) || 'auto',
        channel: str(args.channel),
        ...(typeof args.version === 'string' ? { version: args.version } : {}),
        ...(typeof args.commit === 'string' ? { commit: args.commit } : {}),
        ...(typeof (args.base_commit ?? args.baseCommit) === 'string' ? { baseCommit: args.base_commit ?? args.baseCommit } : {}),
        ...(args.targets && typeof args.targets === 'object' ? { targets: args.targets } : {}),
        ...(typeof args.name === 'string' ? { name: args.name } : {}),
        ...(args.actor === 'script' ? { actor: 'script' } : {}),
    });
}

export async function meshReleaseChangelogDraft(ctx: MeshContext, args: { release_id?: string; releaseId?: string; mark_applied?: boolean; markApplied?: boolean } = {}): Promise<string> {
    const releaseId = str(args.release_id ?? args.releaseId);
    if (!releaseId) return JSON.stringify({ success: false, error: 'release_id is required' });
    return call(ctx, 'release_changelog_draft', { releaseId, ...((args.mark_applied ?? args.markApplied) === true ? { markApplied: true } : {}) });
}
