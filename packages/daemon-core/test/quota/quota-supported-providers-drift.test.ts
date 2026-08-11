import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { QUOTA_SUPPORTED_PROVIDERS, supportsQuota } from '@adhdev/mesh-shared'

// QUOTA SUPPORT MATRIX — one list, three consumers.
//
// `REFRESHERS` (quota/refresh.ts) is the runtime authority: a provider absent
// from it is never probed. Two UI surfaces need the same knowledge to decide
// whether to OFFER a quota control — the machine page's per-provider toggle and
// the install-time options (dashboard modal + `adhdev setup`) — and neither can
// import a daemon-core internal array. So the list lives in mesh-shared as
// QUOTA_SUPPORTED_PROVIDERS and this test pins it to REFRESHERS.
//
// Without this gate the failure is silent and user-visible in the worst way: a
// checkbox that appears, accepts a click, persists a value, and then does
// nothing at all, because no fetcher exists behind it. That is exactly the
// "switch that does nothing" the surfaces are supposed to prevent, and adding a
// fetcher without updating the shared list produces the mirror bug — a
// supported provider whose control is never offered.
//
// REFRESHERS is module-private, so it is read from source rather than
// imported. The parse is deliberately narrow: it matches the `provider:` keys
// inside the REFRESHERS literal, so a change to that array's shape fails loudly
// here instead of silently matching nothing.

const REFRESH_SOURCE = path.join(import.meta.dirname, '../../src/quota/refresh.ts')

function refresherProviders(): string[] {
    const source = fs.readFileSync(REFRESH_SOURCE, 'utf8')
    const start = source.indexOf('const REFRESHERS')
    expect(start, 'REFRESHERS declaration not found — did quota/refresh.ts get restructured?').toBeGreaterThan(-1)
    const end = source.indexOf('];', start)
    expect(end, 'REFRESHERS literal is not terminated by "];" — update this parser').toBeGreaterThan(start)

    const body = source.slice(start, end)
    const found = [...body.matchAll(/provider:\s*'([^']+)'/g)].map((match) => match[1])
    expect(found.length, 'parsed zero providers out of REFRESHERS — the parser has drifted').toBeGreaterThan(0)
    return found
}

describe('quota support matrix', () => {
    it('QUOTA_SUPPORTED_PROVIDERS is exactly the shipped REFRESHERS set', () => {
        expect([...QUOTA_SUPPORTED_PROVIDERS].sort()).toEqual(refresherProviders().sort())
    })

    it('covers the providers with a fetcher today', () => {
        // Pinned literally as well as structurally: if BOTH sides are edited in
        // the same wrong way, the comparison above still passes but this fails.
        expect([...QUOTA_SUPPORTED_PROVIDERS].sort()).toEqual(['claude-cli', 'codex-cli', 'kimi', 'opencode'])
    })

    it('excludes providers that cannot report quota', () => {
        // cursor-cli is permanently impossible (no personal usage API);
        // antigravity-cli is supportable via OAuth but has no fetcher; hermes
        // has no model-axis quota. None may be offered a control.
        for (const providerType of ['cursor-cli', 'antigravity-cli', 'hermes-cli']) {
            expect(supportsQuota(providerType), `${providerType} must not claim quota support`).toBe(false)
        }
    })

    it('supportsQuota tolerates the absent/empty provider type', () => {
        expect(supportsQuota(undefined)).toBe(false)
        expect(supportsQuota(null)).toBe(false)
        expect(supportsQuota('')).toBe(false)
    })
})
