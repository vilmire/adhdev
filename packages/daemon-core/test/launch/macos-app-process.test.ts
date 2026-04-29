import { describe, expect, it } from 'vitest'

import { findMacAppProcessPids } from '../../src/launch/macos-app-process'

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
