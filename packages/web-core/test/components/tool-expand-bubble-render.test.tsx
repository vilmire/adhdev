// @vitest-environment jsdom
/**
 * (TOOL-EXPAND) The expand affordance on a truncated tool bubble.
 *
 * ★ Why the affordance lives in `ChatMessageRow`: every layout — desktop
 * dockview, mobile pane workspace, mobile chat room, remote dialog, standalone
 * and cloud — funnels through ChatPane → ChatMessageList → ChatMessageRow, so
 * placing it here gives them all the feature at once (same reasoning as
 * SEND-NOW; see send-now-bubble-render.test.tsx).
 *
 * ★ The non-obvious case is the REFUSAL. When the daemon answers
 * `source_changed` — the transcript moved under the ref — the UI must say the
 * output is gone rather than render an empty expansion. An empty box would read
 * as "the tool printed nothing", which is a different and false claim.
 */
import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatMessageRow } from '../../src/components/ChatMessageList/chatMessageBubbles'

const REF = { sourceMtimeMs: 1_700_000_000_000, recordIndex: 4, blockIndex: 1 }

function toolBubble(extra: Record<string, unknown> = {}) {
    return {
        role: 'assistant',
        kind: 'tool',
        content: '↘ src/a.ts src/b.ts src/c.ts…',
        receivedAt: 1_700_000_000_000,
        ...extra,
    } as any
}

function render(message: any, extra: Record<string, unknown> = {}) {
    return renderToStaticMarkup(
        React.createElement(ChatMessageRow, {
            message,
            receivedAt: 1_700_000_000_000,
            agentName: 'Claude',
            userName: 'You',
            isCliMode: false,
            isTextExpanded: false,
            onToggleTextExpanded: () => {},
            ...extra,
        } as any),
    )
}

describe('TOOL-EXPAND bubble affordance', () => {
    it('★ offers expansion on a bubble the parser truncated (it carries a ref)', () => {
        const html = render(toolBubble({ toolBlockRef: REF }), { onExpandToolBlock: vi.fn() })
        expect(html).toContain('Show full output')
    })

    it('offers NOTHING on a bubble with no ref — it is already complete', () => {
        // The parser attaches a ref only when the cap actually bit, so "no ref"
        // means expanding would return the same string.
        const html = render(toolBubble(), { onExpandToolBlock: vi.fn() })
        expect(html).toContain('src/a.ts')
        expect(html).not.toContain('Show full output')
    })

    it('folds a long plaintext native-turn body (no ref) and offers local expand', () => {
        const long = `↘ ${'workspace file path segment '.repeat(40)}TAIL_MARKER`
        const html = render(toolBubble({ content: long }))
        expect(html).toContain('chat-msg-tool')
        expect(html).toContain('Show full output')
        expect(html).not.toContain('TAIL_MARKER')
    })

    it('reveals the full plaintext body once locally expanded', () => {
        const long = `↘ ${'workspace file path segment '.repeat(40)}TAIL_MARKER`
        const html = render(toolBubble({ content: long }), { isTextExpanded: true })
        expect(html).toContain('TAIL_MARKER')
        expect(html).toContain('Show less')
    })

    it('offers nothing to a read-only host that passes no handler', () => {
        // SessionShare renders rows with no command surface; it must still render.
        const html = render(toolBubble({ toolBlockRef: REF }))
        expect(html).not.toContain('Show full output')
    })

    it('shows the untruncated body and a collapse control once expanded', () => {
        const full = Array.from({ length: 50 }, (_, i) => `src/module-${i}/index.ts`).join('\n')
        const html = render(toolBubble({ toolBlockRef: REF }), {
            onExpandToolBlock: vi.fn(),
            onCollapseToolBlock: vi.fn(),
            toolExpand: { status: 'expanded', text: full },
        })
        // The full body replaced the summary, including content past the cap.
        expect(html).toContain('src/module-49/index.ts')
        expect(html).not.toContain('src/a.ts src/b.ts')
        expect(html).toContain('Show less')
    })

    it('shows a loading state while the fetch is in flight', () => {
        const html = render(toolBubble({ toolBlockRef: REF }), {
            onExpandToolBlock: vi.fn(),
            toolExpand: { status: 'loading' },
        })
        expect(html).toContain('Loading')
        expect(html).not.toContain('Show full output')
    })

    it('★ states the output is unavailable when the daemon refused — never an empty expansion', () => {
        const html = render(toolBubble({ toolBlockRef: REF }), {
            onExpandToolBlock: vi.fn(),
            toolExpand: { status: 'error' },
        })
        expect(html).toContain('could not be fetched')
        // The summary is still shown; the reader is not left with a blank bubble.
        expect(html).toContain('src/a.ts')
    })
})

/**
 * (A#3) The refusal reason reaches the copy.
 *
 * ★ The defect this pins: `ToolExpandState.error` existed and was documented as
 * a "typed refusal carry", but nothing wrote it and nothing read it, so all
 * FIVE daemon reasons rendered the single sentence "the transcript has changed
 * since this was read". For four of them that sentence is simply false — an
 * adapter that cannot expand at all, or a ref that names no tool block, did not
 * change under anyone — and it sent the reader to a reload that cannot help.
 *
 * The split is deliberately two-way, not five-way: what the reader can act on
 * is "stale → reload" vs "cannot be fetched", and five near-identical sentences
 * would be five translation liabilities for no added decision.
 */
describe('(A#3) TOOL-EXPAND refusal reason branches the copy', () => {
    const STALE = 'transcript changed'
    const GENERIC = 'could not be fetched'

    function renderRefusal(reason?: string) {
        return render(toolBubble({ toolBlockRef: REF }), {
            onExpandToolBlock: vi.fn(),
            toolExpand: { status: 'error', ...(reason ? { error: reason } : {}) },
        })
    }

    it('★ source_changed says the transcript moved and a reload can fetch it', () => {
        const html = renderRefusal('source_changed')
        expect(html).toContain(STALE)
        expect(html).not.toContain(GENERIC)
    })

    // The four non-stale reasons. Reloading changes nothing for any of them, so
    // none may claim the transcript changed.
    for (const reason of [
        'unsupported_source',
        'source_unavailable',
        'block_not_found',
        'not_a_tool_block',
    ]) {
        it(`★ ${reason} says it could not be fetched — never "the transcript changed"`, () => {
            const html = renderRefusal(reason)
            expect(html).toContain(GENERIC)
            expect(html).not.toContain(STALE)
        })
    }

    it('an unknown or absent reason falls back to the generic branch', () => {
        // A daemon older than the typed reply, or a transport-level throw, has
        // no reason to give. Claiming staleness there would be a guess.
        expect(renderRefusal()).toContain(GENERIC)
        expect(renderRefusal('something_new_upstream')).toContain(GENERIC)
        expect(renderRefusal('something_new_upstream')).not.toContain(STALE)
    })

    it('exposes the reason as a data attribute for support triage', () => {
        // Content-free (closed enum), so it is safe to put in the DOM and makes
        // "I clicked expand and it said no" answerable from a screenshot.
        expect(renderRefusal('block_not_found')).toContain('data-expand-error-reason="block_not_found"')
        expect(renderRefusal()).toContain('data-expand-error-reason="unknown"')
    })
})
