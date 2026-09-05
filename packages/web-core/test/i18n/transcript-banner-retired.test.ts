// The "showing latest only" banner (`chatPane.replicaOmittedBefore`) was RETIRED
// as user-facing chrome. This file used to enforce that the banner's prose quoted
// each locale's own "Load older" button label; with the banner gone that coupling
// has no subject, so the file now guards the decision instead of the wording.
//
// ── What replaced it, and why these three axes ──────────────────────────────
// The owner's reasoning for removing the banner rests on one load-bearing fact:
// the "Load older messages" button is ALREADY there, gated independently of the
// discontinuity flag. If that ever stopped being true, removing the banner would
// have deleted the user's only signal that older messages exist — so the button's
// independence is pinned here (axis 2) as the control group, not assumed.
//
// The detection itself was not deleted, only moved off-screen, so axis 3 pins
// that it still reaches the developer surface.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SUPPORTED_LANGUAGES } from '../../src/i18n/languages'
import { buildTranscriptReadSourceAttributes } from '../../src/components/dashboard/transcript-chat-pane-adapter'

const LOCALES = [...SUPPORTED_LANGUAGES]

async function loadCommon(locale: string): Promise<Record<string, Record<string, string>>> {
    return (await import(`../../src/i18n/locales/${locale}/common.json`)).default
}

function readSource(relativePath: string): string {
    return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

describe('the omitted-before banner stays retired', () => {
    // ── Axis 1: the banner is gone from every locale AND from the pane ──────
    // Both halves matter: deleting only the string would leave `t()` rendering a
    // raw key, and deleting only the JSX would leave five dead translations to
    // be "helpfully" re-wired by a later change.
    for (const locale of LOCALES) {
        it(`${locale}: no longer ships a replicaOmittedBefore string`, async () => {
            const common = await loadCommon(locale)
            expect(common.chatPane).toBeDefined()
            expect(common.chatPane.replicaOmittedBefore).toBeUndefined()
        })
    }

    it('ChatPane renders no banner for the discontinuity flag', () => {
        const chatPane = readSource('../../src/components/dashboard/ChatPane.tsx')
        expect(chatPane).not.toContain('replicaOmittedBefore')
        // The flag must not regain a JSX render gate. Prose in comments is fine
        // — an actual `{chatTailState.omittedBefore && (` render is not.
        expect(chatPane).not.toMatch(/\{\s*chatTailState\.omittedBefore\s*&&/)
    })

    // ── Axis 2 (the control group) ─────────────────────────────────────────
    // The whole decision rests on "Load older" remaining reachable. Its gate is
    // `(hiddenLiveCount > 0 || hasMoreHistory) && !isLoadingMore` — no term
    // referencing the replica discontinuity. Pinned by source inspection because
    // the property under test is the ABSENCE of a coupling, which a render test
    // cannot demonstrate: passing it omittedBefore proves one case, not that no
    // path exists.
    it('the "Load older" affordance stays independent of omittedBefore', () => {
        const list = readSource('../../src/components/ChatMessageList.tsx')
        expect(list).toContain('const hasMoreVisibleContent = hiddenLiveCount > 0 || !!hasMoreHistory;')
        expect(list).toContain('{hasMoreVisibleContent && !isLoadingMore && (')
        // If the button ever starts consulting the flag, the removed banner is
        // no longer redundant and this decision must be revisited.
        expect(list).not.toContain('omittedBefore')
    })

    it('every locale still labels the "Load older" control the banner used to name', async () => {
        for (const locale of LOCALES) {
            const common = await loadCommon(locale)
            expect(common.chatList.loadOlderMessages.replace(/^[↑\s]+/, '').trim().length).toBeGreaterThan(0)
        }
    })

    // ── Axis 3: the signal survives on the developer surface ───────────────
    it('exposes the discontinuity as a data attribute instead', () => {
        const armed = buildTranscriptReadSourceAttributes({
            transcriptReadSource: 'replica',
            omittedBefore: true,
        })
        expect(armed['data-transcript-omitted-before']).toBe('true')

        // Omitted rather than "false": absence is meaningful here, matching the
        // sibling `stale`/`fallbackReason` attributes.
        const clean = buildTranscriptReadSourceAttributes({
            transcriptReadSource: 'replica',
            omittedBefore: false,
        })
        expect(clean).not.toHaveProperty('data-transcript-omitted-before')
        expect(buildTranscriptReadSourceAttributes({ transcriptReadSource: 'legacy' }))
            .not.toHaveProperty('data-transcript-omitted-before')
    })
})
