import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import config from '../vite.config'

function aliasEntries() {
    const aliases = config.resolve?.alias
    return Array.isArray(aliases) ? aliases : []
}

test('standalone vite resolves @adhdev/web-core to the local worktree source tree', () => {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const webCoreRoot = path.resolve(packageRoot, '../web-core')
    const workspaceRoot = path.resolve(packageRoot, '../..')
    const entries = aliasEntries()

    assert.deepEqual(
        entries.map(entry => String(entry.find)),
        [
            '/^@adhdev\\/web-core$/',
            '/^@adhdev\\/web-core\\/index\\.css$/',
            '/^@adhdev\\/web-core\\/constants\\/supported$/',
        ],
    )

    assert.equal(entries[0]?.replacement, path.join(webCoreRoot, 'src/index.ts'))
    assert.equal(entries[1]?.replacement, path.join(webCoreRoot, 'src/index.css'))
    assert.equal(entries[2]?.replacement, path.join(webCoreRoot, 'src/constants/supported.ts'))
    assert.deepEqual(config.server?.fs?.allow, [workspaceRoot, webCoreRoot])
})