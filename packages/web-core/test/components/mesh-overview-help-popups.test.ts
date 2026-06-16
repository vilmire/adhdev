import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import MeshOverviewCards from '../../src/components/MeshGraph/MeshOverviewCards'
import type { RepoMeshStatus } from '@adhdev/daemon-core'

// Minimal status: enough nodes/queue/ledger so every card (and thus every help
// button) renders. The help buttons live in the card headers, which render
// regardless of how much data each card has.
const status = {
  meshId: 'mesh-test',
  refreshedAt: new Date(0).toISOString(),
  nodes: [
    {
      nodeId: 'node-1',
      daemonId: 'daemon-1',
      machineId: 'machine-1',
      machineLabel: 'workstation',
      workspace: '/repo',
      health: 'online',
      git: { branch: 'main' },
    },
  ],
  queue: { summary: { pending: 0, assigned: 0, active: 0, completed: 0, failed: 0, cancelled: 0, historical: 0 }, tasks: [] },
  ledger: { summary: { meshId: 'mesh-test', totalEntries: 0, taskDispatched: 0, taskCompleted: 0, taskFailed: 0, taskStalled: 0, sessionLaunched: 0, checkpointCreated: 0, lastActivityAt: null, recentFailures: 0 }, entries: [] },
  missions: [],
} as unknown as RepoMeshStatus

function renderOverview(): string {
  return renderToStaticMarkup(React.createElement(MeshOverviewCards, { status }))
}

describe('MeshOverviewCards concept help popups', () => {
  it('renders an accessible "?" help button for each documented mesh concept', () => {
    const html = renderOverview()

    // One labelled help button per concept the end user needs to understand.
    expect(html).toContain('aria-label="What is a Mission?"')
    expect(html).toContain('aria-label="What is a Node?"')
    expect(html).toContain('aria-label="What is a Ledger?"')
    expect(html).toContain('aria-label="What is the Refinery?"')
    // Queue + Task share one button.
    expect(html).toContain('aria-label="What are the Queue and Tasks?"')

    // Buttons are real buttons (keyboard focusable) carrying the help icon.
    expect(html).toContain('type="button"')
    expect(html).toContain('<svg')
  })

  it('defines a plain-language summary for every mesh concept', () => {
    // The popover copy is the user-facing payload; assert the key phrasing so a
    // future edit that drops or muddles a definition is caught. (The popover
    // only mounts on click, so we assert the catalog from source rather than the
    // static render.)
    const source = readFileSync(
      join(import.meta.dirname, '../../src/components/MeshGraph/MeshOverviewCards.tsx'),
      'utf-8',
    )
    expect(source).toContain('isolated git worktree')          // Node
    expect(source).toContain('durable record')                 // Mission
    expect(source).toContain('pending → assigned → completed') // Task
    expect(source).toContain('idle nodes autonomously pull')   // Queue
    expect(source).toContain('It is history, not a to-do list')// Ledger
    expect(source).toContain('validate → merge → push → clean up') // Refinery
  })
})
