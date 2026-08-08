import { describe, expect, it } from 'vitest'
import { MESH_JSON_CONFIG_SCHEMA, normalizeRepoMeshDeclarativeConfig } from '../../src/config/mesh-json-config.js'

/**
 * SCHEMA-LOADER PARITY for `.adhdev/mesh.json` operatingNotes.
 *
 * MESH_JSON_CONFIG_SCHEMA is exported from the package index as the advertised
 * shape of the repo config file, and its note items declare
 * `additionalProperties: false`. So a field that normalizeOperatingNote() reads
 * but the schema omits makes a VALID config fail schema validation — which is
 * exactly what happened: the schema listed 4 properties while the loader read 8,
 * so a repo-declared note could not use `pinned` / `expiresAt` / `supersedes` /
 * `subjectKey` even though the loader honours all four.
 *
 * These tests derive the loader's accepted set by PROBING it rather than
 * restating a hand-written list, so a future field added to the loader fails
 * here instead of silently drifting again.
 */
describe('operatingNotes schema ↔ loader parity', () => {
    /** Every field normalizeOperatingNote() is known to accept, fully populated. */
    const FULLY_POPULATED_NOTE = {
        text: 'prefer mesh_fast_forward_node for clean catch-up',
        category: 'pattern_to_avoid',
        createdAt: '2026-01-01T00:00:00Z',
        sourceCoordinator: 'claude-cli',
        pinned: true,
        expiresAt: '2027-01-01T00:00:00Z',
        supersedes: 'note_abc',
        subjectKey: 'refinery',
    }

    /** The property names the schema currently allows on a note item. */
    const schemaNoteProps = (): string[] => {
        const notes = (MESH_JSON_CONFIG_SCHEMA as any).properties.operatingNotes
        return Object.keys(notes.items.properties)
    }

    /**
     * The property names the loader actually preserves — probed, not asserted
     * from a literal. Anything the loader drops simply won't come back out.
     */
    const loaderAcceptedProps = (): string[] => {
        const { valid, config } = normalizeRepoMeshDeclarativeConfig({
            version: 1,
            operatingNotes: [FULLY_POPULATED_NOTE],
        })
        expect(valid).toBe(true)
        const note = config?.operatingNotes?.[0]
        expect(note).toBeTruthy()
        return Object.keys(note as Record<string, unknown>)
    }

    it('the schema allows every property the loader preserves', () => {
        const missing = loaderAcceptedProps().filter(p => !schemaNoteProps().includes(p))
        // A non-empty list means a valid config would be rejected by the schema.
        expect(missing).toEqual([])
    })

    it('the loader preserves every property the schema advertises', () => {
        // The reverse direction: a schema property the loader silently drops is a
        // promise the config file cannot keep. `noteId` must therefore stay OUT of
        // the schema — it is threaded from the ledger, never repo-declared.
        const accepted = loaderAcceptedProps()
        const advertisedButDropped = schemaNoteProps().filter(p => !accepted.includes(p))
        expect(advertisedButDropped).toEqual([])
        expect(schemaNoteProps()).not.toContain('noteId')
    })

    it('a fully populated repo-declared note round-trips with its lifecycle fields', () => {
        // The concrete case that motivated this: `pinned` on a repo baseline note.
        const { valid, config, errors } = normalizeRepoMeshDeclarativeConfig({
            version: 1,
            operatingNotes: [FULLY_POPULATED_NOTE],
        })
        expect(errors).toEqual([])
        expect(valid).toBe(true)
        expect(config?.operatingNotes?.[0]).toMatchObject({
            pinned: true,
            expiresAt: '2027-01-01T00:00:00Z',
            supersedes: 'note_abc',
            subjectKey: 'refinery',
        })
    })

    it('keeps additionalProperties:false so typos are still rejected', () => {
        // Widening the schema instead of listing the fields would have "fixed" the
        // drift by giving up typo defence. Guard against that regression.
        const notes = (MESH_JSON_CONFIG_SCHEMA as any).properties.operatingNotes
        expect(notes.items.additionalProperties).toBe(false)
        expect(notes.items.required).toEqual(['text'])
    })
})
