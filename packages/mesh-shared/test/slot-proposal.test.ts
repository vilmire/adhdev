import { describe, expect, it } from 'vitest'
import {
    CLI_SLOT_RECIPES,
    UNKNOWN_CLI_SLOT_RECIPE,
    buildMagiPanelProposal,
    buildSlotProposal,
    type DetectedCliProvider,
    type NodeCapabilitySlot,
} from '../src/index'

const det = (...types: string[]): DetectedCliProvider[] => types.map(type => ({ type }))

describe('buildSlotProposal — mapping table → slots', () => {
    it('maps every table provider to its seeded recipe', () => {
        // One assertion per provider in the table, so a silent edit to any row fails here.
        const cases: Array<{ type: string; expect: Partial<NodeCapabilitySlot>[] }> = [
            {
                type: 'claude-cli',
                expect: [
                    { provider: 'claude-cli', model: 'sonnet', thinkingLevel: 'high', difficulty: ['medium', 'easy'], maxParallel: 5 },
                    { provider: 'claude-cli', model: 'opus', thinkingLevel: 'high', difficulty: ['difficult'], maxParallel: 1 },
                ],
            },
            { type: 'kimi', expect: [{ provider: 'kimi', model: 'kimi-code/k3', difficulty: ['medium', 'difficult'], maxParallel: 2 }] },
            { type: 'codex-cli', expect: [{ provider: 'codex-cli', difficulty: ['medium', 'difficult', 'freeform'], maxParallel: 2 }] },
            { type: 'antigravity-cli', expect: [{ provider: 'antigravity-cli', model: 'Gemini 3.1 Pro (High)', difficulty: ['easy'], maxParallel: 2 }] },
            { type: 'cursor-cli', expect: [{ provider: 'cursor-cli', model: 'auto', difficulty: ['easy'], maxParallel: 1 }] },
            { type: 'hermes-cli', expect: [{ provider: 'hermes-cli', difficulty: ['medium'], maxParallel: 2 }] },
        ]

        for (const c of cases) {
            const { proposedSlots } = buildSlotProposal(det(c.type))
            expect(proposedSlots, c.type).toHaveLength(c.expect.length)
            c.expect.forEach((want, i) => expect(proposedSlots[i], `${c.type}[${i}]`).toMatchObject(want))
        }
    })

    it('gives claude-cli two slots — a wide sonnet slot and a capped opus slot', () => {
        const { proposedSlots } = buildSlotProposal(det('claude-cli'))
        expect(proposedSlots).toHaveLength(2)
        // The cost-bounding property that makes the opus slot safe.
        expect(proposedSlots[1].maxParallel).toBe(1)
        expect(proposedSlots[1].difficulty).toEqual(['difficult'])
    })

    it('flags hermes-cli as provisional (it is an estimate, not an observed slot)', () => {
        const p = buildSlotProposal(det('hermes-cli'))
        expect(p.provisionalProviders).toEqual(['hermes-cli'])
        expect(p.entries[0].provisional).toBe(true)
        expect(p.unknownProviders).toEqual([])
    })

    it('does NOT flag transcribed providers as provisional', () => {
        const p = buildSlotProposal(det('claude-cli', 'codex-cli', 'kimi'))
        expect(p.provisionalProviders).toEqual([])
        expect(p.entries.every(e => !e.provisional)).toBe(true)
    })

    it('falls back conservatively for an unrecognized provider', () => {
        const p = buildSlotProposal(det('brand-new-cli'))
        expect(p.unknownProviders).toEqual(['brand-new-cli'])
        expect(p.provisionalProviders).toEqual(['brand-new-cli'])
        expect(p.proposedSlots).toHaveLength(1)
        expect(p.proposedSlots[0]).toMatchObject({
            provider: 'brand-new-cli',
            difficulty: UNKNOWN_CLI_SLOT_RECIPE.difficulty,
            maxParallel: 1,
        })
        // The point of the fallback: it must never out-compete a known provider.
        expect(p.proposedSlots[0].maxParallel).toBe(1)
        expect(p.proposedSlots[0].model).toBeUndefined()
    })

    it('handles a mix of known and unknown providers', () => {
        const p = buildSlotProposal(det('claude-cli', 'mystery-cli'))
        expect(p.unknownProviders).toEqual(['mystery-cli'])
        expect(p.proposedSlots.map(s => s.provider)).toEqual(['claude-cli', 'claude-cli', 'mystery-cli'])
        expect(p.entries.filter(e => e.unknownProvider)).toHaveLength(1)
    })

    it('carries a rationale on every proposed slot', () => {
        const p = buildSlotProposal(det('claude-cli', 'unknown-thing'))
        expect(p.entries.every(e => typeof e.rationale === 'string' && e.rationale.length > 0)).toBe(true)
    })

    it('dedupes repeated detections and ignores blank types', () => {
        const p = buildSlotProposal([
            { type: 'kimi' }, { type: 'kimi' }, { type: '  ' }, { type: '' } as DetectedCliProvider,
        ])
        expect(p.proposedSlots).toHaveLength(1)
        expect(p.proposedSlots[0].provider).toBe('kimi')
    })

    it('normalizes through normalizeNodeCapabilitySlot — no empty keys leak into the draft', () => {
        const { proposedSlots } = buildSlotProposal(det('codex-cli'))
        // codex-cli pins neither model nor thinkingLevel; those keys must be ABSENT,
        // not present-and-empty, or the preview would differ from the written shape.
        expect('model' in proposedSlots[0]).toBe(false)
        expect('thinkingLevel' in proposedSlots[0]).toBe(false)
    })
})

