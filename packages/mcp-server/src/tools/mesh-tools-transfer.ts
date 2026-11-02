// Mesh tool implementation - project file transfer requests (owner decision 2026-11-02).
// A thin wrapper over the daemon command `project_transfer_agent`. Authority (coordinator only, never a worker,
// never approving) is enforced by the daemon from the credential the transport presents.
import { unwrapCommandPayload } from './mesh-session-helpers.js';
import { findNodeWithRefresh, type MeshContext } from './mesh-tools-internal.js';

type Obj = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export async function meshFileTransfer(ctx: MeshContext, args: {
    action?: string; from_workspace?: string; selected?: unknown; to_node_id?: string; to_daemon_id?: string; to_workspace?: string;
    target_mode?: string; final_name?: string; target_dir?: string; transfer_id?: string;
} = {}): Promise<string> {
    try {
        const action = str(args.action) || 'status';
        const payload: Obj = { action };
        if (action === 'request') {
            let toDaemonId = str(args.to_daemon_id);
            let toWorkspace = str(args.to_workspace);
            const nodeId = str(args.to_node_id);
            if (nodeId) {
                const node = await findNodeWithRefresh(ctx, nodeId);
                toDaemonId = toDaemonId || str(node.daemonId);
                toWorkspace = toWorkspace || str(node.workspace);
            }
            Object.assign(payload, {
                fromWorkspace: str(args.from_workspace), selected: Array.isArray(args.selected) ? args.selected : [],
                toDaemonId, toWorkspace,
                ...(str(args.target_mode) ? { targetMode: str(args.target_mode) } : {}),
                ...(str(args.final_name) ? { finalName: str(args.final_name) } : {}),
                ...(typeof args.target_dir === 'string' ? { targetDir: args.target_dir.trim() } : {}),
            });
        } else if (str(args.transfer_id)) payload.transferId = str(args.transfer_id);
        const res = unwrapCommandPayload(await ctx.transport.command('project_transfer_agent', payload)) as Obj | undefined;
        if (!res || res.success !== true) {
            return JSON.stringify({ success: false, error: res?.error ?? 'project_transfer_agent failed', ...(res?.code ? { code: res.code } : {}) });
        }
        return JSON.stringify(res, null, 2);
    } catch (e: any) {
        return JSON.stringify({ success: false, error: e?.message || String(e) });
    }
}
