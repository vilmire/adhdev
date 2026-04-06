export interface BrowseDirectoryEntry {
    name: string
    path: string
}

export interface BrowseDirectoryResult {
    path: string
    directories: BrowseDirectoryEntry[]
}

export function getParentBrowsePath(currentPath: string): string | null {
    const trimmed = currentPath.replace(/[\\/]+$/, '')
    if (!trimmed) return null
    if (trimmed === '/') return null
    if (/^[A-Za-z]:$/.test(trimmed)) return null

    const separator = trimmed.includes('\\') ? '\\' : '/'
    const parts = trimmed.split(/[\\/]/)

    if (/^[A-Za-z]:$/.test(parts[0] || '')) {
        if (parts.length <= 2) return `${parts[0]}\\`
        return parts.slice(0, -1).join('\\')
    }

    if (parts.length <= 2) return separator
    const parent = parts.slice(0, -1).join(separator)
    return parent || separator
}

export async function browseMachineDirectories(
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>,
    machineId: string,
    path: string,
): Promise<BrowseDirectoryResult> {
    const res: any = await sendDaemonCommand(machineId, 'file_list_browse', { path })
    if (!res?.success) {
        throw new Error(res?.error || 'Could not browse folder')
    }

    const currentPath = typeof res?.path === 'string' ? res.path : path
    const separator = currentPath.includes('\\') ? '\\' : '/'
    const joinPath = (base: string, name: string) => {
        if (/^[A-Za-z]:\\?$/.test(base)) {
            return `${base.replace(/\\?$/, '\\')}${name}`
        }
        if (base === '/' || base === '\\') return `${separator}${name}`
        return `${base.replace(/[\\/]+$/, '')}${separator}${name}`
    }

    const directories = Array.isArray(res?.files)
        ? res.files
            .filter((entry: any) => entry?.type === 'directory' && typeof entry?.name === 'string')
            .map((entry: any) => ({
                name: entry.name as string,
                path: joinPath(currentPath, entry.name as string),
            }))
            .sort((a: BrowseDirectoryEntry, b: BrowseDirectoryEntry) => a.name.localeCompare(b.name))
        : []

    return { path: currentPath, directories }
}
