/**
 * Chat Commands — read_chat node workspace scope guard.
 */

import type { CommandHelpers } from './handler.js';
import { normalizeMeshWorkspaceForCompare } from '@adhdev/mesh-shared';
import { getTargetInstance } from './chat-commands-shared.js';

/**
 * read_chat node scope verdict. One physical daemon hosts a base node plus several
 * worktree nodes; mesh_read_chat always dispatches read_chat with the requested
 * node's workspace (`args.workspace`). When the resolved target session actually
 * lives in a DIFFERENT worktree, returning its transcript — or worse, letting the
 * native-history-by-workspace fallback splice sibling worktree turns into the
 * reply — makes the coordinator believe one session received every worktree's
 * work. This guard refuses a CONFIRMED cross-workspace read instead of mixing.
 *
 * Conservative by design (mirrors the WTCLAIM fix-B "unknown → allow" rule): only
 * a session id that resolves to a known workspace which is unequal to a known
 * intended workspace blocks. When either side is unknown — no targetSessionId, no
 * args.workspace, an unregistered session, the coordinator self-session, or a
 * plain dashboard read that never passes a node workspace — the read proceeds
 * untouched, so base-node and same-daemon coordinator reads never regress.
 */
export function evaluateReadChatNodeWorkspaceScope(args: {
    targetSessionId?: string;
    intendedWorkspace?: string;
    sessionWorkspace?: string;
}): { scoped: false } | { scoped: true; intended: string; actual: string } {
    const targetSessionId = typeof args.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
    if (!targetSessionId) return { scoped: false };
    const intended = normalizeMeshWorkspaceForCompare(args.intendedWorkspace);
    const actual = normalizeMeshWorkspaceForCompare(args.sessionWorkspace);
    if (!intended || !actual) return { scoped: false };
    if (intended === actual) return { scoped: false };
    return { scoped: true, intended, actual };
}

/**
 * Resolve the target session's ACTUAL workspace from the most authoritative source
 * available on this daemon: the session registry record (stamped at register
 * time), then the live CLI adapter's working directory, then the bound instance
 * state. Returns '' when nothing knows the session's workspace — the caller treats
 * that as "unknown" and does not block. Paging requests requireConfirmedOwner:
 * only a registry workspace or a live runtime-matched adapter may confirm the
 * target workspace; provider/current-session and instance fallbacks are excluded.
 */
export function resolveTargetSessionActualWorkspace(h: CommandHelpers, targetSessionId: string, requireConfirmedOwner = false): string {
    const registryWorkspace = (h.ctx?.sessionRegistry?.get?.(targetSessionId) as any)?.workspace;
    if (typeof registryWorkspace === 'string' && registryWorkspace.trim()) return registryWorkspace;
    const adapter = h.getCliAdapter?.(targetSessionId);
    // Paging must not infer ownership from a provider/current-session adapter
    // returned as a fallback for an unknown target. Only its runtime can prove it.
    if (requireConfirmedOwner) {
        const runtimeMeta = adapter && typeof (adapter as any).getRuntimeMetadata === 'function'
            ? (adapter as any).getRuntimeMetadata() : null;
        if (typeof runtimeMeta?.runtimeId !== 'string' || runtimeMeta.runtimeId.trim() !== targetSessionId
            || runtimeMeta.surfaceKind === 'inactive_record' || runtimeMeta.surfaceKind === 'recovery_snapshot') return '';
    }
    if (adapter && typeof adapter.workingDir === 'string' && adapter.workingDir.trim()) return adapter.workingDir;
    if (requireConfirmedOwner) return '';
    const instanceWorkspace = (getTargetInstance(h, { targetSessionId })?.getState?.() as any)?.workspace;
    if (typeof instanceWorkspace === 'string' && instanceWorkspace.trim()) return instanceWorkspace;
    return '';
}
