import { describe, expect, it } from 'vitest'

import { PS_ARGS_MAX_BUFFER_BYTES, findMacAppProcessPids, listMacProcessArgs } from '../../src/launch/macos-app-process'

describe('macOS process listing', () => {
  it('asks exec for a buffer far above the 1 MiB default, since agent argv can be multi-KB each', async () => {
    let seen: { maxBuffer: number; windowsHide: boolean } | null = null
    const output = await listMacProcessArgs((_cmd, options, cb) => {
      seen = options
      cb(null, '1 /Applications/X.app/Contents/MacOS/X')
    })
    expect(output).toBe('1 /Applications/X.app/Contents/MacOS/X')
    expect(seen!.maxBuffer).toBe(PS_ARGS_MAX_BUFFER_BYTES)
    expect(PS_ARGS_MAX_BUFFER_BYTES).toBeGreaterThan(1024 * 1024)
    expect(seen!.windowsHide).toBe(true)
  })

  it('rejects on exec failure (e.g. maxBuffer exceeded) instead of reporting an empty process list', async () => {
    const overflow = Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
    await expect(listMacProcessArgs((_cmd, _options, cb) => cb(overflow, 'partial'))).rejects.toThrow(/maxBuffer/)
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
