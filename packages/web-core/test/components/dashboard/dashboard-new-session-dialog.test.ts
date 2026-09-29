import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import DashboardNewSessionDialog from '../../../src/components/dashboard/DashboardNewSessionDialog'
import {
  AutoApproveModeSelector,
  DangerousAutoApproveModeDialog,
} from '../../../src/components/dashboard/AutoApproveModeSelector'
import type { DaemonData } from '../../../src/types'

function readDialogSource(): string {
  return fs.readFileSync(
    path.join(import.meta.dirname, '../../../src/components/dashboard/DashboardNewSessionDialog.tsx'),
    'utf8',
  )
}

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
        enabled: true,
        machineStatus: 'detected',
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
  it('shows provider auto-approve modes with risk badges', () => {
    const html = renderToStaticMarkup(
      React.createElement(AutoApproveModeSelector, {
        config: {
          default: 'pty-parse',
          modes: [
            { id: 'pty-parse', label: 'PTY parse (interactive)', strategy: 'pty-parse-default', risk: 'safe' },
            {
              id: 'yolo',
              label: 'YOLO',
              strategy: 'launch-args',
              risk: 'dangerous',
              warning: 'Bypasses all approvals',
              launchArgs: ['--dangerously-bypass-approvals-and-sandbox'],
            },
          ],
        },
        selectedModeId: 'pty-parse',
        onSelectMode: () => {},
      }),
    )

    expect(html).toContain('PTY parse (interactive)')
    expect(html).toContain('YOLO')
    expect(html).toContain('Safe')
    expect(html).toContain('Dangerous')
    expect(html).not.toContain('role="switch"')
  })

  it('keeps the legacy on/off switch when the provider has no modes', () => {
    const html = renderDialog()

    expect(html).toContain('role="switch"')
    expect(html).toContain('Auto approve')
  })

  it('renders the dangerous confirmation with its warning and exact injected launch args', () => {
    const html = renderToStaticMarkup(
      React.createElement(DangerousAutoApproveModeDialog, {
        mode: {
          id: 'yolo',
          label: 'YOLO',
          strategy: 'launch-args',
          risk: 'dangerous',
          warning: 'Only use this in a trusted workspace',
          launchArgs: ['--permission-mode', 'bypassPermissions'],
        },
        onConfirm: () => {},
        onCancel: () => {},
      }),
    )

    expect(html).toContain('Confirm dangerous auto-approve mode')
    expect(html).toContain('Only use this in a trusted workspace')
    expect(html).toContain('[&quot;--permission-mode&quot;,&quot;bypassPermissions&quot;]')
    expect(html).toContain('Use dangerous mode')
  })

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

  it('lists every agent in one grouped radio list with the protocol as a small hint — no Category chip row', () => {
    const machine = createMachine()
    machine.detectedIdes = [{ type: 'cursor', name: 'Cursor', running: true } as any]
    const html = renderDialog([machine])

    expect(html).toContain('role="radiogroup" aria-label="Agent"')
    expect(html).toContain('data-launch-kind="cli"')
    expect(html).toContain('data-launch-kind="ide"')
    expect(html).not.toContain('>Category<')
    expect(readDialogSource()).not.toContain('LaunchCategorySelector')
  })

  it('collapses startup args, auto-approve and model/thinking under "Advanced options" by default', () => {
    const html = renderDialog()
    const advancedStart = html.indexOf('data-testid="new-session-advanced"')
    expect(advancedStart).toBeGreaterThan(-1)
    // A <details> without the `open` attribute = collapsed on first render.
    const detailsTag = html.slice(html.lastIndexOf('<details', advancedStart), html.indexOf('>', advancedStart) + 1)
    expect(detailsTag).not.toMatch(/\sopen(=|\s|>)/)
    expect(html).toContain('Advanced options')
    // The three set-once preferences live INSIDE the disclosure (still reachable).
    const inside = html.slice(advancedStart, html.indexOf('</details>', advancedStart))
    expect(inside).toContain('Startup arguments')
    expect(inside).toContain('Auto approve')
    expect(inside).toContain('Model')
  })

  it('opens folder browsing and saved history inline — no modal on top of the New Session modal', () => {
    const source = readDialogSource()
    expect(source).toContain('<WorkspaceBrowseDialog\n                                            inline')
    expect(source).toContain('<SavedHistoryInlinePanel')
    expect(source).not.toContain('<HistoryModal')
  })

  it('renders the auto-approve mode picker for mesh coordinator launches too, not just workspace launches', () => {
    const source = readDialogSource()

    // The auto-approve LaunchSectionCard must render when workspaceMode is 'mesh' with a
    // target selected, matching the workspace-launch condition (activeKind === 'cli').
    expect(source).toContain("((workspaceMode === 'mesh' && !!selectedTarget) || (workspaceMode !== 'mesh' && activeKind === 'cli'))")
  })

  it('passes the selected auto-approve settings into onLaunchMeshCoordinator', () => {
    const source = readDialogSource()

    const meshLaunchCallMatch = source.match(/onLaunchMeshCoordinator\(selectedMachine\.id, selectedMeshId, selectedTarget, \{[^}]*settings: launchAutoApproveSettings,[^}]*\}\)/)
    expect(meshLaunchCallMatch).not.toBeNull()
  })

  it('defaults the coordinator auto-approve mode using the same resolver as the workspace flow', () => {
    const source = readDialogSource()

    // Both flows share selectedAutoApproveModeId/legacyAutoApprove state, seeded once from
    // resolveInitialAutoApproveModeId — there is no separate "mesh default" branch.
    expect(source).toContain('resolveInitialAutoApproveModeId(autoApproveModes)')
    const resetEffectMatches = [...source.matchAll(/setSelectedAutoApproveModeId\(initialAutoApproveModeId\)/g)]
    expect(resetEffectMatches.length).toBe(1)
  })
})
