// Labels for the launch Category chips shown in the new-session dialog
// (CLI / IDE / ACP). Kept as a pure, dependency-free leaf module so the mapping
// can be unit-tested without pulling in the dialog's full import chain.
//
// Note: the 'ide' category is an IDE launch, not the workspace/mesh launch-mode
// toggle — labelling it 'Workspace' was a bug (it collided with the unrelated
// WorkspaceLaunchMode toggle and the sibling "Choose IDE" header).

export type LaunchCategoryKind = 'ide' | 'cli' | 'acp'

export const LAUNCH_CATEGORY_LABELS: Record<LaunchCategoryKind, string> = {
    cli: 'CLI',
    ide: 'IDE',
    acp: 'ACP',
}
