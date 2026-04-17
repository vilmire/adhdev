import { describe, expect, it } from 'vitest'
import {
    areLikelySameMessages,
    dedupeOptimisticMessages,
    excludeMessagesPresentInLiveFeed,
    filterUnconfirmedLocalMessages,
    getMessagePreviewHash,
    sortMessagesChronologically,
    type LocalUserMessage,
} from '../../../src/components/dashboard/message-utils'

describe('dashboard message utils', () => {
    it('matches optimistic local messages against confirmed server messages', () => {
        const serverMessages = [
            { role: 'user', content: 'Deploy this change', receivedAt: 1000 },
            { role: 'assistant', content: 'done', receivedAt: 1100 },
        ]
        const localMessages: LocalUserMessage[] = [
            { role: 'user', content: 'Deploy this change', timestamp: 1005, _localId: 'local-1' },
            { role: 'user', content: 'Open a PR', timestamp: 2000, _localId: 'local-2' },
        ]

        expect(filterUnconfirmedLocalMessages(serverMessages, localMessages)).toEqual([
            { role: 'user', content: 'Open a PR', timestamp: 2000, _localId: 'local-2' },
        ])
    })

    it('dedupes optimistic messages and prefers richer confirmed versions', () => {
        const deduped = dedupeOptimisticMessages([
            { role: 'assistant', content: 'Result', _localId: 'temp-1', timestamp: 1000 },
            { role: 'assistant', content: 'Result', id: 'msg-1', receivedAt: 1005 },
        ])

        expect(deduped).toEqual([
            { role: 'assistant', content: 'Result', id: 'msg-1', receivedAt: 1005 },
        ])
    })

    it('prefers the fuller confirmed user turn when a shorter live truncation would otherwise look like a second bubble', () => {
        const deduped = dedupeOptimisticMessages([
            { role: 'user', content: 'ㅇㅇ 근데 지금 보니까 방금 내가 한 말이 둘로 쪼개져보이네 ㅋ', id: 'msg-1', receivedAt: 1000 },
            { role: 'user', content: 'ㅇㅇ 근데 지금 보니까 방금', receivedAt: 1005 },
        ])

        expect(deduped).toEqual([
            { role: 'user', content: 'ㅇㅇ 근데 지금 보니까 방금 내가 한 말이 둘로 쪼개져보이네 ㅋ', id: 'msg-1', receivedAt: 1000 },
        ])
    })

    it('sorts messages chronologically and excludes history items already visible in live feed', () => {
        const historyMessages = [
            { role: 'assistant', content: 'Earlier reply', receivedAt: 1000 },
            { role: 'assistant', content: [{ text: 'Same rich content' }], receivedAt: 2000 },
        ]
        const liveMessages = [
            { role: 'assistant', content: 'Same rich content', receivedAt: 2100 },
            { role: 'user', content: 'Latest prompt', receivedAt: 3000 },
        ]

        expect(excludeMessagesPresentInLiveFeed(historyMessages, liveMessages)).toEqual([
            { role: 'assistant', content: 'Earlier reply', receivedAt: 1000 },
        ])

        expect(sortMessagesChronologically([
            { role: 'assistant', content: 'later', receivedAt: 3000 },
            { role: 'assistant', content: 'earlier', receivedAt: 1000 },
        ])).toEqual([
            { role: 'assistant', content: 'earlier', receivedAt: 1000 },
            { role: 'assistant', content: 'later', receivedAt: 3000 },
        ])
    })

    it('normalizes preview hashes and fuzzy message comparison consistently', () => {
        expect(getMessagePreviewHash({ role: 'Assistant', content: [{ text: 'Hello   world' }] }))
            .toBe('assistant:Hello world')

        expect(areLikelySameMessages(
            { role: 'user', content: 'Run tests', timestamp: 1000, _localId: 'a' },
            { role: 'user', content: 'Run tests', timestamp: 1005, _localId: 'b' },
        )).toBe(true)
    })
})
