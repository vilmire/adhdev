import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { meshCrudHandlers } from '../../src/commands/med-family/mesh-crud.js'
import {
    collectIgnoredMagiSlotFields,
    createMesh,
    addNode,
    getMagiKindPanel,
    normalizeMagiSlots,
    setMagiKindPanel,
} from '../../src/config/mesh-config.js'
import type { MedFamilyContext } from '../../src/commands/med-family/types.js'

/**
 * MAGI slot SILENT-DROP reporting.
 *
 * A MagiSlot is a deliberately reduced schema (provider + optional model / nodeId /
 * capabilityTags / n) — the node-capability routing axes (thinkingLevel, difficulty,
 * maxParallel) are absent BY DESIGN, because a panel selects who answers independently
 * rather than which provider fits the work best. See the MagiSlot doc in mesh-shared.
 *
 * The defect this file guards is NOT the reduction — it is that the reduction was
 * INVISIBLE. normalizeMagiSlots is an allow-list, so an operator could set
 * `thinkingLevel` on a panel slot and get no rejection, no warning, and no effect.
 *
 * The fix is a pure, additive side channel (collectIgnoredMagiSlotFields) surfaced as
 * `ignoredFields` on write responses. The two invariants below are equally load-bearing:
 *
 *   1. an unknown key is REPORTED, and
 *   2. an unknown key is still NOT REJECTED — the write proceeds exactly as before.
 *
 * (2) is the over-correction guard. Throwing here would break read-back of slots
 * already persisted by another version, which is a strictly worse failure than the
 * silent drop this change fixes. Tests assert the non-throwing path explicitly so a
 * future "tighten the validation" edit fails loudly rather than shipping.
 */
describe('collectIgnoredMagiSlotFields — reports dropped keys without rejecting them', () => {
    it('flags thinkingLevel with a reason that points at the node-slot axis', () => {
        const ignored = collectIgnoredMagiSlotFields([
            { provider: 'claude-cli', model: 'opus', thinkingLevel: 'high' },
        ])
        expect(ignored).toHaveLength(1)
        expect(ignored[0]).toMatchObject({ slot: 0, field: 'thinkingLevel' })
        expect(ignored[0].reason).toMatch(/mesh_node_slots_set/)
    })

    it('stays silent for a fully-recognized slot — a clean write reports nothing', () => {
        expect(collectIgnoredMagiSlotFields([
            { provider: 'claude-cli', model: 'opus' },
            { provider: 'codex-cli', nodeId: 'node_1', capabilityTags: ['os=darwin'], n: 2 },
        ])).toEqual([])
    })

    it('flags the other node-capability axes and reports the offending slot index', () => {
        const ignored = collectIgnoredMagiSlotFields([
            { provider: 'claude-cli' },
            { provider: 'codex-cli', difficulty: ['difficult'], maxParallel: 3 },
        ])
        expect(ignored.map(i => i.field).sort()).toEqual(['difficulty', 'maxParallel'])
        expect(ignored.every(i => i.slot === 1)).toBe(true)
    })

    it('catches the capability/capabilityTags near-miss with a did-you-mean', () => {
        const ignored = collectIgnoredMagiSlotFields([{ provider: 'claude-cli', capability: ['x'] }])
        expect(ignored[0].reason).toMatch(/capabilityTags/)
    })

    it('never throws on malformed input — it is a reporter, not a validator', () => {
        expect(() => collectIgnoredMagiSlotFields(undefined)).not.toThrow()
        expect(collectIgnoredMagiSlotFields(undefined)).toEqual([])
        expect(collectIgnoredMagiSlotFields('nope' as unknown)).toEqual([])
        expect(collectIgnoredMagiSlotFields([null, 42, { provider: 'a', zzz: 1 }])).toEqual([
            { slot: 2, field: 'zzz', reason: expect.stringContaining('not a recognized MAGI slot key') },
        ])
    })
})

