import { spawn, type ChildProcess } from 'child_process'

/**
 * Bytes of each `ps` line that are kept. Matching needs only the pid and the
 * start of argv (an app-bundle path prefix), never the whole argument list.
 * Agent CLIs carry multi-KB system prompts in argv (a busy Mac's full listing
 * was ≈0.5 MiB), so buffering whole lines — or the whole output, as exec's
 * maxBuffer does — lets one process's argv drive memory. Streaming and
 * truncating each line bounds it to this much per line in flight.
 */
export const PS_LINE_PREFIX_BYTES = 4096
const PS_TIMEOUT_MS = 3000

type SpawnLike = (command: string, args: string[], options: { stdio: ['ignore', 'pipe', 'ignore']; windowsHide: boolean }) => Pick<ChildProcess, 'stdout' | 'on' | 'kill'>

/**
 * PIDs of running processes whose argv starts inside one of `appPaths`.
 * Rejects (never resolves []) when `ps` fails, so callers cannot mistake a
 * failed listing for "not running".
 */
export function findRunningMacAppPids(appPaths: readonly string[], spawnImpl: SpawnLike = spawn as unknown as SpawnLike): Promise<number[]> {
  if (!appPaths.some(p => normalizeMacAppPath(p))) return Promise.resolve([])
  return new Promise((resolve, reject) => {
    const child = spawnImpl('ps', ['axww', '-o', 'pid=,args='], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    const pids: number[] = []
    const take = (completed: string) => { pids.push(...findMacAppProcessPids(completed, appPaths)) }
    let line = ''
    let truncated = false
    let settled = false
    const finish = (error: Error | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) return reject(error)
      if (line) take(line)
      resolve(pids)
    }
    const timer = setTimeout(() => { child.kill(); finish(new Error(`ps timed out after ${PS_TIMEOUT_MS}ms`)) }, PS_TIMEOUT_MS)
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      let start = 0
      for (;;) {
        const nl = chunk.indexOf('\n', start)
        const piece = chunk.slice(start, nl < 0 ? chunk.length : nl)
        if (!truncated) {
          line += piece
          if (line.length > PS_LINE_PREFIX_BYTES) { line = line.slice(0, PS_LINE_PREFIX_BYTES); truncated = true }
        }
        if (nl < 0) break
        if (line) take(line)
        line = ''
        truncated = false
        start = nl + 1
      }
    })
    child.on('error', (error: Error) => finish(error))
    child.on('close', (code: number | null) => finish(code === 0 ? null : new Error(`ps exited with code ${code}`)))
  })
}

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
