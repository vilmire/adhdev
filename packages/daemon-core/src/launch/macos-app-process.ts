function normalizeMacAppPath(appPath: string): string | null {
  const trimmed = String(appPath || '').trim()
  if (!trimmed) return null
  return trimmed.replace(/\/+$/, '')
}

function parsePsLine(line: string): { pid: number; args: string } | null {
  const match = line.match(/^\s*(\d+)\s+(.+)$/)
  if (!match) return null
  const pid = Number.parseInt(match[1], 10)
  if (!Number.isFinite(pid)) return null
  return { pid, args: match[2] }
}

export function isMacAppProcessArgs(args: string, appPath: string): boolean {
  const normalized = normalizeMacAppPath(appPath)
  if (!normalized) return false
  return String(args || '').startsWith(`${normalized}/`)
}

export function findMacAppProcessPids(psOutput: string, appPaths: readonly string[]): number[] {
  const normalizedPaths = appPaths
    .map(normalizeMacAppPath)
    .filter((value): value is string => !!value)

  if (normalizedPaths.length === 0) return []

  const pids: number[] = []
  for (const line of String(psOutput || '').split(/\r?\n/)) {
    const parsed = parsePsLine(line)
    if (!parsed) continue
    if (normalizedPaths.some(appPath => isMacAppProcessArgs(parsed.args, appPath))) {
      pids.push(parsed.pid)
    }
  }
  return pids
}
