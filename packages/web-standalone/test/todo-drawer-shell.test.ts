import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

// "To do" is a header button + drawer, not a sidebar page (owner decision 2026-10-29).
const layout = readFileSync(join(import.meta.dirname, '../src/StandaloneLayout.tsx'), 'utf8')
const app = readFileSync(join(import.meta.dirname, '../src/App.tsx'), 'utf8')

test('standalone shell has no To do / needs-you sidebar item', () => {
    assert.doesNotMatch(layout, /id:\s*'needs-you'/)
    assert.ok(!layout.includes('nav.needsYou'))
    assert.ok(!layout.includes('useNeedsYouCount'))
})

test('standalone shell mounts the drawer host inside the NeedsYouProvider and keeps the /needs-you redirect route', () => {
    assert.match(app, /<TodoDrawerHost \/>[\s\S]*<\/NeedsYouProvider>/)
    assert.ok(app.includes('path="/needs-you" element={<NeedsYouPage />}'))
})
