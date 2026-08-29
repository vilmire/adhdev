// Worker-transport-foundation criterion 3 (design §3.6): "main-thread bridge에
// JSON.parse/topic routing/content inspection 호출이 0임을 구조 test와 content
// canary로 고정한다." This is the structural half of that: a source scan of
// `main-thread-bridge.ts` that fails the suite the moment anyone adds content
// parsing to the main-thread path — the file cannot legitimately need it
// (design comment on that file explains why), so an addition here is exactly
// the class of regression this test exists to catch.
//
// This complements (does not replace) the behavioral canary in
// `main-thread-bridge.test.ts`, which proves garbage/opaque strings still
// forward untouched.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const BRIDGE_PATH = fileURLToPath(new URL('../../src/transcript-transport/main-thread-bridge.ts', import.meta.url))

/** Strips `//` and `/* *\/` comments — documentation prose may legitimately
 * discuss topics/sessions/revisions when explaining WHY the code doesn't; only
 * the executable code itself must never reference that vocabulary. */
function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

describe('main-thread-bridge content-parsing canary', () => {
    it('never calls JSON.parse or JSON.stringify', () => {
        const code = stripComments(readFileSync(BRIDGE_PATH, 'utf8'))
        expect(code).not.toContain('JSON.parse')
        expect(code).not.toContain('JSON.stringify')
    })

    it('the executable code never references seqscribe topic/session/content vocabulary', () => {
        const code = stripComments(readFileSync(BRIDGE_PATH, 'utf8')).toLowerCase()
        const forbidden = ['sessionid', 'topic', 'snapshot', 'revision', 'messages']
        for (const word of forbidden) {
            expect(code).not.toContain(word)
        }
    })
})
