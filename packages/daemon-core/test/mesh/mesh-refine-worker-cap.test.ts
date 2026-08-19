import { describe, expect, it } from 'vitest'

import {
    DEFAULT_REFINE_VITEST_MAX_WORKERS,
    REFINE_VITEST_MAX_WORKERS_ENV,
    refineGateChildEnv,
    resolveRefineVitestMaxWorkers,
} from '../../src/mesh/mesh-refine-worker-cap'

/**
 * REFINE-GATE-WORKER-CAP — vitest forks one worker per core by default (9 on
 * the 10-core host from the 2026-08-18 freeze RCA); the Refinery gate runner
 * now passes VITEST_MAX_WORKERS to gate children so a single pipeline cannot
 * burst to full-machine CPU. Applied via child env precisely so it reaches
 * vitest behind `npm run test` indirection and so CI (which never goes through
 * the gate runner) is unaffected.
 */

describe('resolveRefineVitestMaxWorkers', () => {
    it('defaults to 2 when unset or empty', () => {
        expect(resolveRefineVitestMaxWorkers({} as NodeJS.ProcessEnv)).toBe(2)
        expect(DEFAULT_REFINE_VITEST_MAX_WORKERS).toBe(2)
        expect(resolveRefineVitestMaxWorkers({ [REFINE_VITEST_MAX_WORKERS_ENV]: '' } as NodeJS.ProcessEnv)).toBe(2)
    })

    it('honors a positive override and floors at 1', () => {
        expect(resolveRefineVitestMaxWorkers({ [REFINE_VITEST_MAX_WORKERS_ENV]: '4' } as NodeJS.ProcessEnv)).toBe(4)
        expect(resolveRefineVitestMaxWorkers({ [REFINE_VITEST_MAX_WORKERS_ENV]: '-3' } as NodeJS.ProcessEnv)).toBe(1)
    })

    it('treats explicit 0 as disabled (null) and unparseable as the default', () => {
        expect(resolveRefineVitestMaxWorkers({ [REFINE_VITEST_MAX_WORKERS_ENV]: '0' } as NodeJS.ProcessEnv)).toBeNull()
        expect(resolveRefineVitestMaxWorkers({ [REFINE_VITEST_MAX_WORKERS_ENV]: 'many' } as NodeJS.ProcessEnv)).toBe(2)
    })
})

describe('refineGateChildEnv', () => {
    it('injects VITEST_MAX_WORKERS=<cap> for gate children by default', () => {
        expect(refineGateChildEnv({} as NodeJS.ProcessEnv)).toEqual({ VITEST_MAX_WORKERS: '2' })
    })

    it('never overrides an operator-set VITEST_MAX_WORKERS in the daemon env', () => {
        expect(refineGateChildEnv({ VITEST_MAX_WORKERS: '8' } as NodeJS.ProcessEnv)).toEqual({})
    })

    it('returns {} when the cap is explicitly disabled', () => {
        expect(refineGateChildEnv({ [REFINE_VITEST_MAX_WORKERS_ENV]: '0' } as NodeJS.ProcessEnv)).toEqual({})
    })
})
