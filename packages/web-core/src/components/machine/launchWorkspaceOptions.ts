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
    // Localized "Home directory" label + description for the __home__ option. Optional
    // so existing non-i18n callers keep the English defaults; component callers pass
    // t('newSession.homeDirectory') / t('newSession.launchWithoutWorkspace').
    homeLabel?: string
    homeDescription?: string
}): { options: LaunchWorkspaceOption[]; selectedKey: string } {
    const {
        machine,
        currentWorkspacePath,
        currentWorkspaceId,
        includeHome = true,
        homeLabel = 'Home directory',
        homeDescription = 'Launch without a workspace',
    } = args

    const options: LaunchWorkspaceOption[] = []
    if (includeHome) {
        options.push({
            key: '__home__',
            label: homeLabel,
            description: homeDescription,
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
