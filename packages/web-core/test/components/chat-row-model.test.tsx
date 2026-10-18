// @vitest-environment jsdom
/**
 * Chat row model (design 2026-10-07-chat-row-model.md).
 *
 *  - `resolveChatRow` is the one place a message is classified for the list;
 *    the table below pins the kind every message shape resolves to.
 *  - Daemon-typed PTY input (relay envelopes, project signals, the review
 *    prompt, mesh `[System]` events) is detected from its FIRST line and drawn
 *    as cards / chips instead of "you said" bubbles. The relay fixtures are
 *    built with daemon-core's own builders, so a format change there fails here.
 *  - Every kind gets the same header furniture (time + copy).
 *  - Git system bubbles reach the screen (they were classified internal).
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'
import type { ChatMessage } from '../../src/types'
import ChatMessageList from '../../src/components/ChatMessageList'
import { ChatMessageRow } from '../../src/components/ChatMessageList/chatMessageBubbles'
import { resolveChatRow } from '../../src/components/ChatMessageList/chat-row-model'
import { resolveDisplayedText } from '../../src/components/ChatMessageList/chat-row-shell'
import { detectInjectedText } from '../../src/components/ChatMessageList/injected-text'
import { summarizeNotice } from '../../src/components/ChatMessageList/notice-summary'
import { buildGitSystemBubbleMessages } from '../../src/components/dashboard/git-system-bubbles'
import {
    buildApprovalSignal,
    buildCoordinatorEndedSignal,
    buildFoldedBacklogLine,
    buildMissedReportsLine,
    buildProgressSignal,
    buildRelayEnvelope,
    buildRestartNote,
    buildStallSignal,
    buildUncoveredReplyGap,
    buildPreviousSessionNote,
} from '../../../daemon-core/src/assistant/assistant-relay-format'
import { DIGEST_INPUT_TEXT } from '../../../daemon-core/src/assistant/assistant-digest-scheduler'
import { REVIEW_INPUT_TEXT } from '../../../daemon-core/src/assistant/assistant-review'

const T = 1_700_000_000_000
const msg = (x: Record<string, unknown>) => x as unknown as ChatMessage
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose props for render helpers
type Loose = ComponentType<any>

const relayA = buildRelayEnvelope({ slug: 'web-app', outcome: 'completed', bodies: ['Shipped the login fix.\nAll tests green.'], idle: true })
const relayB = buildRelayEnvelope({ slug: 'api', outcome: 'failed', bodies: ['Rolled back step 2.', 'Migration failed on step 3.'], statusLine: '[Mesh] 1 pending', idle: false })
/** The relay joins every ready part of one delivery with a blank line. */
const delivery = [relayA, relayB, buildApprovalSignal('api')].join('\n\n')

