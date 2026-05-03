import { describe, expect, it } from 'vitest'
import { getDefaultChatTailHydrateLimit, getDefaultVisibleLiveMessages } from '../../../src/components/dashboard/chat-visibility'

describe('chat visibility', () => {
    it('uses a compact default live window for cli-like conversations', () => {
        expect(getDefaultVisibleLiveMessages({ isCliLike: false })).toBe(60)
        expect(getDefaultVisibleLiveMessages({ isCliLike: true })).toBe(50)
    })

    it('hydrates a matching compact recent tail window for cli-like conversations on reload/remount', () => {
        expect(getDefaultChatTailHydrateLimit({ isCliLike: false })).toBe(60)
        expect(getDefaultChatTailHydrateLimit({ isCliLike: true })).toBe(50)
    })
})
