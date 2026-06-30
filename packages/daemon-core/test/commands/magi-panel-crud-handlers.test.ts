import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { meshCrudHandlers } from '../../src/commands/med-family/mesh-crud.js'
import type { MedFamilyContext } from '../../src/commands/med-family/types.js'

/**
 * magi_panel_list / magi_panel_set / magi_panel_remove daemon-core handlers
 * (mesh-crud.ts). They mirror list_meshes/create_mesh/update_mesh: dynamic-import
 * the already-exported mesh-config accessors (listMagiPanels / upsertMagiPanel /
 * removeMagiPanel) and surface normalizeMagiPanel's structured error codes
 * (invalid_magi_panel, magi_panel_exists) verbatim to the caller. The store is
 * ~/.adhdev/meshes.json `magiPanels`; we isolate it with ADHDEV_CONFIG_DIR.
 *
 * The three handlers ignore the MedFamilyContext (panels are pure machine-local
 * config, no mesh ownership), so a minimal cast suffices.
 */
const ctx = {} as MedFamilyContext

describe('magi_panel_* handlers — CRUD over machine-local meshes.json', () => {
    let prevConfigDir: string | undefined
    let dir: string

    beforeEach(async () => {
        prevConfigDir = process.env.ADHDEV_CONFIG_DIR
        dir = await mkdtemp(join(tmpdir(), 'magi-panel-crud-'))
        process.env.ADHDEV_CONFIG_DIR = dir
    })

    afterEach(async () => {
        if (prevConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
        else process.env.ADHDEV_CONFIG_DIR = prevConfigDir
        await rm(dir, { recursive: true, force: true }).catch(() => {})
    })

    it('lists empty when no panels are configured', async () => {
        const res: any = await meshCrudHandlers.magi_panel_list(ctx, {})
        expect(res.success).toBe(true)
        expect(res.panels).toEqual({})
    })

    it('sets a panel, normalizing members and persisting it for list', async () => {
        const setRes: any = await meshCrudHandlers.magi_panel_set(ctx, {
            name: 'design-review',
            panel: {
                description: 'cross-machine design review',
                defaultN: 2,
                members: [
                    { provider: 'claude-cli', nodeId: 'node_a' },
                    { provider: 'codex-cli', capabilityTags: ['os=darwin'] },
                ],
            },
        })
        expect(setRes.success).toBe(true)
        expect(setRes.name).toBe('design-review')
        expect(setRes.panel.members).toHaveLength(2)
        // normalizeMagiPanel stamps dedupExempt true for a MAGI panel.
        expect(setRes.panel.dedupExempt).toBe(true)

        const listRes: any = await meshCrudHandlers.magi_panel_list(ctx, {})
        expect(listRes.success).toBe(true)
        expect(Object.keys(listRes.panels)).toEqual(['design-review'])
        expect(listRes.panels['design-review'].members[0].provider).toBe('claude-cli')
    })

    it('refuses to clobber an existing panel without overwrite (magi_panel_exists)', async () => {
        const base = { name: 'p', panel: { members: [{ provider: 'claude-cli' }] } }
        const first: any = await meshCrudHandlers.magi_panel_set(ctx, base)
        expect(first.success).toBe(true)

        const clobber: any = await meshCrudHandlers.magi_panel_set(ctx, base)
        expect(clobber.success).toBe(false)
        expect(clobber.error).toMatch(/magi_panel_exists/)

        const overwrite: any = await meshCrudHandlers.magi_panel_set(ctx, {
            ...base,
            panel: { members: [{ provider: 'gemini-cli' }] },
            overwrite: true,
        })
        expect(overwrite.success).toBe(true)
        expect(overwrite.panel.members[0].provider).toBe('gemini-cli')
    })

    it('round-trips an optional defaultKind (claim_audit / rca / design)', async () => {
        const setRes: any = await meshCrudHandlers.magi_panel_set(ctx, {
            name: 'rca-panel',
            panel: { defaultKind: 'rca', members: [{ provider: 'claude-cli' }] },
        })
        expect(setRes.success).toBe(true)
        expect(setRes.panel.defaultKind).toBe('rca')

        const listRes: any = await meshCrudHandlers.magi_panel_list(ctx, {})
        expect(listRes.panels['rca-panel'].defaultKind).toBe('rca')
    })

    it("drops defaultKind='freeform' (no structured claims → must not be a panel default)", async () => {
        // freeform contributes claims:[] to synthesis, so it is rejected as a panel
        // default and normalized to undefined (a warning is logged, not an error).
        const setRes: any = await meshCrudHandlers.magi_panel_set(ctx, {
            name: 'ff-panel',
            panel: { defaultKind: 'freeform', members: [{ provider: 'claude-cli' }] },
        })
        expect(setRes.success).toBe(true)
        expect(setRes.panel.defaultKind).toBeUndefined()
    })

    it('drops an unknown/typo defaultKind without failing the write', async () => {
        const setRes: any = await meshCrudHandlers.magi_panel_set(ctx, {
            name: 'typo-panel',
            panel: { defaultKind: 'claimaudit', members: [{ provider: 'claude-cli' }] },
        })
        expect(setRes.success).toBe(true)
        expect(setRes.panel.defaultKind).toBeUndefined()
    })

    it('surfaces invalid_magi_panel for a member missing a provider', async () => {
        const res: any = await meshCrudHandlers.magi_panel_set(ctx, {
            name: 'bad',
            panel: { members: [{ nodeId: 'node_a' }] },
        })
        expect(res.success).toBe(false)
        expect(res.error).toMatch(/invalid_magi_panel/)
    })

    it('rejects an empty/whitespace panel name without touching the store', async () => {
        const res: any = await meshCrudHandlers.magi_panel_set(ctx, { name: '   ', panel: { members: [{ provider: 'claude-cli' }] } })
        expect(res.success).toBe(false)
        expect(res.error).toMatch(/invalid_magi_panel/)
        const listRes: any = await meshCrudHandlers.magi_panel_list(ctx, {})
        expect(listRes.panels).toEqual({})
    })

    it('removes a panel and reports removed=false for an absent one', async () => {
        await meshCrudHandlers.magi_panel_set(ctx, { name: 'p', panel: { members: [{ provider: 'claude-cli' }] } })

        const removed: any = await meshCrudHandlers.magi_panel_remove(ctx, { name: 'p' })
        expect(removed.success).toBe(true)
        expect(removed.removed).toBe(true)

        const again: any = await meshCrudHandlers.magi_panel_remove(ctx, { name: 'p' })
        expect(again.success).toBe(true)
        expect(again.removed).toBe(false)

        const listRes: any = await meshCrudHandlers.magi_panel_list(ctx, {})
        expect(listRes.panels).toEqual({})
    })
})