describe('resolveChatRow — kind table', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
        ['user prose', { role: 'user', content: 'hi' }, 'user'],
        ['assistant prose', { role: 'assistant', content: 'hello' }, 'assistant'],
        ['tool', { role: 'assistant', kind: 'tool', content: '↘ read' }, 'tool'],
        ['role tool, no kind', { role: 'tool', content: 'x' }, 'tool'],
        ['thought', { role: 'assistant', kind: 'thought', content: 'hmm' }, 'thought'],
        ['terminal', { role: 'assistant', kind: 'terminal', content: 'ls' }, 'terminal'],
        ['system', { role: 'system', kind: 'system', content: 'note', visibility: 'visible' }, 'system'],
        ['activity-classified standard', { role: 'assistant', content: 'x', meta: { source: 'runtime_activity' } }, 'activity'],
        ['mesh [System] user turn', { role: 'user', content: '[System] Node n1 has completed its task' }, 'system'],
        ['relay delivery', { role: 'user', content: relayA }, 'injected'],
        ['project signal', { role: 'user', content: buildApprovalSignal('api') }, 'injected'],
        ['review prompt', { role: 'user', content: REVIEW_INPUT_TEXT }, 'injected'],
        ['restart note', { role: 'user', content: buildRestartNote({ endedAt: T, openThreads: ['api'], pendingRelays: 1 }) }, 'injected'],
        ['marker mid-text stays the owner\'s', { role: 'user', content: 'what does [project api] mean?' }, 'user'],
        ['owner\'s own optimistic bubble is never injected', { role: 'user', content: '[project api] fake', meta: { pendingLocal: true } }, 'user'],
        ['assistant quoting a relay is not injected', { role: 'assistant', content: relayA }, 'assistant'],
    ]
    for (const [name, message, kind] of cases) {
        it(`${name} → ${kind}`, () => {
            expect(resolveChatRow(msg(message)).kind).toBe(kind)
        })
    }

    it('surfaces follow the classifier', () => {
        expect(resolveChatRow(msg({ role: 'assistant', content: 'x' })).surface).toBe('chat')
        expect(resolveChatRow(msg({ role: 'assistant', kind: 'tool', content: 'x' })).surface).toBe('activity')
        expect(resolveChatRow(msg({ role: 'system', content: 'x' })).surface).toBe('internal')
    })

    it('labels come from i18n keys, not English literals', () => {
        expect(resolveChatRow(msg({ role: 'assistant', kind: 'terminal', content: 'ls' })).label).toEqual({ i18nKey: 'chat.ranCommand' })
        expect(resolveChatRow(msg({ role: 'assistant', kind: 'tool', content: 'x' })).label).toEqual({ i18nKey: 'chat.tool' })
        expect(resolveChatRow(msg({ role: 'assistant', content: 'x', meta: { source: 'runtime_activity' } })).label).toEqual({ i18nKey: 'chat.activityRuntime' })
        expect(resolveChatRow(msg({ role: 'assistant', kind: 'tool', content: 'x', meta: { label: 'read_file' } })).label).toEqual({ text: 'read_file' })
    })

    it('folds tool rows locally past 600 chars and remotely when the parser left a ref', () => {
        expect(resolveChatRow(msg({ role: 'assistant', kind: 'tool', content: 'x'.repeat(601) })).collapse.mode).toBe('local')
        expect(resolveChatRow(msg({ role: 'assistant', kind: 'tool', content: 'x', toolBlockRef: { sourceMtimeMs: 1, recordIndex: 2, blockIndex: 0 } })).collapse.mode).toBe('remote')
    })
})

