/**
 * D1#6 — standalone's root render must be wrapped in an ErrorBoundary.
 *
 * web-cloud's main.tsx has had this guard all along; standalone did not. Without
 * it a render-time exception anywhere in the tree unmounts everything and the
 * user gets a blank white page with nothing but a console trace — on the surface
 * that has no remote dashboard to fall back to.
 *
 * This is a source guard rather than a render test because main.tsx is the
 * composition root: it calls createRoot against a real document on import, so it
 * cannot be imported under node:test. The parity assertion against web-cloud is
 * the point — the two roots should not drift apart again.
 */
import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function readSource(relativePath: string): string {
    return fs.readFileSync(path.resolve(packageRoot, relativePath), 'utf8')
}

test('standalone root render is wrapped in the shared ErrorBoundary', () => {
    const main = readSource('src/main.tsx')

    assert.match(
        main,
        /import\s*\{[^}]*\bErrorBoundary\b[^}]*\}\s*from\s*'@adhdev\/web-core'/,
        'main.tsx must import ErrorBoundary from the shared web-core package',
    )
    // The boundary must actually enclose the app, not merely be imported.
    assert.match(
        main,
        /<ErrorBoundary>\s*<StandaloneApp\s*\/>\s*<\/ErrorBoundary>/,
        'StandaloneApp must be rendered inside <ErrorBoundary>',
    )
})

test('standalone and cloud roots both guard their render', () => {
    const standaloneMain = readSource('src/main.tsx')
    // web-cloud is proprietary and absent from the OSS-only checkout, so treat it
    // as an optional parity check rather than a hard dependency.
    const cloudMain = path.resolve(packageRoot, '../../../packages/web-cloud/src/main.tsx')
    if (!fs.existsSync(cloudMain)) return

    for (const source of [standaloneMain, fs.readFileSync(cloudMain, 'utf8')]) {
        assert.ok(source.includes('<ErrorBoundary>'), 'every dashboard root must mount an ErrorBoundary')
    }
})
