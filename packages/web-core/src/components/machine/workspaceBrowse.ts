export interface BrowseDirectoryEntry {
    name: string
    path: string
}

export interface BrowseDirectoryResult {
    path: string
    directories: BrowseDirectoryEntry[]
}

export function collectBrowsePathCandidates(
    ...groups: Array<Array<string | null | undefined> | string | null | undefined>
): string[] {
    const seen = new Set<string>()
    const result: string[] = []

    const push = (value: string | null | undefined) => {
        const trimmed = typeof value === 'string' ? value.trim() : ''
        if (!trimmed) return
        const key = trimmed.toLowerCase()
        if (seen.has(key)) return
        seen.add(key)
        result.push(trimmed)
    }

    for (const group of groups) {
        if (Array.isArray(group)) {
            for (const value of group) push(value)
            continue
        }
        push(group)
    }

    return result
}

function normalizeWindowsBrowseCandidate(candidate: string): string | null {
    const value = candidate.trim()
    if (!value) return null
    if (value.startsWith('~')) return value
    if (/^[A-Za-z]:$/.test(value)) return `${value[0].toUpperCase()}:\\`
    if (/^[A-Za-z]:[\\/]/.test(value)) return `${value[0].toUpperCase()}:${value.slice(2).replace(/\//g, '\\')}`
    if (/^[A-Za-z]:[^\\/].*$/.test(value)) return `${value[0].toUpperCase()}:\\${value.slice(2).replace(/[\\/]+/g, '\\')}`

    const slashDriveMatch = value.match(/^[/\\]([A-Za-z])(?:[/\\](.*))?$/)
    if (slashDriveMatch) {
        const drive = slashDriveMatch[1].toUpperCase()
        const rest = (slashDriveMatch[2] || '').replace(/[\\/]+/g, '\\')
        return rest ? `${drive}:\\${rest}` : `${drive}:\\`
    }

    return null
}

export function getDefaultBrowseStartPath(
    platform: string | null | undefined,
    candidates: Array<string | null | undefined> = [],
): string {
    if (platform === 'win32') {
        for (const candidate of candidates) {
            if (typeof candidate !== 'string') continue
            const normalized = normalizeWindowsBrowseCandidate(candidate)
            if (normalized) return normalized
        }
        return 'C:\\'
    }

    for (const candidate of candidates) {
        const value = typeof candidate === 'string' ? candidate.trim() : ''
        if (value) return value
    }
    return '~'
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
                path: typeof entry?.path === 'string' && entry.path.trim()
                    ? entry.path
                    : joinPath(currentPath, entry.name as string),
            }))
            .sort((a: BrowseDirectoryEntry, b: BrowseDirectoryEntry) => a.name.localeCompare(b.name))
        : []

    return { path: currentPath, directories }
}