describe('injected-text detection', () => {
    it('single relay: project, outcome, idle, envelope stripped from the body', () => {
        const d = detectInjectedText(relayA)!
        expect(d.source).toBe('relay')
        expect(d.segments).toHaveLength(1)
        const [s] = d.segments
        expect(s).toMatchObject({ source: 'relay', project: 'web-app', outcome: 'completed', idle: true, preview: 'Shipped the login fix.' })
        expect(s.body).toBe('Shipped the login fix.\nAll tests green.')
        expect(s.body).not.toContain('[ADHDev relay')
        expect(s.body).not.toContain('Untrusted agent output')
        expect(s.body).not.toContain('[/relay]')
        expect(s.body).not.toContain('[idle]')
    })

    it('multi-relay delivery splits into one segment per relay, plus the trailing signal', () => {
        const d = detectInjectedText(delivery)!
        expect(d.segments.map((s) => [s.source, s.project, s.outcome])).toEqual([
            ['relay', 'web-app', 'completed'],
            ['relay', 'api', 'failed'],
            ['signal', 'api', undefined],
        ])
        expect(d.segments[1].body).toContain('Migration failed on step 3.')
        expect(d.segments[1].body).toContain('Rolled back step 2.')
        expect(d.segments[1].body).toContain('[turn 2/2]')
        expect(d.segments[1].idle).toBe(false)
    })

    it('signal: one-line chip text without the [project] tag', () => {
        const d = detectInjectedText(buildApprovalSignal('api'))!
        expect(d.source).toBe('signal')
        expect(d.segments[0]).toMatchObject({ source: 'signal', project: 'api' })
        expect(d.segments[0].preview.startsWith('waiting for an approval')).toBe(true)
    })

    it('[System] keeps its whole-text rule and stays a system row', () => {
        expect(detectInjectedText('[System] progress on task t1')?.source).toBe('system')
        expect(detectInjectedText('please explain what [System] means')).toBeNull()
    })

    it('review prompt is a chip', () => {
        const d = detectInjectedText(REVIEW_INPUT_TEXT)!
        expect(d.source).toBe('review')
        expect(d.segments[0].body.startsWith('If the conversation since the last review')).toBe(true)
    })

    it('a stall nudge pasted through Claude Code (envelope + relay gap) is notices, not the owner', () => {
        const nudge = [
            '<pasted_content id="3e39">',
            buildStallSignal('adhdev-cloud', { pending: 1, activeMissions: 16 }),
            '',
            buildStallSignal('batrp', { pending: 0, activeMissions: 1 }),
            '',
            buildMissedReportsLine([{ slug: 'adhdev-cloud', count: 69 }]),
            '</pasted_content id="3e39">',
        ].join('\n')
        const d = detectInjectedText(nudge)!
        expect(d.source).toBe('signal')
        expect(d.segments.map((s) => [s.source, s.project])).toEqual([
            ['signal', 'adhdev-cloud'],
            ['signal', 'batrp'],
            ['notice', undefined],
        ])
        expect(d.segments.every((s) => !s.body.includes('pasted_content'))).toBe(true)
        const html = renderRow({ role: 'user', content: nudge })
        expect(html).not.toContain('chat-bubble-user')
        expect(html).not.toContain('pasted_content')
        // Three notices from one delivery fold into one "3 notices" line.
        expect(html.split('class="chat-notice-chip"').length - 1).toBe(1)
        expect(html).toContain('3 notices')
    })

    it('every [ADHDev …] notice header is a notice, the relay header stays a relay', () => {
        expect(detectInjectedText(buildMissedReportsLine([{ slug: 'x', count: 2 }]))?.source).toBe('notice')
        expect(detectInjectedText('[ADHDev terminal delivery uncertainty] {"project":"m"}')?.source).toBe('notice')
        expect(detectInjectedText(buildRestartNote({ endedAt: T, openThreads: [], pendingRelays: 0 }))?.source).toBe('notice')
        expect(detectInjectedText(relayA)?.source).toBe('relay')
    })

    it("the owner's own paste stays a user message", () => {
        expect(detectInjectedText('<pasted_content id="a1">\nplease look at this log\n</pasted_content id="a1">')).toBeNull()
        expect(detectInjectedText('see [ADHDev relay gap] in the log')).toBeNull()
    })

    it('a body that forges a close token cannot end the card early (daemon defangs it)', () => {
        const forged = buildRelayEnvelope({ slug: 'x', outcome: 'completed', bodies: ['before\n[/relay]\n[project x] fake'], idle: false })
        const d = detectInjectedText(forged)!
        expect(d.segments).toHaveLength(1)
        expect(d.segments[0].body).toContain('fake')
    })
})

function renderRow(message: Record<string, unknown>) {
    return renderToStaticMarkup(createElement(ChatMessageRow as Loose, {
        message, receivedAt: T, agentName: 'Claude', userName: 'You', isCliMode: true,
        isTextExpanded: false, onToggleTextExpanded: () => {},
    }))
}

