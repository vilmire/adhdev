import { describe, expect, it } from 'vitest'
import { getMessageTimestamp } from '../../../src/components/dashboard/message-utils'

describe('dashboard message utils', () => {
    it('reads explicit parser-provided message timestamps without inventing fallbacks', () => {
        expect(getMessageTimestamp({ receivedAt: 1234, timestamp: 999 })).toBe(1234)
        expect(getMessageTimestamp({ timestamp: 999 })).toBe(999)
        expect(getMessageTimestamp({ receivedAt: 'not-a-number', timestamp: 999 })).toBe(0)
        expect(getMessageTimestamp(null)).toBe(0)
    })
})
