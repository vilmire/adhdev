/**
 * Chat Commands — read_chat node workspace scope guard.
 */

import type { CommandHelpers } from './handler.js';
import { normalizeMeshWorkspaceForCompare } from '@adhdev/mesh-shared';

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
 * Confirm the target workspace from its registry record, or a live adapter whose
 * runtime ID matches the target. Caller/current-session cwd and inactive/recovery
 * surfaces cannot prove ownership. Both read handlers refuse targeted reads when
 * this returns an empty string.
 */
export function resolveTargetSessionActualWorkspace(h: CommandHelpers, targetSessionId: string): string {
    const registryWorkspace = (h.ctx?.sessionRegistry?.get?.(targetSessionId) as any)?.workspace;
    if (typeof registryWorkspace === 'string' && registryWorkspace.trim()) return registryWorkspace;
    const adapter = h.getCliAdapter?.(targetSessionId);
    const runtimeMeta = adapter && typeof (adapter as any).getRuntimeMetadata === 'function'
        ? (adapter as any).getRuntimeMetadata() : null;
    if (typeof runtimeMeta?.runtimeId !== 'string' || runtimeMeta.runtimeId.trim() !== targetSessionId
        || runtimeMeta.surfaceKind === 'inactive_record' || runtimeMeta.surfaceKind === 'recovery_snapshot') return '';
    return adapter && typeof adapter.workingDir === 'string' && adapter.workingDir.trim() ? adapter.workingDir : '';
}
