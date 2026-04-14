import { describe, expect, it } from 'vitest'
import { browseMachineDirectories } from '../../../src/components/machine/workspaceBrowse'

describe('browseMachineDirectories', () => {
  it('returns directory entries from a raw daemon response', async () => {
    const sendDaemonCommand = async () => ({
      success: true,
      path: '/tmp/demo',
      files: [
        { name: 'alpha', type: 'directory' },
        { name: 'notes.txt', type: 'file' },
        { name: 'beta', type: 'directory', path: '/tmp/demo/beta' },
      ],
    })

    await expect(browseMachineDirectories(sendDaemonCommand, 'machine-1', '/tmp/demo')).resolves.toEqual({
      path: '/tmp/demo',
      directories: [
        { name: 'alpha', path: '/tmp/demo/alpha' },
        { name: 'beta', path: '/tmp/demo/beta' },
      ],
    })
  })

  it('unwraps cloud daemon command envelopes before reading directory entries', async () => {
    const sendDaemonCommand = async () => ({
      success: true,
      result: {
        success: true,
        path: '/tmp/demo',
        files: [
          { name: 'alpha', type: 'directory' },
          { name: 'beta', type: 'directory' },
        ],
      },
    })

    await expect(browseMachineDirectories(sendDaemonCommand, 'machine-1', '/tmp/demo')).resolves.toEqual({
      path: '/tmp/demo',
      directories: [
        { name: 'alpha', path: '/tmp/demo/alpha' },
        { name: 'beta', path: '/tmp/demo/beta' },
      ],
    })
  })
})
