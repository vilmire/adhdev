import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getRecentLaunchArgs, pushRecentLaunchArgs, removeRecentLaunchArgs } from '../../src/utils/recentLaunchArgs'

function installLocalStorage() {
  const storage = new Map<string, string>()
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, String(value))
    },
    removeItem: (key: string) => {
      storage.delete(key)
    },
    clear: () => {
      storage.clear()
    },
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage },
  })
}

describe('recent launch args', () => {
  beforeEach(() => {
    installLocalStorage()
  })

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window')
  })

  it('removes one persisted startup-arguments chip without disturbing the others', () => {
    pushRecentLaunchArgs('machine-1', 'codex-cli', '--model gpt-5')
    pushRecentLaunchArgs('machine-1', 'codex-cli', '--dangerously-bypass-approvals')
    pushRecentLaunchArgs('machine-1', 'codex-cli', '--model gpt-5')

    expect(getRecentLaunchArgs('machine-1', 'codex-cli')).toEqual([
      '--model gpt-5',
      '--dangerously-bypass-approvals',
    ])

    removeRecentLaunchArgs('machine-1', 'codex-cli', '--model   gpt-5')

    expect(getRecentLaunchArgs('machine-1', 'codex-cli')).toEqual([
      '--dangerously-bypass-approvals',
    ])
  })

  it('keeps startup args scoped to the selected machine and provider', () => {
    pushRecentLaunchArgs('machine-1', 'codex-cli', '--one')
    pushRecentLaunchArgs('machine-2', 'codex-cli', '--two')
    pushRecentLaunchArgs('machine-1', 'claude-code', '--three')

    removeRecentLaunchArgs('machine-1', 'codex-cli', '--one')

    expect(getRecentLaunchArgs('machine-1', 'codex-cli')).toEqual([])
    expect(getRecentLaunchArgs('machine-2', 'codex-cli')).toEqual(['--two'])
    expect(getRecentLaunchArgs('machine-1', 'claude-code')).toEqual(['--three'])
  })
})
