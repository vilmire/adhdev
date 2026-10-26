import { exec } from 'child_process'

/**
 * `ps axww -o pid=,args=` prints every process with its full argument list.
 * Agent CLIs carry multi-KB system prompts in argv, so the listing routinely
 * approaches Node's 1 MiB `maxBuffer` default (≈0.5 MiB measured on a busy
 * Mac); past it exec fails and every app process becomes invisible.
 */
export const PS_ARGS_MAX_BUFFER_BYTES = 64 * 1024 * 1024

type ExecLike = (
  command: string,
  options: { encoding: 'utf-8'; timeout: number; maxBuffer: number; windowsHide: boolean },
  callback: (error: Error | null, stdout: string) => void,
) => unknown

/** Rejects instead of resolving '' so callers cannot mistake a failed listing for "no processes". */
export function listMacProcessArgs(execImpl: ExecLike = exec as unknown as ExecLike): Promise<string> {
  return new Promise((resolve, reject) => {
    execImpl(
      'ps axww -o pid=,args=',
      { encoding: 'utf-8', timeout: 3000, maxBuffer: PS_ARGS_MAX_BUFFER_BYTES, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout ?? ''))),
    )
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
