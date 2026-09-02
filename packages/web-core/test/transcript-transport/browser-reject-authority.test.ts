// Phase 3 unit ①: the browser can DEFINE `session.<id>.transcript` — a
// content-class, finalityAuthority-naming topic — without holding the fleet
// secret, by supplying non-signing `AuthorityHooks`.
//
// The load-bearing claims under test:
//   ① without hooks, defining the policy throws (the gate is real, not assumed)
//   ② with reject-all hooks, it succeeds (existence is the whole gate)
//   ③ the ring-only interlock throws on any non-ring topic (safety)
//   ④ the browser policy's topicSchemaHash equals the DAEMON's, computed from
//      daemon-core's own `sessionTranscriptPolicy` — if this diverges every
//      daemon peer answers ERR_SCHEMA_MISMATCH and the whole unit is moot.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
// ★ Deliberate deep RELATIVE import of daemon-core SOURCE, test-only. The
// parity claim in ④ is only worth anything if it reads the daemon's actual
// policy rather than a second hand-copy of it — a copy would make the test
// tautological with `topic-addressing.ts`. It is not a package import: adding
// a `./seqscribe/topics` subpath export would put daemon-core's dist on
// web-core's runtime path, which the web bundle must never carry.
import {
    configSettingsPolicy as daemonConfigSettingsPolicy,
    sessionTranscriptPolicy as daemonSessionTranscriptPolicy,
} from '../../../daemon-core/src/seqscribe/topics.js'
import type { SqliteWasmDbLike, TopicPolicy } from 'seqscribe'
import { createSeqscribe, sqliteWasmHandle, topicSchemaHashOf } from 'seqscribe'
import { describe, expect, it } from 'vitest'
import {
    assertRingOnlyPolicy,
    browserRejectAuthority,
    guardRingOnlyDefineTopic,
    isRingOnlyPolicy,
} from '../../src/transcript-transport/browser-reject-authority.js'
import {
    sessionTranscriptPolicy,
    sessionTranscriptTopic,
} from '../../src/transcript-transport/topic-addressing.js'
import { TranscriptWorkerNode, type TranscriptWorkerStorage } from '../../src/transcript-transport/transcript-worker-node.js'

async function memoryStorage(): Promise<TranscriptWorkerStorage> {
    const sqlite3 = await sqlite3InitModule()
    const db = new sqlite3.oo1.DB(':memory:')
    return {
        handle: sqliteWasmHandle(db as unknown as SqliteWasmDbLike),
        dispose(): void {
            db.close()
        },
    }
}

const TOPIC = sessionTranscriptTopic('daemon_abc123')

describe('browserRejectAuthority — defineTopic gate', () => {
    it('① WITHOUT authority hooks, defining the transcript policy throws', async () => {
        const node = new TranscriptWorkerNode({ writerId: 'browser_test_no_auth', openStorage: memoryStorage })
        await node.open()
        try {
            expect(() => node.node.defineTopic(TOPIC, sessionTranscriptPolicy())).toThrow(
                /finalityAuthority/i,
            )
        } finally {
            await node.close()
        }
    })

    it('② WITH reject-all hooks, the same definition succeeds', async () => {
        const node = new TranscriptWorkerNode({
            writerId: 'browser_test_reject_auth',
            openStorage: memoryStorage,
            authority: browserRejectAuthority,
        })
        await node.open()
        try {
            expect(() => node.node.defineTopic(TOPIC, sessionTranscriptPolicy())).not.toThrow()
        } finally {
            await node.close()
        }
    })

    it('carries no signing capability — verifyFinality only, and it always rejects', () => {
        expect(Object.keys(browserRejectAuthority)).toEqual(['verifyFinality'])
        expect(browserRejectAuthority.issueWriterDirective).toBeUndefined()
        expect(browserRejectAuthority.issueTakeover).toBeUndefined()
        // Rejects unconditionally — including a well-formed cert. Safe only
        // because ring topics are finality-exempt (SPEC §7.9); that is what
        // the ring-only interlock below enforces.
        expect(browserRejectAuthority.verifyFinality?.({} as never)).toBe(false)
    })
})

