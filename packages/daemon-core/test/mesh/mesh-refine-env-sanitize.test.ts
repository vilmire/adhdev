import { describe, expect, it } from 'vitest'

import {
    REFINE_GATE_ENV_ALLOWLIST,
    sanitizeRefineGateChildEnv,
} from '../../src/mesh/mesh-refine-env-sanitize'

/**
 * REFINE-GATE-ENV-SANITIZE unit coverage. See the module comment in
 * mesh-refine-env-sanitize.ts for the incident and the allow-list audit; the
 * integration-level red/green proof against the real gate spawn lives in
 * mesh-refine-gate-env-sanitize.test.ts.
 */
describe('sanitizeRefineGateChildEnv', () => {
    it('strips every ADHDEV_*-prefixed key', () => {
        const env = {
            ADHDEV_WORKER_MCP: 'on',
            ADHDEV_CONFIG_DIR: '/some/dir',
            ADHDEV_PROVIDER_CHANNEL: 'preview',
        } as NodeJS.ProcessEnv
        expect(sanitizeRefineGateChildEnv(env)).toEqual({})
    })

    it('preserves non-ADHDEV keys untouched', () => {
        const env = {
            PATH: '/usr/bin',
            HOME: '/home/x',
            CI: '1',
            NODE_ENV: 'test',
        } as NodeJS.ProcessEnv
        expect(sanitizeRefineGateChildEnv(env)).toEqual(env)
    })

    it('mixes stripped and preserved keys correctly', () => {
        const env = {
            PATH: '/usr/bin',
            ADHDEV_WORKER_MCP: 'on',
            CI: '1',
        } as NodeJS.ProcessEnv
        expect(sanitizeRefineGateChildEnv(env)).toEqual({ PATH: '/usr/bin', CI: '1' })
    })

    it('defaults to process.env when no arg is given', () => {
        const original = process.env.ADHDEV_WORKER_MCP
        process.env.ADHDEV_WORKER_MCP = 'on'
        try {
            expect(sanitizeRefineGateChildEnv().ADHDEV_WORKER_MCP).toBeUndefined()
        } finally {
            if (original === undefined) delete process.env.ADHDEV_WORKER_MCP
            else process.env.ADHDEV_WORKER_MCP = original
        }
    })

    it('the allow-list is currently empty (per the audited decision)', () => {
        expect(REFINE_GATE_ENV_ALLOWLIST.size).toBe(0)
    })
})
