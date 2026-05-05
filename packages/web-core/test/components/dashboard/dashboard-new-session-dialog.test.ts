import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import DashboardNewSessionDialog, { LaunchCategorySelector } from '../../../src/components/dashboard/DashboardNewSessionDialog'
import type { DaemonData } from '../../../src/types'

function createMachine(index = 1): DaemonData {
  return {
    id: `machine-${index}`,
    machineId: `machine-${index}`,
    type: 'adhdev-daemon',
    status: 'online',
    nickname: `Machine ${index}`,
    availableProviders: [
      {
        type: 'claude',
        name: 'Claude',
        displayName: 'Claude',
        icon: 'claude',
        category: 'cli',
        installed: true,
      },
    ],
    detectedIdes: [],
    workspaces: [],
    recentLaunches: [],
  } as DaemonData
}

function createMachines(count: number): DaemonData[] {
  return Array.from({ length: count }, (_, index) => createMachine(index + 1))
}

function renderDialog(machines: DaemonData[] = [createMachine()]) {
  return renderToStaticMarkup(
    React.createElement(DashboardNewSessionDialog, {
      machines,
      ides: [],
      onClose: () => {},
      onBrowseDirectory: async () => ({ path: '/', directories: [] }),
      onSaveWorkspace: async () => ({ ok: true }),
      onLaunchIde: async () => ({ ok: true }),
      onLaunchProvider: async () => ({ ok: true }),
      onListMeshes: async () => [],
      onLaunchMeshCoordinator: async () => ({ ok: true }),
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

  it('offers workspace and mesh launch target choices in the workspace step', () => {
    const html = renderDialog()

    expect(html).toContain('role="radiogroup" aria-label="Launch target type"')
    expect(html).toContain('Workspace')
    expect(html).toContain('Mesh')
    expect(html).toContain('Coordinator session')
    expect(html).toContain('Start from a normal workspace, or select a repo mesh and run a mesh coordinator.')
  })

  it('shows machines as direct-click chips when there are five or fewer machines', () => {
    const html = renderDialog(createMachines(5))

    expect(html).not.toContain('<select aria-label="Machine"')
    expect(html).toContain('aria-label="Select machine Machine 1"')
    expect(html).toContain('aria-label="Select machine Machine 5"')
    expect(html).toContain('aria-pressed="true"')
  })

  it('uses the compact machine dropdown when there are more than five machines', () => {
    const html = renderDialog(createMachines(6))

    expect(html).toContain('<select aria-label="Machine"')
    expect(html).not.toContain('aria-label="Select machine Machine 1"')
    expect(html).toContain('<option value="machine-6">Machine 6</option>')
  })

  it('omits the separate category chips when mesh coordinator mode already selected CLI implicitly', () => {
    const html = renderToStaticMarkup(
      React.createElement(LaunchCategorySelector, {
        workspaceMode: 'mesh',
        activeKind: 'cli',
        cliEnabled: true,
        ideEnabled: true,
        acpEnabled: true,
        busy: false,
        onSelect: () => {},
      }),
    )

    expect(html).toBe('')
  })

  it('shows category chips for normal workspace launches', () => {
    const html = renderToStaticMarkup(
      React.createElement(LaunchCategorySelector, {
        workspaceMode: 'workspace',
        activeKind: 'cli',
        cliEnabled: true,
        ideEnabled: true,
        acpEnabled: true,
        busy: false,
        onSelect: () => {},
      }),
    )

    expect(html).toContain('Category')
    expect(html).toContain('CLI')
    expect(html).toContain('IDE')
    expect(html).toContain('ACP')
  })
})
