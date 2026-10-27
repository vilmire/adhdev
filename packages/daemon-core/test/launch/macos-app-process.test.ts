import { describe, expect, it } from 'vitest'

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { PS_LINE_PREFIX_BYTES, findMacAppProcessPids, findRunningMacAppPids } from '../../src/launch/macos-app-process'

/** A fake `ps` that streams `chunks` then exits with `code`. */
function fakePs(chunks: string[], code = 0) {
  return (() => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: () => boolean }
    child.stdout = new PassThrough()
    child.kill = () => true
    setImmediate(() => {
      for (const c of chunks) child.stdout.write(c)
      child.stdout.end()
      child.stdout.once('end', () => child.emit('close', code))
      child.stdout.resume()
    })
    return child
  }) as any
}

describe('macOS running app pids (streamed ps)', () => {
  const app = '/Applications/Antigravity.app'

  it('finds app pids across chunk boundaries while a multi-MB argv line is streamed past, not buffered', async () => {
    const huge = `200 /usr/local/bin/claude --append-system-prompt ${'x'.repeat(5 * 1024 * 1024)}\n`
    const appLine = `300 ${app}/Contents/MacOS/Electron --remote-debugging-port=9335\n`
    const stream = huge + appLine + `301 ${app}/Contents/Frameworks/H.app/Contents/MacOS/H`
    const chunks: string[] = []
    for (let i = 0; i < stream.length; i += 65_536) chunks.push(stream.slice(i, i + 65_536))
    expect(await findRunningMacAppPids([app], fakePs(chunks))).toEqual([300, 301])
    expect(PS_LINE_PREFIX_BYTES).toBeLessThan(64 * 1024)
  })

  it('rejects when ps fails instead of reporting the app as not running', async () => {
    await expect(findRunningMacAppPids([app], fakePs([`300 ${app}/Contents/MacOS/Electron\n`], 1))).rejects.toThrow(/code 1/)
  })

  it('does not spawn ps when there is no app path to match', async () => {
    let spawned = false
    await expect(findRunningMacAppPids(['  '], (() => { spawned = true }) as any)).resolves.toEqual([])
    expect(spawned).toBe(false)
  })

  it.runIf(process.platform === 'darwin')('lists a real running app (Dock) from the actual ps', async () => {
    const pids = await findRunningMacAppPids(['/System/Library/CoreServices/Dock.app'])
    expect(pids.length).toBeGreaterThan(0)
  })
})

describe('macOS app process matching', () => {
  it('matches an Electron main process by app bundle path, not by the visible app name', () => {
    const psOutput = `
97189 /Applications/Antigravity.app/Contents/MacOS/Electron
97200 /Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper (Renderer).app/Contents/MacOS/Antigravity Helper (Renderer) --type=renderer
`.trim()

    expect(findMacAppProcessPids(psOutput, ['/Applications/Antigravity.app'])).toEqual([97189, 97200])
  })

  it('does not match unrelated Electron apps or shell commands that merely mention the app path', () => {
    const psOutput = `
12345 /Applications/Slack.app/Contents/MacOS/Electron
12346 /bin/zsh -lc ps axww | grep /Applications/Antigravity.app/Contents/MacOS/Electron
12347 python3 - <<'PY'\nneedle='/Applications/Antigravity.app/'\nPY
12348 /Applications/Antigravity.app/Contents/MacOS/Electron --remote-debugging-port=9335
`.trim()

    expect(findMacAppProcessPids(psOutput, ['/Applications/Antigravity.app'])).toEqual([12348])
  })
})
