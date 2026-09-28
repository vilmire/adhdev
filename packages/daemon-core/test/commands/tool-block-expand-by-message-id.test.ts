import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleExpandToolBlock } from '../../src/commands/chat-commands-expand-tool.js'
import { __resetMessageIdentityLedgersForTest, getMessageIdentityLedger } from '../../src/chat/message-identity-ledger.js'

/**
 * Keyed transcript lane (design 2026-09-28 §5.9): the replica wire carries only
 * `expandable`, so a reader asks `expand_tool_block` with `{ messageId }` and
 * the daemon resolves the tool-block ref from the session's identity ledger —
 * the ref the LATEST read observed, still sealed by its mtime.
 */

const SESSION = 'session_expand_by_id'

function helpers(adapter: unknown) {
    return {
        getCliAdapter: () => adapter,
        currentSession: { sessionId: SESSION, providerType: 'claude' },
        currentManagerKey: `cli:claude:${SESSION}`,
    } as never
}

afterEach(() => __resetMessageIdentityLedgersForTest())

describe('expand_tool_block by messageId', () => {
    it('resolves the ref through the ledger and expands that block', () => {
        const ref = { sourceMtimeMs: 42, recordIndex: 7, blockIndex: 1 }
        const src = { cls: 'n' as const, L: '0000abcd', addr: '7.2' }
        const id = getMessageIdentityLedger(SESSION)
            .observe([{ role: 'assistant', kind: 'tool', text: 'Bash(ls)…', revisionKey: 'k', src, locator: ref }])
            .assignments[0]!.messageId
        const expandToolBlock = vi.fn(() => ({ ok: true, toolName: 'Bash', result: 'full output', truncated: true }))
        const result = handleExpandToolBlock(helpers({ expandToolBlock }), { messageId: id, targetSessionId: SESSION })
        expect(result).toMatchObject({ success: true, toolName: 'Bash', result: 'full output' })
        expect(expandToolBlock).toHaveBeenCalledWith(ref)
    })

    it('an unknown messageId is refused as a missing ref, never guessed', () => {
        const expandToolBlock = vi.fn()
        const result = handleExpandToolBlock(helpers({ expandToolBlock }), { messageId: 'd.nope.1', targetSessionId: SESSION })
        expect(result.success).toBe(false)
        expect(expandToolBlock).not.toHaveBeenCalled()
    })
})
