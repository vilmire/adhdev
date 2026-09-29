import { describe, expect, it } from 'vitest'
import { getChatPaneFirstViewState } from '../../../src/components/dashboard/DashboardMobileChatShared'

/**
 * Before the keyed chat lane delivers a session's first committed view the
 * pane shows a NEUTRAL loading state; the "Agent generating…" bubble appears
 * only when the status source says `generating` outright.
 */
describe('getChatPaneFirstViewState', () => {
    it('no view yet + a non-generating working status (starting/finalizing) → neutral loading, no typing bubble', () => {
        for (const status of ['starting', 'finalizing']) {
            expect(getChatPaneFirstViewState({ status, hasLiveSnapshot: false, visibleMessageCount: 0 }))
                .toEqual({ awaitingFirstView: true, showWorkingIndicator: false })
        }
    })

    it('no view yet + idle / unknown status → neutral loading, no typing bubble', () => {
        expect(getChatPaneFirstViewState({ status: 'idle', hasLiveSnapshot: false, visibleMessageCount: 0 }))
            .toEqual({ awaitingFirstView: true, showWorkingIndicator: false })
        expect(getChatPaneFirstViewState({ hasLiveSnapshot: false, visibleMessageCount: 0 }))
            .toEqual({ awaitingFirstView: true, showWorkingIndicator: false })
    })

    it('no view yet but the status source says generating → the typing bubble is shown', () => {
        expect(getChatPaneFirstViewState({ status: 'generating', hasLiveSnapshot: false, visibleMessageCount: 0 }))
            .toEqual({ awaitingFirstView: true, showWorkingIndicator: true })
    })

    it('once a view is on screen the typing bubble follows the working class as before', () => {
        expect(getChatPaneFirstViewState({ status: 'starting', hasLiveSnapshot: true, visibleMessageCount: 0 }))
            .toEqual({ awaitingFirstView: false, showWorkingIndicator: true })
        expect(getChatPaneFirstViewState({ status: 'idle', hasLiveSnapshot: true, visibleMessageCount: 3 }))
            .toEqual({ awaitingFirstView: false, showWorkingIndicator: false })
    })

    it('status-meta messages already visible count as a view (not awaiting)', () => {
        expect(getChatPaneFirstViewState({ status: 'starting', hasLiveSnapshot: false, visibleMessageCount: 2 }))
            .toEqual({ awaitingFirstView: false, showWorkingIndicator: true })
    })
})
