import { describe, expect, it } from 'vitest'
import {
    MAX_TRANSCRIPT_TOPICS_AVAILABLE,
    TRANSCRIPT_TOPICS_AVAILABLE_TYPE,
    parseTranscriptTopicsAvailable,
    sessionsToResubscribeOnAvailable,
} from '../../src/transcript-transport/topic-availability'
import { sessionChatTopic } from '../../src/transcript-transport/topic-addressing'

describe('transcript_topics_available', () => {
    it('matches the daemon-side frame type', () => {
        expect(TRANSCRIPT_TOPICS_AVAILABLE_TYPE).toBe('transcript_topics_available')
    })

    it('parses a well-formed frame and refuses malformed ones', () => {
        expect(parseTranscriptTopicsAvailable({ type: TRANSCRIPT_TOPICS_AVAILABLE_TYPE, topics: ['session.a.chat', ''] }))
            .toEqual(['session.a.chat'])
        expect(parseTranscriptTopicsAvailable({ type: TRANSCRIPT_TOPICS_AVAILABLE_TYPE })).toBeNull()
        expect(parseTranscriptTopicsAvailable({ type: TRANSCRIPT_TOPICS_AVAILABLE_TYPE, topics: ['x', 2] })).toBeNull()
        expect(parseTranscriptTopicsAvailable({
            type: TRANSCRIPT_TOPICS_AVAILABLE_TYPE,
            topics: Array.from({ length: MAX_TRANSCRIPT_TOPICS_AVAILABLE + 1 }, (_, i) => `session.s${i}.chat`),
        })).toBeNull()
        expect(parseTranscriptTopicsAvailable({ type: 'status', topics: [] })).toBeNull()
        expect(parseTranscriptTopicsAvailable(null)).toBeNull()
    })

    it('selects only activated, undelivered sessions whose sanitized topic is listed', () => {
        const raw = 'Sess:A.1'
        expect(sessionsToResubscribeOnAvailable([raw, 'b'], new Set(), [sessionChatTopic(raw)])).toEqual([raw])
        expect(sessionsToResubscribeOnAvailable([raw, 'b'], new Set([raw]), [sessionChatTopic(raw)])).toEqual([])
        expect(sessionsToResubscribeOnAvailable([], undefined, [sessionChatTopic(raw)])).toEqual([])
        expect(sessionsToResubscribeOnAvailable(['b'], undefined, [])).toEqual([])
    })
})
