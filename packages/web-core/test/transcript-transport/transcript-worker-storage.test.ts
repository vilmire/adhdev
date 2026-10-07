// `openTranscriptWorkerStorage` — the OPFS SAH pool is exclusive per directory,
// so a second dashboard tab cannot install it. The worker must then fall back
// to an in-memory replica instead of never opening its node (which left the
// lane HELLO-less, `hello_timeout`, and every chat pane empty). Real
// sqlite-wasm engine; only the OPFS install is simulated (browser-only — the
// real two-worker case is `test-browser/transcript-transport/
// transcript-worker-entry-second-tab.browser.test.ts`).
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { describe, expect, it } from 'vitest'
import {
    openTranscriptWorkerStorage,
    type TranscriptSqliteModuleLike,
} from '../../src/transcript-transport/transcript-worker-storage.js'
import { TranscriptWorkerNode } from '../../src/transcript-transport/transcript-worker-node.js'

async function moduleWithPool(install: TranscriptSqliteModuleLike['installOpfsSAHPoolVfs']): Promise<{
    module: TranscriptSqliteModuleLike
    installs: Array<{ directory: string; clearOnInit: boolean }>
}> {
    const sqlite3 = await sqlite3InitModule()
    const installs: Array<{ directory: string; clearOnInit: boolean }> = []
    return {
        installs,
        module: {
            oo1: sqlite3.oo1 as unknown as TranscriptSqliteModuleLike['oo1'],
            installOpfsSAHPoolVfs: (options) => {
                installs.push(options)
                return install(options)
            },
        },
    }
}

function heldPoolError(): Error {
    const error = new Error(
        "Failed to execute 'createSyncAccessHandle' on 'FileSystemFileHandle': Access Handles cannot be created if there is another open Access Handle or Writable stream associated with the same file.",
    )
    error.name = 'NoModificationAllowedError'
    return error
}

describe('openTranscriptWorkerStorage', () => {
    it('uses the OPFS pool when it can be installed', async () => {
        const opened: string[] = []
        const sqlite3 = await sqlite3InitModule()
        const { module, installs } = await moduleWithPool(async () => ({
            // Stand-in for the pool's db class: a real oo1.DB, recording the filename.
            OpfsSAHPoolDb: class extends (sqlite3.oo1.DB as unknown as new (filename: string) => { close(): void }) {
                constructor(filename: string) {
                    opened.push(filename)
                    super(':memory:')
                }
            },
        }))
        const storage = await openTranscriptWorkerStorage(module, { directory: '.adhdev-transcript/w', filename: 'transcript.sqlite3' })
        expect(storage.kind).toBe('opfs')
        expect(installs).toEqual([{ directory: '.adhdev-transcript/w', clearOnInit: false }])
        expect(opened).toEqual(['transcript.sqlite3'])
        await storage.dispose()
    })

    it('falls back to an in-memory replica when another tab holds the pool, and the node opens on it', async () => {
        const held = heldPoolError()
        const { module } = await moduleWithPool(async () => {
            throw held
        })
        const storage = await openTranscriptWorkerStorage(module, { directory: '.adhdev-transcript/w', filename: 'transcript.sqlite3' })
        expect(storage.kind).toBe('memory')
        expect(storage.opfsError).toBe(held)

        // The fallback is a real, usable seqscribe store — not just a non-throw.
        const node = new TranscriptWorkerNode({ writerId: 'second_tab', openStorage: () => storage })
        await node.open()
        expect(node.stats().open).toBe(true)
        await node.close()
    })

    it('falls back when the pool installs but the database file cannot be opened', async () => {
        const held = heldPoolError()
        const { module } = await moduleWithPool(async () => ({
            OpfsSAHPoolDb: class {
                constructor() {
                    throw held
                }
                close(): void {}
            },
        }))
        const storage = await openTranscriptWorkerStorage(module, { directory: 'd', filename: 'f' })
        expect(storage.kind).toBe('memory')
        expect(storage.opfsError).toBe(held)
        await storage.dispose()
    })
})
