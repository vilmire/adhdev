/**
 * Available `{{token}}` placeholders for coordinator prompt override/append text.
 *
 * Source of truth: expandPromptPlaceholders() in
 * oss/packages/daemon-core/src/mesh/coordinator-prompt.ts — keep this list in sync
 * with the `replacements` map there. Descriptions/examples are illustrative, not
 * read from the daemon.
 */
export interface CoordinatorPromptPlaceholder {
    token: string
    description: string
    example: string
}

export const COORDINATOR_PROMPT_PLACEHOLDERS: CoordinatorPromptPlaceholder[] = [
    { token: 'meshName', description: "This mesh's display name.", example: 'my-app' },
    { token: 'repo', description: 'Repo identity (owner/repo or workspace path).', example: 'vilmire/adhdev' },
    { token: 'defaultBranch', description: "The mesh's default branch.", example: 'main' },
    { token: 'cliType', description: 'The coordinator CLI type this prompt is being rendered for.', example: 'claude-cli' },
    { token: 'nodes', description: 'Live node status table, or the configured node list if no live status is available.', example: '(rendered node table)' },
    { token: 'mission', description: 'Current mission section, when a mission is active. Empty otherwise.', example: '(mission summary or empty)' },
    { token: 'recentActivity', description: 'Recent mesh activity summary. Empty when none.', example: '(recent activity or empty)' },
    { token: 'operatingNotes', description: 'Accumulated operating notes for this mesh. Empty when none.', example: '(operating notes or empty)' },
    { token: 'policy', description: "The mesh's effective policy section (safety, scheduling, etc.).", example: '(rendered policy section)' },
    { token: 'tools', description: 'The canonical MCP tools reference table.', example: '(tools table)' },
    { token: 'workflow', description: 'The standard coordinator workflow guidance section.', example: '(workflow section)' },
    { token: 'quota', description: 'The quota-awareness section.', example: '(quota section)' },
    { token: 'onboarding', description: 'Onboarding/reinit guidance section.', example: '(onboarding section)' },
    { token: 'rules', description: 'CLI-type-specific and policy-derived rules section.', example: '(rules section)' },
    { token: 'toolExposurePreflight', description: 'Preflight guidance for verifying tool exposure before relying on it.', example: '(preflight section)' },
]
