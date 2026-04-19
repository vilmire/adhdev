import { describe, expect, it } from 'vitest'
import { getDefaultChatTailHydrateLimit, getDefaultVisibleLiveMessages } from '../../../src/components/dashboard/chat-visibility'

describe('chat visibility', () => {
    it('keeps a much larger default live window for cli-like conversations', () => {
        expect(getDefaultVisibleLiveMessages({ isCliLike: false })).toBe(60)
        expect(getDefaultVisibleLiveMessages({ isCliLike: true })).toBe(200)
    })

    it('hydrates a matching recent tail window for cli-like conversations on reload/remount', () => {
        expect(getDefaultChatTailHydrateLimit({ isCliLike: false })).toBe(60)
        expect(getDefaultChatTailHydrateLimit({ isCliLike: true })).toBe(200)
    })
})
