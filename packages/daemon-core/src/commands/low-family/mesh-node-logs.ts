/**
 * RF-ROUTER LOW family — coordinator-driven remote daemon log fetch.
 *
 * Extracted verbatim from DaemonCommandRouter.executeDaemonCommand. Unlike the
 * other LOW handlers this one resolves a node's owning daemonId from the router's
 * inline-mesh cache, so it consumes the router-bound `ctx.getMeshForCommand`
 * helper (mesh state is router instance state, not reconstructable from deps). The
 * forward/local-read/redact logic is otherwise unchanged; returns the same
 * CommandRouterResult the inlined case did.
 */
import { daemonIdsEquivalent, meshNodeIdMatches } from '@adhdev/mesh-shared';
import { readDaemonLogTail, MAX_TAIL_BYTES } from '../../logging/log-tail-reader.js';
import { redactLogLines } from '../../logging/log-redactor.js';
import type { CommandRouterResult } from '../router.js';
import type { LowFamilyContext, LowFamilyHandler } from './types.js';

export const meshNodeLogsHandlers: Record<string, LowFamilyHandler> = {
    get_mesh_node_logs: async (ctx: LowFamilyContext, args: any) => {
        // Coordinator-driven remote log fetch: read a (possibly remote)
        // daemon's recent log tail over P2P instead of opening a session
        // and grepping the file by hand. Mirrors fast_forward_mesh_node's
        // forward pattern — resolve the node, forward to its owning daemon
        // when remote, otherwise read locally. The reply tail is HARD
        // byte-bounded and secret-redacted before it leaves the machine.
        const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
        const nodeId = typeof args?.nodeId === 'string' ? args.nodeId.trim() : '';
        let nodeDaemonId: string | undefined;
        if (meshId && nodeId && ctx.getMeshForCommand) {
            const meshRecord = await ctx.getMeshForCommand(meshId, args?.inlineMesh, { preferInline: true });
            const node = meshRecord?.mesh?.nodes?.find((n: any) => meshNodeIdMatches(n, nodeId));
            nodeDaemonId = typeof node?.daemonId === 'string' ? node.daemonId.trim() : undefined;
        }
        // _meshDirectDispatch prevents re-forwarding (and P2P self-dial)
        // once the call lands on the owning daemon — that daemon then reads
        // its own logs even if the stored daemonId uses a legacy form.
        const selfDaemonId = ctx.deps.statusInstanceId;
        // daemonIdsEquivalent: a legacy-form daemonId resolving to this machine's core is
        // local — read locally instead of forwarding. Equivalent → local.
        const isRemote = nodeDaemonId && selfDaemonId && !daemonIdsEquivalent(nodeDaemonId, selfDaemonId);
        if (isRemote && ctx.deps.dispatchMeshCommand && !args?._meshDirectDispatch) {
            const forwarded = await ctx.deps.dispatchMeshCommand(nodeDaemonId!, 'get_mesh_node_logs', {
                ...(typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}),
                _meshDirectDispatch: true,
            });
            return (forwarded ?? { success: false, error: 'no response from remote node' }) as CommandRouterResult;
        }

        // Local read on the owning daemon.
        const rawTailBytes = Number(args?.tailBytes);
        const tail = readDaemonLogTail({
            date: typeof args?.date === 'string' ? args.date : undefined,
            tailBytes: Number.isFinite(rawTailBytes) ? Math.min(rawTailBytes, MAX_TAIL_BYTES) : undefined,
            grep: typeof args?.grep === 'string' ? args.grep : undefined,
            sinceMs: Number.isFinite(Number(args?.sinceMs)) ? Number(args?.sinceMs) : undefined,
        });
        if (!tail.success) {
            return {
                success: false,
                error: tail.error || 'failed to read daemon log tail',
                nodeId,
                logPath: tail.logPath,
                platform: tail.platform,
            } as CommandRouterResult;
        }
        // SECURITY: redact secrets from every line before returning over P2P.
        const redactedLines = redactLogLines(tail.lines);
        return {
            success: true,
            nodeId,
            daemonId: selfDaemonId,
            logPath: tail.logPath,
            platform: tail.platform,
            lines: redactedLines,
            lineCount: redactedLines.length,
            truncated: tail.truncated,
            filtered: tail.filtered,
            bytesReturned: tail.bytesReturned,
            // Transparency meta — lets the coordinator see that a full-file grep
            // ran past the recent tail window, and how much was scanned/excluded.
            fullScan: tail.fullScan,
            scannedBytes: tail.scannedBytes,
            matchedLineCount: tail.matchedLineCount,
            excludedByFilter: tail.excludedByFilter,
            ...(tail.grep ? { grep: tail.grep } : {}),
        } as CommandRouterResult;
    },
};
