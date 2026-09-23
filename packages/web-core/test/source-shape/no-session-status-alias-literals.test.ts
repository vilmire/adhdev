/**
 * Source-shape guard: no session-status ALIAS literal is compared against a
 * `.status` field anywhere in web-core/src (wiring-unification A1 follow-up).
 *
 * Filesystem walk over `src/` (NOT `git grep` — CLAUDE.md: `git grep` does
 * not descend into the `oss/` submodule and silently undercounts; a plain
 * recursive fs walk has no such blind spot here since web-core/src is not
 * itself a submodule boundary).
 *
 * Every ingestion point (status-transform.ts, BaseDaemonContext.tsx) now
 * normalizes a raw daemon status onto mesh-shared's canonical SessionStatus
 * vocabulary before it reaches any component or hook. A `.status === 'streaming'`
 * (or any other SESSION_STATUS_ALIASES key) comparison downstream of that
 * point can therefore never match — it is either dead code or, worse, a sign
 * that a NEW ingestion point was added without normalization. This guard
 * fails the build the moment such a comparison reappears, rather than relying
 * on someone noticing dead code in review.
 *
 * Deliberately narrow: it flags `<expr>.status === '<alias>'` /
 * `'<alias>' === <expr>.status` /  `<expr>.status === "<alias>"` patterns
 * only. It does NOT flag:
 *   - the alias table itself (mesh-shared/src/session-status.ts is out of
 *     web-core/src)
 *   - unrelated `.status` domains (mesh mission/refine-job status, billing
 *     subscription status, tool-expand loading state) — these use the same
 *     words but are a genuinely different vocabulary from SessionStatus, so
 *     the guard scopes to the alias table's exact keys, not generic English
 *     words like 'active'/'loading' that collide with other status enums.
 *   - `no_progress` / `long_generating` — these ARE alias-table entries (both
 *     fold onto 'generating'), but the UI deliberately keeps comparing them
 *     as literals (see ChatPane.tsx buildBusyChatInputStatusMessage): they
 *     are status-LANE refinements of an in-progress turn that the daemon
 *     still emits post-normalization (the alias table folds them for
 *     CLASSIFICATION purposes — isBusyStatus/isWorkingStatus — while the raw
 *     spelling survives on the wire for UI that wants the finer distinction,
 *     e.g. "still working, no progress" vs. "generating"). Collapsing them
 *     would be a real behavior regression, not a cleanup.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SESSION_STATUS_ALIASES } from '@adhdev/mesh-shared'

const here = dirname(fileURLToPath(import.meta.url))
const SRC_ROOT = join(here, '..', '..', 'src')

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        const stat = statSync(full)
        if (stat.isDirectory()) {
            walk(full, out)
        } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx')) {
            out.push(full)
        }
    }
    return out
}

// Alias spellings excluded from this guard, and why:
//
//   - 'no_progress' / 'long_generating': DELIBERATELY preserved raw on the
//     wire by session-status-ingest.ts's normalizeIncomingSessionStatus (see
//     that file's module doc) — a CURRENT daemon still emits them as a
//     status-lane refinement distinct from plain 'generating', and
//     ChatPane.buildBusyChatInputStatusMessage intentionally branches on
//     them for a different message. Flagging them here would fight a kept
//     behavior, not catch dead code.
//   - 'busy' / 'working' / 'active' / 'loading' / 'waiting' / 'thinking' /
//     'running' / 'initializing': also collide with unrelated, legitimate
//     vocabularies elsewhere in web-core (mesh refine-job status, billing
//     subscription status, generic UI loading state, session-host
//     lifecycle). Scoping the guard to the FULL alias list would produce
//     false positives on those domains, so it is narrowed to the aliases
//     that are NOT common English words reused elsewhere for other status
//     enums. Every one of the 4 originally-flagged sites (ChatPane.tsx x2,
//     ControlsBar.tsx, git-system-bubbles.ts) used 'streaming', which IS
//     unique to the session-status vocabulary in this codebase.
const EXCLUDED_ALIASES = new Set([
    'no_progress',
    'long_generating',
    'busy',
    'working',
    'active',
    'loading',
    'waiting',
    'thinking',
    'running',
    'initializing',
])
const CHECKED_ALIASES = Object.keys(SESSION_STATUS_ALIASES).filter((alias) => !EXCLUDED_ALIASES.has(alias))

describe('no session-status alias literal is compared against .status in web-core/src', () => {
    it('scans every non-test .ts/.tsx file under src/', () => {
        const files = walk(SRC_ROOT)
        expect(files.length).toBeGreaterThan(50)

        const offenders: string[] = []
        for (const file of files) {
            const text = readFileSync(file, 'utf8')
            for (const alias of CHECKED_ALIASES) {
                const patterns = [
                    new RegExp(`\\.status\\s*===\\s*'${alias}'`),
                    new RegExp(`\\.status\\s*===\\s*"${alias}"`),
                    new RegExp(`'${alias}'\\s*===\\s*[\\w.]+\\.status`),
                    new RegExp(`"${alias}"\\s*===\\s*[\\w.]+\\.status`),
                ]
                for (const pattern of patterns) {
                    if (pattern.test(text)) {
                        offenders.push(`${file.replace(SRC_ROOT, 'src')}: alias '${alias}'`)
                    }
                }
            }
        }

        expect(offenders).toEqual([])
    })

    it('SESSION_STATUS_ALIASES still contains the well-known aliases this guard depends on (canary)', () => {
        // If mesh-shared ever renames/removes 'streaming' the guard above would
        // silently stop checking it — this pins the assumption.
        expect(SESSION_STATUS_ALIASES.streaming).toBe('generating')
        expect(SESSION_STATUS_ALIASES.initializing).toBe('starting')
        expect(SESSION_STATUS_ALIASES.waiting).toBe('waiting_approval')
    })
})
