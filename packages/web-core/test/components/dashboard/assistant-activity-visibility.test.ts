import { describe, expect, it } from 'vitest'
import {
    ASSISTANT_ACTIVITY_VISIBILITY_STORAGE_KEY,
    readAssistantActivityVisiblePreference,
    readChatActivityVisiblePreference,
    writeAssistantActivityVisiblePreference,
} from '../../../src/components/dashboard/chat-activity-visibility'

function memoryStorage() {
    const map = new Map<string, string>()
    return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v) } }
}

describe('assistant tool-step visibility', () => {
    it('is hidden by default while the global preference defaults to shown', () => {
        const storage = memoryStorage()
        expect(readAssistantActivityVisiblePreference(storage)).toBe(false)
        expect(readChatActivityVisiblePreference(storage)).toBe(true)
    })

    it('keeps its own key, independent of the global preference', () => {
        const storage = memoryStorage()
        writeAssistantActivityVisiblePreference(true, storage)
        expect(storage.getItem(ASSISTANT_ACTIVITY_VISIBILITY_STORAGE_KEY)).toBe('1')
        expect(readAssistantActivityVisiblePreference(storage)).toBe(true)
        expect(readChatActivityVisiblePreference(storage)).toBe(true)
        writeAssistantActivityVisiblePreference(false, storage)
        expect(readAssistantActivityVisiblePreference(storage)).toBe(false)
    })

    it('reads as hidden when storage is unavailable', () => {
        expect(readAssistantActivityVisiblePreference({ getItem: () => { throw new Error('blocked') } })).toBe(false)
    })
})
