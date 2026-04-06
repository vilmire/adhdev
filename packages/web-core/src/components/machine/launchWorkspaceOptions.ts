import type { LaunchWorkspaceOption, WorkspaceRow } from '../../pages/machine/types'

function getWorkspaceOptionLabel(path: string, fallbackLabel?: string) {
    if (fallbackLabel) return fallbackLabel
    const trimmed = path.replace(/[\\/]+$/, '')
    const name = trimmed.split(/[\\/]/).filter(Boolean).pop()
    return name || path
}

export function buildLaunchWorkspaceOptions(args: {
    machine: {
        workspaces: Array<Pick<WorkspaceRow, 'id' | 'path' | 'label'>>
        defaultWorkspaceId: string | null
    }
    currentWorkspacePath?: string | null
    currentWorkspaceId?: string | null
    includeHome?: boolean
}): { options: LaunchWorkspaceOption[]; selectedKey: string } {
    const {
        machine,
        currentWorkspacePath,
        currentWorkspaceId,
        includeHome = true,
    } = args

    const options: LaunchWorkspaceOption[] = []
    if (includeHome) {
        options.push({
            key: '__home__',
            label: 'Home directory',
            description: 'Launch without a workspace',
            workspaceId: null,
            workspacePath: null,
        })
    }

    for (const workspace of machine.workspaces || []) {
        options.push({
            key: `saved:${workspace.id}`,
            label: `${workspace.id === machine.defaultWorkspaceId ? '⭐ ' : ''}${getWorkspaceOptionLabel(workspace.path, workspace.label)}`,
            description: workspace.path,
            workspaceId: workspace.id,
            workspacePath: workspace.path,
        })
    }

    const trimmedCurrentPath = currentWorkspacePath?.trim() || ''
    const matchingSaved = trimmedCurrentPath
        ? (machine.workspaces || []).find(workspace => workspace.path === trimmedCurrentPath)
        : null

    if (trimmedCurrentPath && !matchingSaved) {
        options.push({
            key: `custom:${trimmedCurrentPath}`,
            label: getWorkspaceOptionLabel(trimmedCurrentPath),
            description: trimmedCurrentPath,
            workspaceId: null,
            workspacePath: trimmedCurrentPath,
        })
    }

    if (currentWorkspaceId) {
        const savedKey = `saved:${currentWorkspaceId}`
        if (options.some(option => option.key === savedKey)) {
            return { options, selectedKey: savedKey }
        }
    }
    if (matchingSaved) {
        return { options, selectedKey: `saved:${matchingSaved.id}` }
    }
    if (trimmedCurrentPath) {
        return { options, selectedKey: `custom:${trimmedCurrentPath}` }
    }
    return { options, selectedKey: '__home__' }
}
