import { describe, expect, it, vi } from 'vitest'
import { ProviderCliAdapter } from '../../src/cli-adapters/provider-cli-adapter.js'

describe('ProviderCliAdapter approval hotkey inference', () => {
  function createAdapter(screenText: string, buttons: string[]) {
    const adapter = new ProviderCliAdapter({
      type: 'cursor-cli',
      name: 'Cursor CLI',
      category: 'cli',
      binary: 'cursor',
      spawn: {
        command: 'cursor',
        args: ['agent'],
        shell: true,
        env: {},
      },
      scripts: {
        detectStatus: () => 'waiting_approval',
        parseApproval: () => ({
          message: 'approval required',
          buttons,
        }),
      },
    } as any, '/tmp/project') as any

    adapter.currentStatus = 'waiting_approval'
    adapter.activeModal = {
      message: 'approval required',
      buttons,
    }
    adapter.terminalScreen = {
      getText: vi.fn(() => screenText),
      write: vi.fn(),
      resize: vi.fn(),
    }
    adapter.ptyProcess = {
      write: vi.fn(),
    }

    return adapter
  }

  it('uses the visible startup trust hotkey instead of Enter fallback', () => {
    const adapter = createAdapter(`
      Workspace Trust Required
      Do you trust the contents of this directory?
      ▶ [a] Trust this workspace
        [q] Quit
    `, ['Trust this workspace', 'Quit'])

    adapter.resolveModal(0)

    expect(adapter.ptyProcess.write).toHaveBeenCalledWith('a')
  })

  it('uses the visible command approval hotkey instead of Enter fallback', () => {
    const adapter = createAdapter(`
      Run this command?
      Not in allowlist: cd /tmp/project, python3
      tmp/adhdev_cli_verify.py
      → Run (once) (y)
        Add Shell(cd), Shell(python3) to allowlist? (tab)
        Auto-run everything (shift+tab)
        Skip (esc or n)
    `, ['Run (once)', 'Add to allowlist', 'Auto-run everything', 'Skip'])

    adapter.resolveModal(0)

    expect(adapter.ptyProcess.write).toHaveBeenCalledWith('y')
  })

  it('demotes stale waiting_approval startup state once the cursor idle prompt is visible', () => {
    const adapter = createAdapter(`
      Cursor Agent
      → Plan, search, build anything
      Composer 2 Fast
      /tmp/project
    `, ['Trust this workspace', 'Quit'])

    adapter.currentStatus = 'waiting_approval'
    adapter.activeModal = null

    expect(adapter.getStatus().status).toBe('idle')
  })

  it('clears stale startup approval state during settled parsing once cursor reaches its idle prompt', () => {
    const screenText = `
      Workspace Trust Required
      [a] Trust this workspace
      [q] Quit
      ⏳ Trusting workspace...
      Cursor Agent
      → Plan, search, build anything
      Composer 2 Fast
      /tmp/project
    `
    const adapter = createAdapter(screenText, ['Trust this workspace', 'Quit'])

    adapter.currentStatus = 'waiting_approval'
    adapter.activeModal = null
    adapter.currentTurnScope = null
    adapter.isWaitingForResponse = true
    adapter.responseBuffer = '[a] Trust this workspace\n[q] Quit\n⏳ Trusting workspace...'
    adapter.recentOutputBuffer = screenText
    adapter.settledBuffer = screenText
    adapter.lastNonEmptyOutputAt = Date.now() - 5000
    adapter.lastScreenChangeAt = Date.now() - 5000
    adapter.onStatusChange = vi.fn()
    adapter.cliScripts.detectStatus = () => 'idle'
    adapter.cliScripts.parseApproval = () => null

    adapter.evaluateSettled()

    expect(adapter.currentStatus).toBe('idle')
    expect(adapter.isWaitingForResponse).toBe(false)
  })
})
