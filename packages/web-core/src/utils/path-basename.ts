/** Last path segment ("/Users/me/repo" → "repo", "C:\\work\\app\\" → "app"). */
export function pathBasename(path: string): string {
    const trimmed = path.replace(/[\\/]+$/, '')
    const parts = trimmed.split(/[\\/]/)
    return parts[parts.length - 1] || trimmed || path
}
