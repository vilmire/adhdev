import { describe, expect, it } from 'vitest'

import {
    getConversationInboxSurfaceState,
    getConversationViewStates,
    type InboxSurfaceStateSource,
} from '../../src/components/dashboard/DashboardMobileChatShared'
import {
    WARM_SESSION_CHAT_TAIL_ACTIVE_STATUSES,
    shouldGuardTailShrinkForStatus,
    isBusyChatTailStatus,
} from '../../src/components/dashboard/chat-tail-status-classification'

/**
 * SESSIONSTATUS-TYPE-FORK — web-core half.
 *
 * `web-core/src/types.ts` re-exports `SessionStatus` from the daemon-core package
 * ROOT, whose hand-copied alias had drifted and no longer contained
 * `waiting_choice`. Every surface in this package therefore saw a union in which
 * the state did not exist, and the code here handled only `waiting_approval`.
 *
 * The inbox omission mattered twice over: the daemon-side bucket producer
 * (`status/snapshot.ts`) and this consumer both dropped `waiting_choice` in the
 * same direction, so neither layer could rescue the other. Fixing one alone
 * leaves the entry missing.
 */

type Conversation = Parameters<typeof getConversationInboxSurfaceState>[0]

function conversationWithStatus(status: string): Conversation {
    return { tabKey: 'tab-1', sessionId: 'session-1', status } as Conversation
}

/** No live daemon state — forces the surface to decide from `status` alone. */
function emptyLiveState(): Map<string, InboxSurfaceStateSource> {
    return new Map()
}

describe('waiting_choice across web-core surfaces', () => {
    // ── B (web layer): the inbox must raise its hand ───────────────────────
    describe('B — inbox bucketing', () => {
        it('marks a picker-parked conversation as requiring action', () => {
            const state = getConversationInboxSurfaceState(
                conversationWithStatus('waiting_choice'),
                emptyLiveState(),
            )

            // Before the fix this fell through to 'idle', so the conversation had
            // no entry in the attention list at all — the user could not reach the
            // (already working) banner because nothing pointed them at the session.
            expect(state.requiresAction).toBe(true)
            expect(state.inboxBucket).toBe('needs_attention')
        })

        it('buckets waiting_choice identically to waiting_approval', () => {
            const choice = getConversationInboxSurfaceState(
                conversationWithStatus('waiting_choice'),
                emptyLiveState(),
            )
            const approval = getConversationInboxSurfaceState(
                conversationWithStatus('waiting_approval'),
                emptyLiveState(),
            )

            expect(choice.inboxBucket).toBe(approval.inboxBucket)
            expect(choice.requiresAction).toBe(approval.requiresAction)
        })

        it('honours a daemon-supplied needs_attention bucket for waiting_choice', () => {
            // The other half of the two-layer fix: when status/snapshot.ts does
            // produce the bucket, this surface must carry it through.
            const live = new Map<string, InboxSurfaceStateSource>([
                ['session-1', { inboxBucket: 'needs_attention', unread: false }],
            ])
            const state = getConversationInboxSurfaceState(conversationWithStatus('waiting_choice'), live)

            expect(state.inboxBucket).toBe('needs_attention')
        })

        it('still leaves an ordinary idle conversation alone', () => {
            const state = getConversationInboxSurfaceState(
                conversationWithStatus('idle'),
                emptyLiveState(),
            )

            expect(state.requiresAction).toBe(false)
            expect(state.inboxBucket).toBe('idle')
        })

        it('keeps a generating conversation in the working bucket', () => {
            const state = getConversationInboxSurfaceState(
                conversationWithStatus('generating'),
                emptyLiveState(),
            )

            expect(state.isWorking).toBe(true)
            expect(state.inboxBucket).toBe('working')
        })
    })

    describe('the approval/choice view-state split survives', () => {
        it('reports waiting_choice on isWaitingChoice, not isWaiting', () => {
            // Surfaces that render RAW approval buttons (ApprovalBanner) must stay
            // able to tell the two apart — a raw single-select injection cannot
            // submit a checkbox picker (MULTISELECT-REMOTE-DEADLOCK). The inbox
            // opts into both deliberately; it must not do so by merging the flags.
            const views = getConversationViewStates({ status: 'waiting_choice' })

            expect(views.isWaitingChoice).toBe(true)
            expect(views.isWaiting).toBe(false)
        })

        it('reports waiting_approval on isWaiting, not isWaitingChoice', () => {
            const views = getConversationViewStates({ status: 'waiting_approval' })

            expect(views.isWaiting).toBe(true)
            expect(views.isWaitingChoice).toBe(false)
        })
    })

    // ── C: chat-tail shrink guard ──────────────────────────────────────────
    describe('C — chat tail shrink guard', () => {
        it('treats waiting_choice as a warm/active status', () => {
            // Same CHATFLICKER hazard the set was created for: while parked, the
            // daemon can emit a short partial tail that would replace the longer
            // hydrated liveMessages and make the assistant bubble blink out.
            expect(WARM_SESSION_CHAT_TAIL_ACTIVE_STATUSES.has('waiting_choice')).toBe(true)
            expect(shouldGuardTailShrinkForStatus('waiting_choice')).toBe(true)
        })

        it('guards waiting_choice exactly as it guards waiting_approval', () => {
            expect(shouldGuardTailShrinkForStatus('waiting_choice'))
                .toBe(shouldGuardTailShrinkForStatus('waiting_approval'))
        })

        it('leaves the strict busy predicate untouched', () => {
            // isBusyChatTailStatus deliberately EXCLUDES the parked states; only the
            // shrink-defer gate is widened.
            expect(isBusyChatTailStatus('waiting_choice')).toBe(false)
            expect(isBusyChatTailStatus('waiting_approval')).toBe(false)
            expect(isBusyChatTailStatus('generating')).toBe(true)
        })

        it('does not guard a genuinely idle session', () => {
            expect(shouldGuardTailShrinkForStatus('idle')).toBe(false)
        })
    })
})
