/** LIGHT-TASK: what the refine pipeline needs to treat a light land workspace as a branch worktree. */
export interface RefineLightTarget {
    /** `validation.profiles` entry to run instead of the full gate (always the repo's "fast" profile). */
    profile: string;
    /** Replaces the `remove_mesh_node` cleanup stage: removes the land workspace and its branch. */
    cleanup(): Promise<{ success?: boolean; removed?: boolean; code?: string; error?: string }>;
}
