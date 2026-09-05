/**
 * SEAM CONTINUITY — the live window and paged history must together cover the
 * transcript EXACTLY: no hole, no duplicate.
 *
 * ── What was wrong ─────────────────────────────────────────────────────────
 * `excludeRecentCount` is counted by the browser in BUBBLE space, but
 * `pageHistoryRecords` subtracts it from `collapsed.length` — COLLAPSED-RECORD
 * space. Three stages shrink one into the other before the slice:
 * `sanitizeHistoryMessage` drops empty content, `dedupeAdjacentHistoryMessages`
 * merges same-signature neighbours, and `collapseReplayAssistantTurns` drops
 * consecutive prose assistant turns. When N bubbles become M < N records,
 * subtracting N from M overshoots by (N - M) and those messages become
 * PERMANENTLY unreachable — rendered as a silent gap, never as an error.
 *
 * ── Why this test is shaped as a set property ──────────────────────────────
 * The pre-existing pagination test asserts only that the exclude count is
 * FORWARDED. Forwarding was never the bug — the bug is what the count MEANS on
 * the other side, which is invisible unless you reconstruct both windows and
 * compare their union against ground truth. So this test pages to exhaustion and
 * asserts set equality, and it separates the two failure directions:
 *   union SMALLER than ground truth  → a hole (messages nobody can reach)
 *   accumulated MORE than the union  → a duplicate (a message rendered twice)
 * A single "lengths match" assertion would let a hole and a duplicate cancel out.
 *
 * ── The fixture must actually collapse ─────────────────────────────────────
 * ★ A fixture whose collapse is a no-op passes VACUOUSLY, because bubble space
 * and record space coincide and the arithmetic is accidentally right. Every case
 * below is asserted to genuinely shrink (`expect(collapsedCount).toBeLessThan`)
 * before the seam is exercised.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('os', async () => {
    const actual = await vi.importActual<typeof import('os')>('os')
    return { ...actual, default: { ...actual, homedir: () => mockHomeDir }, homedir: () => mockHomeDir }
})

let mockHomeDir = ''

const CANONICAL_HISTORY = {
    format: 'opaque-provider-native-format',
    mode: 'native-source' as const,
    scripts: { readSession: 'readNativeHistory', listSessions: 'listNativeHistory' },
}

/**
 * A transcript with a genuinely collapsing shape: each user turn is followed by
 * TWO consecutive prose assistant turns, so `collapseConsecutiveAssistantTurns`
 * drops the second of each pair. Identity is stamped per record the way a v2
 * producer does (A2.3 passthrough), which is what the cursor resolves against.
 */
function buildNativeRecords(turns: number): Array<Record<string, unknown>> {
    const records: Array<Record<string, unknown>> = []
    let at = 1_800_000_000_000
    for (let turn = 0; turn < turns; turn += 1) {
        const push = (role: string, kind: string, content: string) => {
            at += 1000
            records.push({
                role,
                kind,
                content,
                receivedAt: at,
                ts: new Date(at).toISOString(),
                providerUnitKey: `v3:opaque:native:sess:${role}:${kind}:${content}`,
                sequence: records.length,
            })
        }
        push('user', 'standard', `u${turn}`)
        push('assistant', 'standard', `a${turn}-first`)
        // The second consecutive prose assistant turn — dropped by collapse.
        push('assistant', 'standard', `a${turn}-second`)
    }
    return records
}

function makeScripts(records: Array<Record<string, unknown>>) {
    return {
        readNativeHistory: () => ({
            sourcePath: '/provider/native/session.jsonl',
            sourceMtimeMs: 1_800_000_000_000,
            messages: records,
        }),
        listNativeHistory: () => ({ sessions: [] }),
    }
}

const identityOf = (message: Record<string, unknown>): string => {
    const unit = message.providerUnitKey
    if (typeof unit === 'string' && unit) return `unit:${unit}`
    const bubble = message.bubbleId
    if (typeof bubble === 'string' && bubble) return `bubble:${bubble}`
    const seq = message.sequence
    if (typeof seq === 'number') return `seq:${seq}`
    // Content is the last resort so an identity-less fixture still yields a
    // comparable key — mirrors web-core's content-hash fallback.
    return `content:${String(message.content)}`
}

