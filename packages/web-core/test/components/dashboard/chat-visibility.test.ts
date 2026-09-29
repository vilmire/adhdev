import { describe, expect, it } from 'vitest'
import { getDefaultVisibleLiveMessages } from '../../../src/components/dashboard/chat-visibility'

describe('chat visibility', () => {
    it('uses a compact default live window for cli-like conversations', () => {
        expect(getDefaultVisibleLiveMessages({ isCliLike: false })).toBe(60)
        expect(getDefaultVisibleLiveMessages({ isCliLike: true })).toBe(50)
    })
})