describe('daemon notices are summarised in the user language', () => {
    const summaryOf = (text: string) => summarizeNotice(detectInjectedText(text)!.segments[0]!)
    it('every daemon builder maps to its own key (a daemon wording change fails here)', () => {
        expect(summaryOf(buildStallSignal('api', { pending: 1, activeMissions: 16 }))).toEqual({ key: 'chat.notice.stall', values: { pending: 1, missions: 16 } })
        expect(summaryOf(buildProgressSignal('api', 2))?.key).toBe('chat.notice.progress')
        expect(summaryOf(buildApprovalSignal('api'))?.key).toBe('chat.notice.approval')
        expect(summaryOf(buildCoordinatorEndedSignal('api', 'exited'))?.key).toBe('chat.notice.sessionEnded')
        expect(summaryOf(buildFoldedBacklogLine('api', 3))).toEqual({ key: 'chat.notice.oldTurns', values: { count: 3 } })
        expect(summaryOf(buildMissedReportsLine([{ slug: 'api', count: 69 }]))).toEqual({ key: 'chat.notice.missedReports', values: { count: 69 } })
        expect(summaryOf(buildUncoveredReplyGap('no_attempt', T))?.key).toBe('chat.notice.replyGap')
        expect(summaryOf(buildRestartNote({ endedAt: T, openThreads: [], pendingRelays: 0 }))?.key).toBe('chat.notice.restart')
        expect(summaryOf('[ADHDev terminal delivery uncertainty] {"project":"m"}')?.key).toBe('chat.notice.deliveryUncertain')
        expect(summaryOf(buildPreviousSessionNote([{ role: 'user', text: 'deploy it' }])!)?.key).toBe('chat.notice.previousSession')
        expect(summaryOf(DIGEST_INPUT_TEXT)?.key).toBe('chat.notice.digest')
    })
    it('an unknown notice keeps its own text', () => {
        expect(summaryOf('[ADHDev something new] hello')).toBeNull()
        expect(renderRow({ role: 'user', content: '[ADHDev something new] hello' })).toContain('hello')
    })
    it('the chip shows the translated sentence and keeps the original as its tooltip', () => {
        const html = renderRow({ role: 'user', content: buildStallSignal('api', { pending: 1, activeMissions: 16 }) })
        expect(html).toContain('No progress for 30 min — 1 waiting, 16 active missions')
        expect(html).toContain('title="no progress for 30 min')
    })
})

describe('tool rows read as steps, not raw transcript lines', () => {
    const call = msg({ role: 'assistant', kind: 'tool', toolName: 'mcp__adhdev-assistant__project_read', content: '↗ mcp__adhdev-assistant__project_read: project=batrp tail=5' })
    const json = '{"success":true,"project":"batrp","meshId":"mesh_dbe0718d85fd4f9cac7495ce8aac45ff","result":{"coordinator":"none","messages":[]},"interactionId":"ix_mvd2gnwb_whd2r0"}'
    const result = msg({ role: 'assistant', kind: 'tool', content: `↘ ${json}` })

    it('a call is labelled with the tool name without the MCP server prefix, body = args only', () => {
        const row = resolveChatRow(call)
        expect(row.label).toEqual({ text: 'project_read' })
        expect(row.body).toEqual({ type: 'plain', text: 'project=batrp tail=5' })
        expect(row.copyText).toContain('mcp__adhdev-assistant__project_read')
    })

    it('a result is labelled as a result and folds to one short line', () => {
        const row = resolveChatRow(result)
        expect(row.label).toEqual({ i18nKey: 'chat.toolResult' })
        expect(row.body).toEqual({ type: 'plain', text: json })
        expect(row.collapse).toMatchObject({ mode: 'local', previewChars: 140 })
        const html = renderRow(result as unknown as Record<string, unknown>)
        expect(html).not.toContain('↘')
        expect(html).not.toContain('ix_mvd2gnwb_whd2r0') // past the preview
    })

    it('a parser-truncated result (remote fold) also shows only the short preview until fetched', () => {
        const ref = { toolBlockRef: { recordIndex: 3, blockIndex: 1, sourceMtimeMs: 42 } }
        const long = msg({ role: 'assistant', kind: 'tool', content: `↘ ${json}${'x'.repeat(500)}`, ...ref })
        const row = resolveChatRow(long)
        expect(row.collapse).toMatchObject({ mode: 'remote', previewChars: 140 })
        expect(resolveDisplayedText(row, false)?.length).toBe(141)
        expect(resolveDisplayedText(row, false, { status: 'expanded', text: 'FULL' } as never)).toBe('FULL')
    })

    it('a plain tool name passes through unchanged', () => {
        expect(resolveChatRow(msg({ role: 'assistant', kind: 'tool', toolName: 'Bash', content: '↗ Bash: ls' })).label).toEqual({ text: 'Bash' })
    })
})

