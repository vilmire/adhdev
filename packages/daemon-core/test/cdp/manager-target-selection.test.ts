import { describe, expect, it } from 'vitest'
import { resolveCdpPageTarget, type CdpTarget } from '../../src/cdp/manager.js'

describe('resolveCdpPageTarget', () => {
  const makePage = (overrides: Partial<CdpTarget>): CdpTarget => ({
    id: 'target-1',
    type: 'page',
    title: 'remote_vs — main.ts',
    url: 'vscode-file://vscode-app/workbench.html',
    webSocketDebuggerUrl: 'ws://example.test/devtools/page/1',
    ...overrides,
  })

  it('keeps the exact pinned target when it still exists', () => {
    const exact = makePage({ id: 'target-keep', title: 'remote_vs — status-transform.ts' })
    const other = makePage({ id: 'target-other', title: 'remote_vs — index.ts' })

    const result = resolveCdpPageTarget({
      pages: [exact, other],
      pinnedTargetId: 'target-keep',
      previousPageTitle: 'remote_vs — status-transform.ts',
    })

    expect(result).toEqual({ target: exact, retargeted: false })
  })

  it('rebinds to the sole surviving page when the pinned target was recreated', () => {
    const rebound = makePage({ id: 'target-new', title: 'remote_vs — status-transform.ts' })

    const result = resolveCdpPageTarget({
      pages: [rebound],
      pinnedTargetId: 'target-old',
      previousPageTitle: 'remote_vs — status-transform.ts',
    })

    expect(result).toEqual({ target: rebound, retargeted: true })
  })

  it('rebinds to a unique title match when multiple pages exist', () => {
    const rebound = makePage({ id: 'target-new', title: 'remote_vs — status-transform.ts' })
    const other = makePage({ id: 'target-other', title: 'remote_vs — README.md' })

    const result = resolveCdpPageTarget({
      pages: [other, rebound],
      pinnedTargetId: 'target-old',
      previousPageTitle: 'remote_vs — status-transform.ts',
    })

    expect(result).toEqual({ target: rebound, retargeted: true })
  })

  it('fails closed when the pinned target is missing and no unique replacement exists', () => {
    const one = makePage({ id: 'target-1', title: 'remote_vs — README.md' })
    const two = makePage({ id: 'target-2', title: 'remote_vs — index.ts' })

    const result = resolveCdpPageTarget({
      pages: [one, two],
      pinnedTargetId: 'target-old',
      previousPageTitle: 'remote_vs — status-transform.ts',
    })

    expect(result).toEqual({ target: null, retargeted: false })
  })
})
