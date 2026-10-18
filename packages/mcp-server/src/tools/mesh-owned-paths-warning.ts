import { findOwnershipConflicts, type OwnedPathsDeclaration } from '@adhdev/mesh-shared';

interface OwnershipTask { id: string; message: string; status: string; taskMode?: string; readonly?: boolean; ownedPaths?: OwnedPathsDeclaration }

/** Deliberately structural: repo top-level subtree, packages/<name> root (with optional
 * repo prefix), or that package's entire src/test subtree. Exact roots warn too, since
 * callers commonly intend a directory, although only /** declarations own descendants. */
export function broadOwnedPathsWarning(task: OwnershipTask, queue: readonly OwnershipTask[]) {
    if (task.taskMode !== 'code_change' || task.readonly || !task.ownedPaths) return undefined;
    const broadPaths = task.ownedPaths.paths.filter(entry => {
        const parts = entry.path.split('/').filter(Boolean);
        if (!parts.length) return entry.subtree;
        if (parts.length === 1) return entry.subtree || !parts[0].includes('.');
        const packageIndex = parts.indexOf('packages');
        if (packageIndex < 0 || parts.length < packageIndex + 2) return false;
        return parts.length === packageIndex + 2
            || (entry.subtree && parts.length === packageIndex + 3 && ['src', 'test'].includes(parts.at(-1)!));
    }).map(entry => entry.path ? entry.path + (entry.subtree ? '/**' : '') : '**');
    if (!broadPaths.length) return undefined;
    const relatedTasks = queue.filter(other => other.id !== task.id && ['pending', 'assigned'].includes(other.status)
        && !other.readonly && other.taskMode !== 'live_debug_readonly' && other.ownedPaths
        && findOwnershipConflicts(task.ownedPaths!, [{ taskId: other.id, paths: other.ownedPaths }]).length)
        .map(other => ({ taskId: other.id, title: other.message.trim().split('\n')[0].slice(0, 100), status: other.status,
            relationship: other.status === 'assigned' ? 'blocked_by' : 'potential_conflict' }));
    return { broadOwnedPathsWarning: { broadPaths, relatedTasks, message: 'Broad owned_paths can serialize independent work. Prefer files or narrower subtrees. Informational only; task enqueued.' } };
}
