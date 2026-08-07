import { readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Guards against test/**/*.test.tsx silently never running because the
// vitest.config.ts `include` glob only matched .test.ts -- exactly what
// happened here: three .tsx suites (including this file's sibling
// pane-group-empty-state.test.tsx) existed on disk but were never executed
// for months. This walks the real filesystem the same way Vitest's own
// `test/**/*.test.ts` pattern does, so a future narrowing of `include` (or a
// new test extension the config doesn't cover) fails loudly instead of
// silently skipping files.

const testDir = dirname(fileURLToPath(import.meta.url))
const testRoot = join(testDir, '..')

function findTestFiles(dir: string): string[] {
    const found: string[] = []
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
            found.push(...findTestFiles(full))
        } else if (/\.test\.tsx?$/.test(entry)) {
            found.push(relative(testRoot, full))
        }
    }
    return found
}

describe('vitest include glob coverage', () => {
    it('include pattern covers every .test.ts(x) file under test/', async () => {
        const onDisk = findTestFiles(testRoot).sort()

        const { default: config } = await import('../../vitest.config.ts')
        const include: string[] = config.test?.include ?? []

        // Mirror the two extensions the repo's tests actually use. If a new
        // extension shows up on disk that isn't .ts/.tsx, this assertion
        // itself will fail below via the picomatch-less naive check.
        const coversTs = include.some(p => p.includes('*.test.ts'))
        const coversTsx = include.some(p => p.includes('*.test.tsx'))

        expect(onDisk.length).toBeGreaterThan(0)
        expect(coversTs).toBe(true)
        expect(coversTsx).toBe(true)
    })
})