describe('ring-only interlock', () => {
    const fullRetentionContentPolicy: TopicPolicy = {
        kind: 'append',
        retention: { mode: 'full' },
        replication: 'full-sync',
        access: 'content',
        finalityAuthority: 'adhdev-coordinator',
    }

    it('classifies ring vs non-ring retention', () => {
        expect(isRingOnlyPolicy(sessionTranscriptPolicy())).toBe(true)
        expect(isRingOnlyPolicy(fullRetentionContentPolicy)).toBe(false)
        expect(isRingOnlyPolicy(daemonConfigSettingsPolicy() as TopicPolicy)).toBe(false)
    })

    it('assertRingOnlyPolicy passes a ring policy and throws on a full one', () => {
        expect(() => assertRingOnlyPolicy(TOPIC, sessionTranscriptPolicy())).not.toThrow()
        expect(() => assertRingOnlyPolicy('assistant.journal', fullRetentionContentPolicy)).toThrow(
            /refuses to define "assistant\.journal".*not "ring"/s,
        )
    })

    it('③ a node wired with reject-all hooks REFUSES to define a non-ring topic', async () => {
        const node = new TranscriptWorkerNode({
            writerId: 'browser_test_ring_guard',
            openStorage: memoryStorage,
            authority: browserRejectAuthority,
        })
        await node.open()
        try {
            // The ring topic it exists to serve: fine.
            expect(() => node.node.defineTopic(TOPIC, sessionTranscriptPolicy())).not.toThrow()
            // A full-retention content topic: refused BEFORE seqscribe sees it,
            // because reject-all would silently kill its finality.
            expect(() => node.node.defineTopic('assistant.journal', fullRetentionContentPolicy)).toThrow(
                /browserRejectAuthority refuses to define "assistant\.journal"/,
            )
            expect(() =>
                node.node.defineTopic('config.settings', daemonConfigSettingsPolicy() as TopicPolicy),
            ).toThrow(/browserRejectAuthority refuses to define "config\.settings"/)
        } finally {
            await node.close()
        }
    })

    it('the guard proxy leaves every other node method working', async () => {
        const storage = await memoryStorage()
        const raw = createSeqscribe({
            writerId: 'browser_test_proxy',
            storage: storage.handle,
            authority: browserRejectAuthority,
        })
        const guarded = guardRingOnlyDefineTopic(raw)
        try {
            guarded.defineTopic(TOPIC, sessionTranscriptPolicy())
            // Non-defineTopic members must still bind to the real node.
            expect(() => guarded.vectors()).not.toThrow()
            await guarded.log(TOPIC).append('msg', { text: 'hello' })
            expect(guarded.finality(TOPIC)).toBeNull()
        } finally {
            await guarded.close()
            await storage.dispose()
        }
    })
})

describe('④ topicSchemaHash parity with daemon-core', () => {
    it('browser and daemon sessionTranscriptPolicy hash identically', () => {
        const browserHash = topicSchemaHashOf(sessionTranscriptPolicy())
        const daemonHash = topicSchemaHashOf(daemonSessionTranscriptPolicy() as TopicPolicy)
        expect(browserHash).toBe(daemonHash)
    })

    it('the policies are structurally identical, not merely hash-equal', () => {
        expect(sessionTranscriptPolicy()).toEqual(daemonSessionTranscriptPolicy())
    })

    it('dropping finalityAuthority WOULD fork the hash — the reason it stays', () => {
        const withAuthority = sessionTranscriptPolicy()
        const { finalityAuthority: _dropped, ...withoutAuthority } = withAuthority
        expect(topicSchemaHashOf(withoutAuthority as TopicPolicy)).not.toBe(
            topicSchemaHashOf(withAuthority),
        )
    })
})
