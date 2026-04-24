import { describe, expect, it } from 'vitest'
import { shouldReturnToInboxWhenSelectedConversationIsMissing } from '../../../src/components/dashboard/useDashboardMobileChatEffects'

describe('useDashboardMobileChatEffects', () => {
    it('only forces inbox fallback when the missing conversation was actively open in chat view', () => {
        expect(shouldReturnToInboxWhenSelectedConversationIsMissing('chat')).toBe(true)
        expect(shouldReturnToInboxWhenSelectedConversationIsMissing('inbox')).toBe(false)
        expect(shouldReturnToInboxWhenSelectedConversationIsMissing('machine')).toBe(false)
    })
})
