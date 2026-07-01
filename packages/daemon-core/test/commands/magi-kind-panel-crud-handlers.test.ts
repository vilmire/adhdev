import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { meshCrudHandlers } from '../../src/commands/med-family/mesh-crud.js'
import type { MedFamilyContext } from '../../src/commands/med-family/types.js'

/**
 * magi_kind_panel_list / magi_kind_panel_set / magi_kind_panel_remove daemon-core
 * handlers (mesh-crud.ts) — the MAGI-KIND-PANEL feature. They mirror the magi_panel_*
 * handlers: dynamic-import the mesh-config accessors (listMagiKindPanels /
 * setMagiKindPanel / removeMagiKindPanel) and surface normalizeMagiSlots's structured
 * error (invalid_magi_kind_panel) verbatim. The store is ~/.adhdev/meshes.json
 * `magiKindPanels`; we isolate it with ADHDEV_CONFIG_DIR.
 *
 * These bindings back the removed preset auto-synthesis: a bare
 * mesh_magi_review({task_kind}) now resolves the panel from these slots and errors
 * magi_kind_not_configured when the kind is unset — no synthetic fallback.
 */
const ctx = {} as MedFamilyContext

describe('magi_kind_panel_* handlers — per-task_kind slot bindings over meshes.json', () => {
    let prevConfigDir: string | undefined
    let dir: string

    beforeEach(async () => {
        prevConfigDir = process.env.ADHDEV_CONFIG_DIR
        dir = await mkdtemp(join(tmpdir(), 'magi-kind-panel-crud-'))
        process.env.ADHDEV_CONFIG_DIR = dir
    })

    afterEach(async () => {
        if (prevConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
        else process.env.ADHDEV_CONFIG_DIR = prevConfigDir
        await rm(dir, { recursive: true, force: true }).catch(() => {})
    })

    it('lists empty when no kind-panels are configured', async () => {
        const res: any = await meshCrudHandlers.magi_kind_panel_list(ctx, {})
        expect(res.success).toBe(true)
        expect(res.kindPanels).toEqual({})
    })

    it('sets a kind-panel, preserving the model axis, and persists it for list', async () => {
        const setRes: any = await meshCrudHandlers.magi_kind_panel_set(ctx, {
            kind: 'rca',
            slots: [
                { provider: 'claude-cli', nodeId: 'node_a', model: 'opus' },
                { provider: 'codex-cli', capabilityTags: ['os=darwin'], n: 2 },
            ],
        })
        expect(setRes.success).toBe(true)
        expect(setRes.kind).toBe('rca')
        expect(setRes.slots).toHaveLength(2)
        // The model axis is the whole point of this feature — it must survive normalization.
        expect(setRes.slots[0].model).toBe('opus')
        expect(setRes.slots[0].nodeId).toBe('node_a')
        expect(setRes.slots[1].n).toBe(2)

        const listRes: any = await meshCrudHandlers.magi_kind_panel_list(ctx, {})
        expect(listRes.success).toBe(true)
        expect(Object.keys(listRes.kindPanels)).toEqual(['rca'])
        expect(listRes.kindPanels.rca[0].provider).toBe('claude-cli')
        expect(listRes.kindPanels.rca[0].model).toBe('opus')
    })

    it('overwrites the binding for a kind (a kind has exactly one binding)', async () => {
        const first: any = await meshCrudHandlers.magi_kind_panel_set(ctx, {
            kind: 'design',
            slots: [{ provider: 'claude-cli' }, { provider: 'codex-cli' }],
        })
        expect(first.success).toBe(true)

        // A second set for the SAME kind replaces (no overwrite flag needed, unlike named panels).
        const second: any = await meshCrudHandlers.magi_kind_panel_set(ctx, {
            kind: 'design',
            slots: [{ provider: 'gemini-cli', model: 'flash' }],
        })
        expect(second.success).toBe(true)
        expect(second.slots).toHaveLength(1)
        expect(second.slots[0].provider).toBe('gemini-cli')

        const listRes: any = await meshCrudHandlers.magi_kind_panel_list(ctx, {})
        expect(listRes.kindPanels.design).toHaveLength(1)
        expect(listRes.kindPanels.design[0].model).toBe('flash')
    })

    it('accepts freeform as a valid kind-panel key (unlike a named panel defaultKind)', async () => {
        const res: any = await meshCrudHandlers.magi_kind_panel_set(ctx, {
            kind: 'freeform',
            slots: [{ provider: 'claude-cli' }, { provider: 'codex-cli' }],
        })
        expect(res.success).toBe(true)
        const listRes: any = await meshCrudHandlers.magi_kind_panel_list(ctx, {})
        expect(Object.keys(listRes.kindPanels)).toContain('freeform')
    })

    it('rejects an unknown task_kind with invalid_magi_kind_panel', async () => {
        const res: any = await meshCrudHandlers.magi_kind_panel_set(ctx, {
            kind: 'not_a_kind',
            slots: [{ provider: 'claude-cli' }],
        })
        expect(res.success).toBe(false)
        expect(res.error).toMatch(/invalid_magi_kind_panel/)
    })

    it('surfaces invalid_magi_kind_panel for a slot missing a provider', async () => {
        const res: any = await meshCrudHandlers.magi_kind_panel_set(ctx, {
            kind: 'rca',
            slots: [{ nodeId: 'node_a' }],
        })
        expect(res.success).toBe(false)
        expect(res.error).toMatch(/invalid_magi_kind_panel/)
    })

    it('rejects an empty slots list without touching the store', async () => {
        const res: any = await meshCrudHandlers.magi_kind_panel_set(ctx, { kind: 'rca', slots: [] })
        expect(res.success).toBe(false)
        expect(res.error).toMatch(/invalid_magi_kind_panel/)
        const listRes: any = await meshCrudHandlers.magi_kind_panel_list(ctx, {})
        expect(listRes.kindPanels).toEqual({})
    })

    it('rejects an empty/whitespace kind without touching the store', async () => {
        const res: any = await meshCrudHandlers.magi_kind_panel_set(ctx, { kind: '   ', slots: [{ provider: 'claude-cli' }] })
        expect(res.success).toBe(false)
        expect(res.error).toMatch(/invalid_magi_kind_panel/)
    })

    it('removes a binding and reports removed=false for an absent one', async () => {
        await meshCrudHandlers.magi_kind_panel_set(ctx, { kind: 'rca', slots: [{ provider: 'claude-cli' }] })

        const removed: any = await meshCrudHandlers.magi_kind_panel_remove(ctx, { kind: 'rca' })
        expect(removed.success).toBe(true)
        expect(removed.removed).toBe(true)

        const again: any = await meshCrudHandlers.magi_kind_panel_remove(ctx, { kind: 'rca' })
        expect(again.success).toBe(true)
        expect(again.removed).toBe(false)

        const listRes: any = await meshCrudHandlers.magi_kind_panel_list(ctx, {})
        expect(listRes.kindPanels).toEqual({})
    })
})
