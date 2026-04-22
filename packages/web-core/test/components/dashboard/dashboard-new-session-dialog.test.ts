import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import DashboardNewSessionDialog from '../../../src/components/dashboard/DashboardNewSessionDialog'
import type { DaemonData } from '../../../src/types'

function createMachine(): DaemonData {
  return {
    id: 'machine-1',
    machineId: 'machine-1',
    name: 'Test Machine',
    connected: true,
    availableProviders: [
      {
        type: 'claude',
        displayName: 'Claude',
        category: 'cli',
        installed: true,
      },
    ],
    detectedIdes: [],
    workspaces: [],
    recentLaunches: [],
  } as DaemonData
}

function renderDialog() {
  return renderToStaticMarkup(
    React.createElement(DashboardNewSessionDialog, {
      machines: [createMachine()],
      ides: [],
      onClose: () => {},
      onBrowseDirectory: async () => ({ path: '/', directories: [] }),
      onSaveWorkspace: async () => ({ ok: true }),
      onLaunchIde: async () => ({ ok: true }),
      onLaunchProvider: async () => ({ ok: true }),
      onListSavedSessions: async () => [],
    }),
  )
}

describe('DashboardNewSessionDialog', () => {
  it('does not show hosted runtime recovery CTA in the new session flow', () => {
    const html = renderDialog()

    expect(html).not.toContain('Recover hosted runtime')
    expect(html).not.toContain('Hosted runtimes')
  })
})
