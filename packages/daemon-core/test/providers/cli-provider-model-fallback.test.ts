import { describe, expect, it, vi } from 'vitest'
import {
    MODEL_FALLBACK_SCAN_WINDOW_MS,
    detectModelFallback,
    scanModelFallback,
    type ModelFallbackHost,
} from '../../src/providers/cli-provider-model-fallback.js'

const AGY = { pattern: 'is not recognized as a known model.{0,160}?Using "([^"]+)" instead', flags: 'i' }
// Real agy 1.4.9 output, hard-wrapped by the terminal.
const WARNING = [
    '  ⚠ Warning',
    '  ⎿ model claude-opus-4-6-thinking is not recognized as a known model or custom',
    '    model in settings. Using "Gemini 4 Argon (Medium)" instead.',
].join('\n')

function host(screen: string, requested: string = 'Claude Opus 4.6 (Thinking)') {
    const observeLaunchModel = vi.fn()
    const h: ModelFallbackHost = {
        instanceId: 's1',
        provider: { modelFallbackWarning: AGY },
        lifecyclePort: {
            launchRecord: () => ({ model: { requested } }) as never,
            observeLaunchModel,
        } as never,
        adapter: { getTerminalScreenSnapshot: () => ({ text: screen }) },
    }
    return { h, observeLaunchModel }
}

describe('detectModelFallback', () => {
    it('captures the substituted model from a wrapped warning', () => {
        expect(detectModelFallback(AGY, WARNING)).toBe('Gemini 4 Argon (Medium)')
    })
    it('named group `actual` wins; no match / bad pattern / no pattern -> null', () => {
        expect(detectModelFallback({ pattern: '(?<actual>X-\\d+) instead' }, 'ran X-9 instead')).toBe('X-9')
        expect(detectModelFallback(AGY, 'Claude Opus 5.5 (High)  ready')).toBeNull()
        expect(detectModelFallback({ pattern: '([' }, WARNING)).toBeNull()
        expect(detectModelFallback(undefined, WARNING)).toBeNull()
    })
})

describe('scanModelFallback', () => {
    it('records the fallback once, with the fallback flag', () => {
        const { h, observeLaunchModel } = host(WARNING)
        expect(scanModelFallback(h, 1000)).toBe(true)
        expect(scanModelFallback(h, 2000)).toBe(false)
        expect(observeLaunchModel).toHaveBeenCalledTimes(1)
        expect(observeLaunchModel).toHaveBeenCalledWith('s1', 'Gemini 4 Argon (Medium)', 1000, { fallback: true })
    })
    it('does nothing when no model was requested, the screen is clean, or the window passed', () => {
        const none = host(WARNING, '')
        expect(scanModelFallback(none.h, 1000)).toBe(false)
        const clean = host('Claude Opus 5.5 (High)')
        expect(scanModelFallback(clean.h, 1000)).toBe(false)
        const late = host('')
        scanModelFallback(late.h, 1000) // opens the window on a clean screen
        ;(late.h.adapter as { getTerminalScreenSnapshot: () => { text: string } }).getTerminalScreenSnapshot = () => ({ text: WARNING })
        expect(scanModelFallback(late.h, 1000 + MODEL_FALLBACK_SCAN_WINDOW_MS + 1)).toBe(false)
        expect(late.observeLaunchModel).not.toHaveBeenCalled()
    })
})