describe('buildSlotProposal — empty detection', () => {
    it('returns an empty, non-destructive proposal without throwing', () => {
        const p = buildSlotProposal([])
        expect(p.proposedSlots).toEqual([])
        expect(p.entries).toEqual([])
        expect(p.unknownProviders).toEqual([])
        expect(p.droppedSlots).toEqual([])
        expect(p.destructive).toBe(false)
    })

    it('tolerates undefined/null input', () => {
        expect(() => buildSlotProposal(undefined as any)).not.toThrow()
        expect(buildSlotProposal(undefined as any).proposedSlots).toEqual([])
    })

    it('still reports current slots as dropped when detection is empty', () => {
        // Guards the caller contract: an empty draft is NOT a safe wholesale write.
        const current: NodeCapabilitySlot[] = [{ provider: 'claude-cli', model: 'opus' }]
        const p = buildSlotProposal([], current)
        expect(p.destructive).toBe(true)
        expect(p.droppedSlots).toEqual(current)
        expect(p.droppedProviders).toEqual(['claude-cli'])
    })
})

describe('buildSlotProposal — destructive diff against existing slots', () => {
    it('reports a hand-tuned slot the draft would delete', () => {
        const current: NodeCapabilitySlot[] = [
            { provider: 'claude-cli', model: 'sonnet', thinkingLevel: 'high', difficulty: ['medium', 'easy'], maxParallel: 5 },
            { provider: 'gemini-cli', model: 'flash', capability: ['docs'], maxParallel: 3 },
        ]
        const p = buildSlotProposal(det('claude-cli'), current)

        expect(p.destructive).toBe(true)
        // gemini-cli isn't installed → not in the draft → it would be destroyed.
        expect(p.droppedProviders).toEqual(['gemini-cli'])
        expect(p.droppedSlots.some(s => s.provider === 'gemini-cli' && s.capability?.includes('docs'))).toBe(true)
    })

    it('treats an identical existing slot as preserved, not dropped', () => {
        const current: NodeCapabilitySlot[] = [
            { provider: 'cursor-cli', model: 'auto', difficulty: ['easy'], maxParallel: 1 },
        ]
        const p = buildSlotProposal(det('cursor-cli'), current)
        expect(p.droppedSlots).toEqual([])
        expect(p.destructive).toBe(false)
    })

    it('reports a same-provider slot whose tuning differs as dropped', () => {
        // The subtle destructive case: provider survives, the operator's tuning does not.
        const current: NodeCapabilitySlot[] = [
            { provider: 'cursor-cli', model: 'auto', difficulty: ['easy'], maxParallel: 9 },
        ]
        const p = buildSlotProposal(det('cursor-cli'), current)
        expect(p.destructive).toBe(true)
        expect(p.droppedSlots).toHaveLength(1)
        expect(p.droppedSlots[0].maxParallel).toBe(9)
        // Provider still present in the draft, so it is NOT a dropped provider.
        expect(p.droppedProviders).toEqual([])
    })

    it('is non-destructive for a node with no slots yet (the bootstrap case)', () => {
        const p = buildSlotProposal(det('claude-cli', 'codex-cli'), [])
        expect(p.destructive).toBe(false)
        expect(p.droppedSlots).toEqual([])
        expect(p.proposedSlots.length).toBeGreaterThan(0)
    })
})

describe('buildMagiPanelProposal', () => {
    it('proposes one slot per detected provider, models unpinned', () => {
        const panel = buildMagiPanelProposal(det('claude-cli', 'codex-cli', 'kimi'))
        expect(panel).toHaveLength(3)
        expect(panel.every(s => s.model === undefined)).toBe(true)
        expect(panel.every(s => s.nodeId === undefined)).toBe(true)
    })

    it('pins nodeId when given', () => {
        const panel = buildMagiPanelProposal(det('claude-cli'), { nodeId: 'node_abc' })
        expect(panel[0]).toEqual({ nodeId: 'node_abc', provider: 'claude-cli' })
    })

    it('orders table-known providers ahead of unknown ones', () => {
        const panel = buildMagiPanelProposal(det('zzz-unknown-cli', 'claude-cli'))
        expect(panel.map(s => s.provider)).toEqual(['claude-cli', 'zzz-unknown-cli'])
    })

    it('respects maxSlots', () => {
        const panel = buildMagiPanelProposal(det('claude-cli', 'codex-cli', 'kimi'), { maxSlots: 2 })
        expect(panel).toHaveLength(2)
    })

    it('returns an empty panel for no detections', () => {
        expect(buildMagiPanelProposal([])).toEqual([])
    })

    it('dedupes providers so a panel never double-counts one source', () => {
        // Independence is the whole point of MAGI — duplicate providers would inflate it.
        const panel = buildMagiPanelProposal(det('kimi', 'kimi'))
        expect(panel).toHaveLength(1)
    })
})

describe('CLI_SLOT_RECIPES table integrity', () => {
    it('is frozen so callers cannot mutate the shared table', () => {
        expect(Object.isFrozen(CLI_SLOT_RECIPES)).toBe(true)
        expect(Object.isFrozen(UNKNOWN_CLI_SLOT_RECIPE)).toBe(true)
    })

    it('marks exactly hermes-cli as provisional among table entries', () => {
        const provisional = Object.entries(CLI_SLOT_RECIPES)
            .filter(([, recipes]) => recipes.some(r => r.provisional))
            .map(([type]) => type)
        expect(provisional).toEqual(['hermes-cli'])
    })

    it('declares only valid difficulty values', () => {
        const valid = new Set(['easy', 'medium', 'difficult', 'freeform'])
        for (const [type, recipes] of Object.entries(CLI_SLOT_RECIPES)) {
            for (const r of recipes) {
                for (const d of r.difficulty ?? []) {
                    expect(valid.has(d), `${type} → ${d}`).toBe(true)
                }
            }
        }
    })
})
