import { describe, expect, it } from 'vitest'
import { changelogMissionMarker, classifyChangelogSection, lintChangelogText, isReleaseStatus, isMeshReleaseChannel } from '../src/release'

describe('release helpers', () => {
    it('classifies sections by prefix, then by cues, defaulting to Changed', () => {
        expect(classifyChangelogSection('[Added] A new panel')).toEqual({ section: 'Added', text: 'A new panel' })
        expect(classifyChangelogSection('Fixed the crash on boot').section).toBe('Fixed')
        expect(classifyChangelogSection('Dashboard shows more').section).toBe('Changed')
        expect(classifyChangelogSection('[Changed] Fix wording').section).toBe('Changed')
    })
    it('lints internal vocabulary without rejecting', () => {
        expect(lintChangelogText('Shows a badge')).toEqual([])
        expect(lintChangelogText('wave 3 of rc.34 mission 8d3a1f0e-1111-2222-3333-444455556666').length).toBe(4)
    })
    it('derives a stable idempotency marker and validates vocabularies', () => {
        expect(changelogMissionMarker('8d3a1f0e-1111-2222-3333-444455556666')).toBe('<!-- m:8d3a1f0e -->')
        expect(isReleaseStatus('verified')).toBe(true)
        expect(isReleaseStatus('done')).toBe(false)
        expect(isMeshReleaseChannel('stable')).toBe(true)
    })
})

import { decodeMissionUpsertRequest, isMissionUpsertResponse, TURN_IPC_PROTOCOL_VERSION } from '../src/turn-ipc'

describe('release_note on the mission upsert wire (L5)', () => {
    it('is accepted on the strict request and response decoders, and rejected when not a string', () => {
        const req = { v: TURN_IPC_PROTOCOL_VERSION, meshId: 'mesh-1', title: 'T', structured: true, releaseNote: 'Added a badge.' }
        expect(decodeMissionUpsertRequest(req)).toEqual(req)
        expect(decodeMissionUpsertRequest({ ...req, releaseNote: 5 })).toBeNull()
        expect(decodeMissionUpsertRequest({ ...req, release_note: 'x' })).toBeNull() // unknown keys stay refused
        const mission = { id: 'm1', meshId: 'mesh-1', title: 'T', goal: '', status: 'active', releaseNote: 'Added a badge.', version: 2 }
        expect(isMissionUpsertResponse({ mission })).toBe(true)
        expect(isMissionUpsertResponse({ mission: { ...mission, releaseNote: 7 } })).toBe(false)
    })
})