describe('chat history seam continuity (live window + paged history)', () => {
    beforeEach(() => {
        mockHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seam-continuity-'))
        process.env.ADHDEV_CONFIG_DIR = path.join(mockHomeDir, '.adhdev')
        vi.resetModules()
    })

    afterEach(() => {
        delete process.env.ADHDEV_CONFIG_DIR
        fs.rmSync(mockHomeDir, { recursive: true, force: true })
    })

    for (const collapse of [true, false]) {
        it(`covers the transcript with no hole and no duplicate (collapse=${collapse})`, async () => {
            const { readProviderChatHistory } = await import('../../src/config/chat-history.js')
            const records = buildNativeRecords(12)
            const scripts = makeScripts(records)
            const historyBehavior = { collapseConsecutiveAssistantTurns: collapse }

            const readAll = (options: Record<string, unknown>) => readProviderChatHistory('opaque-cli', {
                canonicalHistory: CANONICAL_HISTORY,
                scripts: scripts as never,
                historySessionId: 'sess',
                workspace: '/w',
                historyBehavior: historyBehavior as never,
                ...options,
            })

            // Ground truth: the whole transcript as the daemon collapses it.
            const groundTruth = readAll({ offset: 0, limit: Number.MAX_SAFE_INTEGER }).messages
            const groundTruthKeys = groundTruth.map(m => identityOf(m as never))
            expect(new Set(groundTruthKeys).size).toBe(groundTruthKeys.length)

            if (collapse) {
                // The fixture must genuinely shrink, or this case proves nothing.
                expect(groundTruth.length).toBeLessThan(records.length)
            } else {
                expect(groundTruth.length).toBe(records.length)
            }

            // The live window: the newest slice, as the browser renders it.
            const LIVE_WINDOW = 7
            const liveWindow = groundTruth.slice(-LIVE_WINDOW)
            const liveKeys = liveWindow.map(m => identityOf(m as never))

            // ★ What the BROWSER actually sends. `excludeRecentCount` is the size
            // of the live window measured in the browser's own BUBBLE space —
            // which, for a collapsing transcript, is LARGER than the number of
            // collapsed records those bubbles correspond to. Passing the already-
            // collapsed count here would hand the daemon the right answer for the
            // wrong reason and make this test vacuous (verified: with the
            // collapsed count, disabling the cursor still passes).
            const bubbleSpaceCount = collapse
                ? records.length - groundTruth.length + LIVE_WINDOW
                : LIVE_WINDOW
            if (collapse) expect(bubbleSpaceCount).toBeGreaterThan(LIVE_WINDOW)

            // Page history to exhaustion, boundary resolved BY IDENTITY.
            const excludeFromIdentity = identityOf(liveWindow[0] as never)
            const historyKeys: string[] = []
            let offset = 0
            for (let guard = 0; guard < 50; guard += 1) {
                const page = readAll({
                    offset,
                    limit: 5,
                    // The RAW bubble count the browser has — it overshoots once
                    // collapse shrinks the set. The cursor must win over it.
                    excludeRecentCount: bubbleSpaceCount,
                    excludeFromIdentity,
                })
                historyKeys.unshift(...page.messages.map(m => identityOf(m as never)))
                offset += page.messages.length
                if (!page.hasMore) break
            }

            const union = new Set([...historyKeys, ...liveKeys])
            const accumulated = historyKeys.length + liveKeys.length

            // (1) NO HOLE — every ground-truth message is reachable from one of
            // the two windows.
            const missing = groundTruthKeys.filter(key => !union.has(key))
            expect(missing, `unreachable messages (silent hole): ${JSON.stringify(missing)}`).toEqual([])

            // (2) NO DUPLICATE — nothing is rendered by both windows. Asserted
            // separately from (1) so a hole and a duplicate cannot cancel out.
            expect(
                accumulated,
                `a message is covered by BOTH the history page and the live window (duplicate render)`,
            ).toBe(union.size)

            // (3) Exact coverage, both directions.
            expect(union.size).toBe(groundTruthKeys.length)
        })
    }

    it('falls back to the count path when the cursor cannot be resolved', async () => {
        const { readProviderChatHistory } = await import('../../src/config/chat-history.js')
        const records = buildNativeRecords(6)
        const scripts = makeScripts(records)

        const base = {
            canonicalHistory: CANONICAL_HISTORY,
            scripts: scripts as never,
            historySessionId: 'sess',
            workspace: '/w',
            offset: 0,
            limit: 5,
            excludeRecentCount: 4,
        }

        // A cursor that matches nothing must not silently resolve to position 0
        // (which would page from the very start of the conversation). It must
        // degrade to exactly what the count path returns.
        const unresolvable = readProviderChatHistory('opaque-cli', {
            ...base,
            excludeFromIdentity: 'unit:does-not-exist',
        } as never)
        const countPath = readProviderChatHistory('opaque-cli', base as never)

        expect(unresolvable.messages.map(m => m.content)).toEqual(countPath.messages.map(m => m.content))
        expect(unresolvable.hasMore).toBe(countPath.hasMore)
    })

    it('resolves the boundary by identity even when the count would overshoot', async () => {
        const { readProviderChatHistory } = await import('../../src/config/chat-history.js')
        const records = buildNativeRecords(8)
        const scripts = makeScripts(records)
        const historyBehavior = { collapseConsecutiveAssistantTurns: true }

        const read = (options: Record<string, unknown>) => readProviderChatHistory('opaque-cli', {
            canonicalHistory: CANONICAL_HISTORY,
            scripts: scripts as never,
            historySessionId: 'sess',
            workspace: '/w',
            historyBehavior: historyBehavior as never,
            ...options,
        } as never)

        const groundTruth = read({ offset: 0, limit: Number.MAX_SAFE_INTEGER }).messages
        const LIVE_WINDOW = 6
        const boundary = groundTruth[groundTruth.length - LIVE_WINDOW]
        const boundaryIdentity = identityOf(boundary as never)

        // The message immediately older than the live window is the one the
        // overshooting count skips. With the cursor it must be the newest row of
        // the first history page.
        const expectedNewestHistory = groundTruth[groundTruth.length - LIVE_WINDOW - 1]

        const page = read({
            offset: 0,
            limit: 5,
            // The raw bubble count, larger than the collapsed live window.
            excludeRecentCount: LIVE_WINDOW * 2,
            excludeFromIdentity: boundaryIdentity,
        })

        expect(page.messages.length).toBeGreaterThan(0)
        expect(page.messages[page.messages.length - 1].content).toBe(expectedNewestHistory.content)
    })
})
