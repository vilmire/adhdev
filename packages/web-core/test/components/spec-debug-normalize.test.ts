import { describe, expect, it } from 'vitest'
import {
    isSpecShapedSnapshot,
    normalizeSpecSnapshot,
} from '../../src/components/dashboard/spec-debug-normalize'

/**
 * A representative spec-driven adapter snapshot (SpecCliAdapter.getDebugSnapshot).
 * This is the shape the Spec Debug panel was originally written against.
 */
function specDrivenSnapshot() {
    return {
        cliType: 'codex',
        spec_id: 'codex@4.0',
        specPath: '/home/u/.adhdev/providers/cli/codex/specs/4.0.json',
        current_state: { id: 'idle', label: 'Idle', title: null },
        current_modal: null,
        activeInteractivePrompt: null,
        exited: false,
        screen: 'line1\nline2',
        sections: { footer: 'ready' },
        stateHistory: [{ stateId: 'busy', label: 'Busy', at: 1, durationMs: 100 }],
        idleHoldPending: false,
        lastBusyAt: 123,
        cursorPosition: { row: 2, col: 0 },
        completionIdleDebounce: null,
        fsm: null,
        name: 'Codex CLI',
        status: 'idle',
        workingDir: '/repo',
        spawnedAtMs: 1000,
        providerSessionId: 'sess-1',
        messages: [{ role: 'assistant', content: 'done' }],
        committedMessages: [{ role: 'assistant', content: 'done' }],
    }
}

/**
 * A diagnostics-shaped object with NONE of the spec state-machine fields (the
 * deleted legacy ProviderCliAdapter's shape) — no longer a snapshot.
 */
function nativeSourceSnapshot() {
    return {
        cliType: 'kimi',
        cliName: 'Kimi Code',
        workingDir: '/repo',
        currentStatus: 'generating',
        ready: true,
        isWaitingForResponse: true,
        activeModal: null,
        parseErrorMessage: null,
        messageCounts: { parsedCache: 3 },
        buffers: { accumulatedLength: 4000, accumulatedTail: 'tail' },
        terminal: {
            screenText: 'kimi screen line 1\nkimi screen line 2',
            lastScreenText: 'kimi screen line 1\nkimi screen line 2',
            lastOutputAt: 42,
        },
        parser: {
            scriptNames: [],
            parsedStatusCache: {
                id: 'x',
                status: 'generating',
                title: 'thinking',
                providerSessionId: 'kimi-sess-9',
                transcriptAuthority: 'provider',
                activeModal: null,
                messageCount: 3,
            },
        },
        runtimeMetadata: { spawnedAtMs: 2000, providerSessionId: 'kimi-sess-9' },
        timing: { spawnAt: 2000 },
    }
}

describe('isSpecShapedSnapshot', () => {
    it('recognizes a spec-driven snapshot by spec_id', () => {
        expect(isSpecShapedSnapshot(specDrivenSnapshot())).toBe(true)
    })

    it('recognizes a spec snapshot by current_state key even without spec_id', () => {
        expect(isSpecShapedSnapshot({ current_state: null })).toBe(true)
    })

    it('recognizes a spec snapshot by a stateHistory array', () => {
        expect(isSpecShapedSnapshot({ stateHistory: [] })).toBe(true)
    })

    it('treats the native-source diagnostics shape as NOT spec-shaped', () => {
        expect(isSpecShapedSnapshot(nativeSourceSnapshot())).toBe(false)
    })

    it('treats null / non-object as not spec-shaped', () => {
        expect(isSpecShapedSnapshot(null)).toBe(false)
        expect(isSpecShapedSnapshot(undefined)).toBe(false)
        expect(isSpecShapedSnapshot('x')).toBe(false)
    })
})

describe('normalizeSpecSnapshot — spec-driven pass-through', () => {
    it('returns null for null/undefined input', () => {
        expect(normalizeSpecSnapshot(null)).toBeNull()
        expect(normalizeSpecSnapshot(undefined)).toBeNull()
    })

    it('passes a spec-driven snapshot through', () => {
        const out = normalizeSpecSnapshot(specDrivenSnapshot())!
        expect(out).not.toBeNull()
        expect(out.spec_id).toBe('codex@4.0')
        expect(out.current_state).toEqual({ id: 'idle', label: 'Idle', title: null })
        expect(out.stateHistory).toHaveLength(1)
        expect(out.sections).toEqual({ footer: 'ready' })
        expect(out.screen).toBe('line1\nline2')
        expect(out.messages).toEqual([{ role: 'assistant', content: 'done' }])
    })
})

describe('normalizeSpecSnapshot — non-spec shapes', () => {
    it('returns null for a diagnostics shape without state-machine fields (no legacy engine remains)', () => {
        expect(normalizeSpecSnapshot(nativeSourceSnapshot())).toBeNull()
    })
})