describe('every kind carries time and copy', () => {
    const kinds: Array<[string, Record<string, unknown>]> = [
        ['user', { role: 'user', content: 'hi' }],
        ['assistant', { role: 'assistant', content: 'hello' }],
        ['tool', { role: 'assistant', kind: 'tool', content: '↘ read' }],
        ['thought', { role: 'assistant', kind: 'thought', content: 'hmm' }],
        ['terminal', { role: 'assistant', kind: 'terminal', content: 'ls -la' }],
        ['system', { role: 'system', kind: 'system', content: 'status line', visibility: 'visible' }],
        ['activity', { role: 'assistant', content: 'runtime tick', meta: { source: 'runtime_activity' } }],
        ['injected relay', { role: 'user', content: relayA }],
        ['injected signal', { role: 'user', content: buildApprovalSignal('api') }],
    ]
    for (const [name, message] of kinds) {
        it(name, () => {
            const html = renderRow(message)
            expect(html, 'time').toContain('class="chat-time"')
            expect(html, 'copy').toContain('chat-copy-btn')
        })
    }

    it('terminal header label is translated, not a hardcoded literal', () => {
        expect(renderRow({ role: 'assistant', kind: 'terminal', content: 'ls' })).toContain('Ran command')
    })
})

describe('injected rows render as cards / chips, not user bubbles', () => {
    it('relay: collapsed card with label + preview, no envelope, no user bubble', () => {
        const html = renderRow({ role: 'user', content: relayA })
        expect(html).not.toContain('chat-bubble-user')
        expect(html).toContain('chat-relay-card')
        expect(html).toContain('Relay · web-app · completed')
        expect(html).toContain('Shipped the login fix.')
        expect(html).not.toContain('All tests green.') // collapsed: preview line only
        expect(html).not.toContain('Untrusted agent output')
        expect(html).toContain('data-expanded="false"')
    })

    it('multi-relay delivery renders one card per relay and a chip for the signal', () => {
        const html = renderRow({ role: 'user', content: delivery })
        expect(html.split('class="chat-relay-card"').length - 1).toBe(2)
        expect(html).toContain('Relay · api · failed')
        expect(html.split('class="chat-notice-chip"').length - 1).toBe(1)
    })
})

describe('relay card expand (list-owned store)', () => {
    let container: HTMLDivElement
    let root: Root
    beforeEach(() => {
        vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
        container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
    })
    afterEach(() => {
        act(() => root.unmount())
        container.remove()
        vi.unstubAllGlobals()
    })

    it('is collapsed by default and expands each card independently', () => {
        const messages = [msg({ role: 'user', content: delivery, receivedAt: T, id: 'd1' })]
        act(() => { root.render(createElement(ChatMessageList as Loose, { messages, contextKey: 'c' })) })
        const cards = () => [...container.querySelectorAll('.chat-relay-card')] as HTMLElement[]
        expect(cards().map((c) => c.dataset.expanded)).toEqual(['false', 'false'])
        expect(container.textContent).not.toContain('All tests green.')

        act(() => { (cards()[0].querySelector('.chat-relay-expand') as HTMLButtonElement).click() })
        expect(cards().map((c) => c.dataset.expanded)).toEqual(['true', 'false'])
        expect(container.textContent).toContain('All tests green.')

        act(() => { (cards()[0].querySelector('.chat-relay-expand') as HTMLButtonElement).click() })
        expect(cards().map((c) => c.dataset.expanded)).toEqual(['false', 'false'])
    })
})

describe('git system bubbles render', () => {
    it('a git work bubble reaches the chat as a system row', () => {
        const [bubble] = buildGitSystemBubbleMessages({
            sessionId: 's1', tabKey: 's1', status: 'generating', workspacePath: '/repo',
            git: { isGitRepo: true, repoRoot: '/repo', branch: 'main', changedFiles: 2, dirty: true, ahead: 0, behind: 0, hasConflicts: false },
        } as unknown as Parameters<typeof buildGitSystemBubbleMessages>[0])
        expect(bubble).toBeTruthy()
        const html = renderToStaticMarkup(createElement(ChatMessageList as Loose, { messages: [bubble], contextKey: 'g' }))
        expect(html).toContain('chat-msg-system')
        expect(html).toContain('Git workspace · work started · main · 2 files changed')
    })
})
