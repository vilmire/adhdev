// The "showing latest only" banner (`chatPane.replicaOmittedBefore`) NAMES the
// control that recovers the older messages, quoting each locale's own
// `chatList.loadOlderMessages` label. That makes the two strings coupled: rename
// the button in one locale and the banner in that locale starts pointing at a
// control the user cannot find — silently, and only for that language's users.
//
// Nothing else enforces the coupling. i18n values are plain JSON with no
// key-parity or cross-reference gate (`languages.test.ts` covers language CODES
// only), so this file is the enforcement.
//
// ── Why substring-of-the-label, not a literal full-string compare ───────────
// The banner wraps the label in each language's native quotation marks — '…'
// (ko), 「…」 (ja), «…» (es), “…” (zh-CN), "…" (en). Asserting the quoted form
// would encode typography this test has no opinion about, and would fail on a
// purely cosmetic quote-style edit that breaks nothing for the user. So the
// assertion is: the banner CONTAINS the label's own text. That is exactly the
// property that has to hold — the words the user reads in the banner must be
// the words printed on the button — and nothing more.
//
// The button's label carries a leading "↑ " affordance arrow that belongs to the
// button, not to prose, so it is stripped before the containment check.
import { describe, expect, it } from 'vitest'
import { SUPPORTED_LANGUAGES } from '../../src/i18n/languages'

// Driven off SUPPORTED_LANGUAGES rather than a hand-listed array so a sixth
// locale is covered the day it is added, instead of being silently skipped.
const LOCALES = [...SUPPORTED_LANGUAGES]

async function loadCommon(locale: string): Promise<Record<string, Record<string, string>>> {
    return (await import(`../../src/i18n/locales/${locale}/common.json`)).default
}

/** The button's visible words, minus the "↑ " arrow the button owns. */
function loadOlderLabelText(common: Record<string, Record<string, string>>): string {
    return common.chatList.loadOlderMessages.replace(/^[↑\s]+/, '').trim()
}

describe('transcript banner points at a real affordance', () => {
    // Per-locale cases (not one loop with a combined assertion) so a failure
    // names the broken language instead of just "one of five".
    for (const locale of LOCALES) {
        it(`${locale}: the omitted-before banner quotes this locale's own "Load older" label`, async () => {
            const common = await loadCommon(locale)
            const banner = common.chatPane.replicaOmittedBefore
            const label = loadOlderLabelText(common)

            expect(label.length).toBeGreaterThan(0)
            // The coupling under test: rename the button and this goes red for
            // THIS locale only.
            expect(banner).toContain(label)
        })
    }

    it('never tells the user to scroll — the control is a button', async () => {
        // ChatMessageList.tsx:512-526 renders "Load older" as an explicit button;
        // the scroll handler (:391-402) only tracks position for the jump button
        // and never pages history. A "scroll up" phrasing would be a dead end,
        // and it was the first wording proposed for this banner — so it is
        // pinned here rather than left to review.
        const scrollWords = [/scroll/i, /스크롤/, /スクロール/, /desplaz/i, /滚动/, /滚屏/]
        for (const locale of LOCALES) {
            const banner = (await loadCommon(locale)).chatPane.replicaOmittedBefore
            for (const word of scrollWords) {
                expect(banner, `${locale} banner must not instruct scrolling`).not.toMatch(word)
            }
        }
    })
})
