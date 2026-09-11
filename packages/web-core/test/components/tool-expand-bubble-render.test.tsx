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
        expect(html).toContain('no longer available')
        // The summary is still shown; the reader is not left with a blank bubble.
        expect(html).toContain('src/a.ts')
    })
})