describe('normalizeMagiSlots — unknown keys are dropped, NEVER rejected (over-correction guard)', () => {
    it('does not throw on an unknown key and normalizes the slot as if it were absent', () => {
        let slots!: ReturnType<typeof normalizeMagiSlots>
        expect(() => {
            slots = normalizeMagiSlots([{ provider: 'claude-cli', model: 'opus', thinkingLevel: 'high' }])
        }).not.toThrow()
        expect(slots).toEqual([{ provider: 'claude-cli', model: 'opus' }])
        expect(slots[0]).not.toHaveProperty('thinkingLevel')
    })

    it('still reads back a slot persisted with an unknown key — the read path cannot regress', () => {
        // The scenario that makes rejecting wrong: a slot already on disk, written by a
        // version that knew a key this one does not. It must stay readable.
        expect(() => normalizeMagiSlots([
            { provider: 'codex-cli', model: 'gpt-5.6-sol', someFutureKey: { nested: true } },
        ])).not.toThrow()
        expect(normalizeMagiSlots([{ provider: 'codex-cli', someFutureKey: 1 }]))
            .toEqual([{ provider: 'codex-cli' }])
    })

    it('keeps rejecting the genuinely invalid shapes it always rejected', () => {
        expect(() => normalizeMagiSlots([])).toThrow(/non-empty array/)
        expect(() => normalizeMagiSlots([{ model: 'opus' }])).toThrow(/provider is required/)
    })
})

describe('magi_kind_panel_set handler — surfaces ignoredFields and still writes', () => {
    const ctx = {} as MedFamilyContext
    let prevConfigDir: string | undefined
    let dir: string
    let meshId: string

    beforeEach(async () => {
        prevConfigDir = process.env.ADHDEV_CONFIG_DIR
        dir = await mkdtemp(join(tmpdir(), 'magi-ignored-fields-'))
        process.env.ADHDEV_CONFIG_DIR = dir
        meshId = createMesh({ name: 'solo', repoIdentity: 'github.com/acme/solo' }).id
        addNode(meshId, { workspace: '/tmp/solo-node' })
    })

    afterEach(async () => {
        if (prevConfigDir === undefined) delete process.env.ADHDEV_CONFIG_DIR
        else process.env.ADHDEV_CONFIG_DIR = prevConfigDir
        await rm(dir, { recursive: true, force: true }).catch(() => {})
    })

    it('reports thinkingLevel as ignored AND persists the panel (write is not blocked)', async () => {
        const res: any = await meshCrudHandlers.magi_kind_panel_set(ctx, {
            kind: 'rca',
            meshId,
            slots: [
                { provider: 'claude-cli', model: 'opus', thinkingLevel: 'high' },
                { provider: 'codex-cli', model: 'gpt-5.6-sol' },
            ],
        })

        expect(res.success).toBe(true)
        expect(res.ignoredFields).toEqual([
            { slot: 0, field: 'thinkingLevel', reason: expect.stringContaining('mesh_node_slots_set') },
        ])
        // The write still happened, with the dropped key absent — reported, not rejected.
        expect(res.slots).toEqual([
            { provider: 'claude-cli', model: 'opus' },
            { provider: 'codex-cli', model: 'gpt-5.6-sol' },
        ])
        expect(getMagiKindPanel('rca', meshId)).toEqual(res.slots)
    })

    it('omits ignoredFields entirely for a clean payload — no noise on the normal path', async () => {
        const res: any = await meshCrudHandlers.magi_kind_panel_set(ctx, {
            kind: 'design',
            meshId,
            slots: [{ provider: 'claude-cli', model: 'opus' }, { provider: 'codex-cli' }],
        })
        expect(res.success).toBe(true)
        expect(res).not.toHaveProperty('ignoredFields')
    })

    it('leaves the direct config accessor free of the reporting concern', () => {
        // setMagiKindPanel keeps its exact prior contract (returns MagiSlot[]), so every
        // existing caller is untouched; reporting is the caller's opt-in side channel.
        const written = setMagiKindPanel('freeform', [{ provider: 'kimi', maxParallel: 9 }], meshId)
        expect(written).toEqual([{ provider: 'kimi' }])
    })
})
