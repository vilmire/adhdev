/**
 * Queue `depends_on` failure policy + the derived "blocked by a failed
 * dependency" view.
 *
 * `block` (the default) derives the hold from current predecessor statuses: no
 * `dependency_failed:*` marker is written onto dependents. The unchanged
 * `taskDependenciesSatisfied` predicate stays false while a predecessor is not
 * `completed`, and a retry of the predecessor unblocks automatically once it
 * reaches `completed`.
 *
 * `cancel` is an explicit transactional cancellation cascade
 * (mesh-work-queue.ts propagateDependencyFailure). It does not reverse if the
 * predecessor is later force-requeued.
 */

export const MESH_ON_DEPENDENCY_FAILURE_POLICIES = ['block', 'cancel'] as const;
export type MeshOnDependencyFailure = typeof MESH_ON_DEPENDENCY_FAILURE_POLICIES[number];

/**
 * The public schema/tool description text. Keep this string identical wherever
 * the field is exposed (RepoMeshPolicy, prompt, tools).
 */
export const MESH_ON_DEPENDENCY_FAILURE_PUBLIC_TEXT =
    'on_dependency_failure controls downstream tasks when a required worker task fails or is '
    + 'cancelled. `block` (default) keeps downstream pending and automatically recovers if the '
    + 'predecessor is retried and later completes. `cancel` terminally cancels the dependent branch; '
    + 'it is not revived by predecessor retry.';

/** Runtime resolve: only an explicit `'cancel'` selects the cascade; anything else is `block`. */
export function resolveOnDependencyFailurePolicy(value: unknown): MeshOnDependencyFailure {
    return value === 'cancel' ? 'cancel' : 'block';
}

export interface MeshDependencyFailure {
    taskId: string;
    status: 'failed' | 'cancelled';
    reason?: string;
}

/**
 * View-time derivation of explanatory failure data. Truth stays in predecessor
 * statuses; nothing is written onto the dependent.
 */
export function deriveDependencyFailures(
    dependsOn: readonly string[] | undefined,
    statusById: ReadonlyMap<string, string>,
    depMetaById?: ReadonlyMap<string, { cancelReason?: string; status?: string }>,
): MeshDependencyFailure[] {
    const deps = Array.isArray(dependsOn) ? dependsOn : [];
    const failures: MeshDependencyFailure[] = [];
    for (const taskId of deps) {
        const meta = depMetaById?.get(taskId);
        const status = statusById.get(taskId) ?? meta?.status;
        if (status !== 'failed' && status !== 'cancelled') continue;
        const reason = meta?.cancelReason;
        failures.push({
            taskId,
            status,
            ...(reason ? { reason } : {}),
        });
    }
    return failures;
}
