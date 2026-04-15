import { describe, expect, it } from 'vitest'
import { expandCompactDaemons, type CompactDaemonCompat } from '../../src/context/BaseDaemonContext'

describe('expandCompactDaemons', () => {
  it('expands compact daemon sessions and preserves summary metadata', () => {
    const result = expandCompactDaemons([
      {
        id: 'machine-1',
        type: 'adhdev-daemon',
        timestamp: 100,
        sessions: [
          {
            id: 'acp-1',
            parentId: null,
            providerType: 'claude-code',
            providerName: 'Claude Code',
            kind: 'agent',
            transport: 'acp',
            status: 'idle',
            title: 'Claude Code',
            workspace: '/repo',
            summaryMetadata: {
              items: [{ id: 'model', label: 'Model', value: 'Sonnet', order: 10 }],
            },
          },
        ],
      },
    ] as CompactDaemonCompat[])

    expect(result.entries).toEqual([
      expect.objectContaining({ id: 'machine-1', type: 'adhdev-daemon' }),
      expect.objectContaining({
        id: 'machine-1:acp:acp-1',
        sessionId: 'acp-1',
        summaryMetadata: {
          items: [{ id: 'model', label: 'Model', value: 'Sonnet', order: 10 }],
        },
      }),
    ])
  })
})
