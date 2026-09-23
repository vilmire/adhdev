import { describe, expect, it } from 'vitest'
import {
    describeModelSelection,
    effectiveModelSelectionValue,
    isModelAxisSource,
    launchModelSelectionValue,
    parseSessionLaunchRecord,
    sanitizeModelIdentifier,
    type ModelSelection,
} from '../src/session-launch'

function selection(overrides: Partial<ModelSelection> = {}): ModelSelection {
    return { source: 'user', history: [], ...overrides }
}

describe('session-launch — effective / launch values', () => {
    it('the last history entry is the value in force', () => {
        const sel = selection({
            requested: 'sonnet',
            launchValue: 'sonnet',
            current: 'opus',
            history: [
                { at: 1, value: 'sonnet', via: 'launch' },
                { at: 2, value: 'opus', via: 'change_model' },
            ],
        })
        expect(effectiveModelSelectionValue(sel)).toBe('opus')
        expect(launchModelSelectionValue(sel)).toBe('sonnet')
        expect(describeModelSelection(sel)).toEqual({ value: 'opus', changedFrom: 'sonnet', source: 'user' })
    })

    it('a provider default is the launch value when nothing was requested', () => {
        const sel = selection({
            source: 'provider_default',
            resolvedDefault: 'opus',
            history: [{ at: 1, value: 'opus', via: 'launch' }],
        })
        expect(describeModelSelection(sel)).toEqual({ value: 'opus', source: 'provider_default' })
    })

    it('an unknown axis describes as nothing', () => {
        expect(describeModelSelection(selection({ source: 'unspecified' }))).toBeUndefined()
        expect(describeModelSelection(undefined)).toBeUndefined()
    })
})

describe('session-launch — server-path sanitizers', () => {
    it('accepts model identifiers', () => {
        for (const id of ['opus', 'claude-opus-4-1-20250805', 'gpt-5.6-sol', 'openai/gpt-4o', 'opus[1m]', 'high', 'kimi-k2:latest']) {
            expect(sanitizeModelIdentifier(id)).toBe(id)
        }
    })

    it('drops free text, labels and oversize values', () => {
        for (const bad of ['fix the auth bug', 'Gemini 3.7 Flash (High)', '', '   ', 'x'.repeat(97), 42, null, {}]) {
            expect(sanitizeModelIdentifier(bad)).toBeUndefined()
        }
    })

    it('modelSource is an enum allow-list', () => {
        expect(isModelAxisSource('user')).toBe(true)
        expect(isModelAxisSource('provider_default')).toBe(true)
        expect(isModelAxisSource('restore')).toBe(false)
        expect(isModelAxisSource('attacker text')).toBe(false)
    })
})

describe('session-launch — parseSessionLaunchRecord', () => {
    const valid = {
        sessionId: 's-1',
        providerType: 'claude-cli',
        launchedBy: 'dashboard',
        launchedAt: 100,
        model: { source: 'remembered', requested: 'sonnet', launchValue: 'sonnet', history: [{ at: 100, value: 'sonnet', via: 'launch' }] },
        thinkingLevel: { source: 'unspecified', history: [] },
    }

    it('round-trips a JSON-serialized record', () => {
        const parsed = parseSessionLaunchRecord(JSON.parse(JSON.stringify(valid)))
        expect(parsed).toEqual(valid)
    })

    it('drops unknown keys and coerces unknown enums', () => {
        const parsed = parseSessionLaunchRecord({
            ...valid,
            launchedBy: 'somewhere',
            smuggled: 'secret prompt text',
            model: { ...valid.model, source: 'attacker', extra: 1, history: [{ at: 1, value: 'x', via: 'bogus' }] },
        })
        expect(parsed).toBeDefined()
        expect(parsed).not.toHaveProperty('smuggled')
        expect(parsed!.launchedBy).toBe('api')
        expect(parsed!.model.source).toBe('unspecified')
        expect(parsed!.model.history).toEqual([])
        expect(parsed!.model).not.toHaveProperty('extra')
    })

    it('rejects anything that is not a launch record', () => {
        expect(parseSessionLaunchRecord(null)).toBeUndefined()
        expect(parseSessionLaunchRecord({ sessionId: 's-1' })).toBeUndefined()
        expect(parseSessionLaunchRecord('launch')).toBeUndefined()
    })
})
