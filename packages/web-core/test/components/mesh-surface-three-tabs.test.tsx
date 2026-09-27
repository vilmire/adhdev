// The mesh live view is three tabs — Overview / Tasks / Map — in the shared
// underline tab bar (2026-09-27 simplification). Status folded into the Map
// tab (per-node runtime in the node panel, internals behind Diagnostics);
// Notes moved to the mesh settings page.
import * as fs from 'node:fs'
import * as path from 'node:path'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/components/MeshGraph/MeshGraphView', () => ({ default: () => null }))

import MeshObservabilitySurface, { MESH_SURFACE_TABS, normalizeMeshSurfaceTab } from '../../src/components/MeshGraph/MeshObservabilitySurface'

const status = {
    meshId: 'mesh_tabs',
    meshName: 'Tabs Mesh',
    repoIdentity: 'repo',
    refreshedAt: '2026-09-27T00:00:00.000Z',
    nodes: [],
    queue: { tasks: [] },
    ledger: { entries: [] },
}

function render(): string {
    return renderToString(
        React.createElement(StaticRouter, { location: '/' },
            React.createElement(MeshObservabilitySurface, { status: status as any })),
    )
}

describe('mesh live view — three tabs', () => {
    it('exposes exactly Overview / Tasks / Map', () => {
        expect(MESH_SURFACE_TABS).toEqual(['overview', 'tasks', 'map'])
        const html = render()
        const tabs = [...html.matchAll(/role="tab"[^>]*id="mesh-surface-tab-(\w+)"|id="mesh-surface-tab-(\w+)"[^>]*role="tab"/g)]
            .map(m => m[1] ?? m[2])
        expect(tabs).toEqual(['overview', 'tasks', 'map'])
        expect(html).toContain('>Overview<')
        expect(html).toContain('>Tasks<')
        expect(html).toContain('>Map<')
        expect(html).not.toContain('>Status<')
        expect(html).not.toContain('>Topology<')
    })

    it('uses the shared underline tab bar (accent underline), not the old boxed pill control', () => {
        const html = render()
        expect(html).toContain('border-accent text-accent')
        expect(html).not.toContain('rounded-lg px-3.5 py-1.5 text-xs font-semibold text-slate-100 bg-white/[0.08]')
    })

    it('each panel is a labelled tabpanel', () => {
        const html = render()
        for (const key of ['overview', 'tasks', 'map']) {
            expect(html).toContain(`id="mesh-surface-panel-${key}"`)
            expect(html).toContain(`aria-labelledby="mesh-surface-tab-${key}"`)
        }
    })

    it('maps retired tab ids onto the new ones', () => {
        expect(normalizeMeshSurfaceTab('graph')).toBe('map')
        expect(normalizeMeshSurfaceTab('status')).toBe('map')
        expect(normalizeMeshSurfaceTab('notes')).toBe('overview')
        expect(normalizeMeshSurfaceTab(undefined)).toBe('overview')
    })

    it('Map keeps the old Status content behind a Diagnostics panel and has one headline chip', () => {
        const source = fs.readFileSync(path.join(import.meta.dirname, '../../src/components/MeshGraph/MeshObservabilitySurface.tsx'), 'utf8')
        expect(source).toContain('<MeshStatusTab canonicalStatus={canonicalStatus} />')
        expect(source).toContain("t('common.diagnostics')")
        // Node side panel carries the per-machine quota + runtime chips.
        expect(source).toContain('<MeshMachineQuotaCard machine={selectedMachineGroup} />')
        expect(source).toContain('<MeshNodeRuntimeChips')
        // The old Health popover and Notes tab are gone from the live view.
        expect(source).not.toContain('MeshHealthPanel')
        expect(source).not.toContain('<MeshNotesTab')
    })

    it('the dialog hosts the tab bar and the ONE refresh control', () => {
        const dialog = fs.readFileSync(path.join(import.meta.dirname, '../../src/components/dashboard/DashboardMeshGraphDialog.tsx'), 'utf8')
        const blueprint = fs.readFileSync(path.join(import.meta.dirname, '../../src/components/MeshGraph/MeshBlueprintView.tsx'), 'utf8')
        expect(dialog).toContain('<MeshSurfaceTabControls')
        expect(dialog).toContain('refreshToken={refreshToken}')
        expect(blueprint).not.toContain("t('mesh.graphs.refresh')")
    })
})
