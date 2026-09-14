/**
 * (G4/G11) Observability for the tool-block expand path.
 *
 * Both gaps came from the same blind spot: an expand that refuses leaves a
 * typed reason with the CALLER and no trace anywhere the operator can look.
 * "I clicked expand and nothing opened" produced zero daemon-side evidence, so
 * a broken mtime seal, an unreadable transcript, and an adapter that never
 * supported expand were indistinguishable without reproducing it live.
 *
 * G11 puts each refusal in the daemon log; G4 puts the seal state in the debug
 * bundle. The tests below pin the distinctions that make either readable —
 * above all that a stat FAILURE and a seal MISMATCH stay distinct from each
 * other and from "not measured".
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { handleExpandToolBlock } from '../../src/commands/chat-commands-expand-tool.js'
import { auditToolBlockRefSeals } from '../../src/commands/chat-commands-debug-bundle.js'
import { LOG } from '../../src/logging/logger.js'

const REF = { sourceMtimeMs: 1_700_000_000_000, recordIndex: 4, blockIndex: 2 }

function helpers(adapter: unknown) {
    return {
        getCliAdapter: () => adapter,
        currentSession: { sessionId: 'session_g11', providerType: 'claude' },
        currentManagerKey: 'cli:claude:session_g11',
    } as never
}

describe('(G11) expand_tool_block refusals reach the daemon log', () => {
    let warn: ReturnType<typeof vi.spyOn>

    beforeEach(() => { warn = vi.spyOn(LOG, 'warn').mockImplementation(() => {}) })
    afterEach(() => { warn.mockRestore() })

    const lines = () => warn.mock.calls.map((c) => String(c[1]))

    it('logs a seal break with the reason and the ref address', () => {
        const adapter = { expandToolBlock: () => ({ ok: false, reason: 'source_changed' }) }
        const result = handleExpandToolBlock(helpers(adapter), { toolBlockRef: REF })

        expect(result.success).toBe(false)
        expect(result.reason).toBe('source_changed')
        const line = lines().find((l) => l.includes('expand_tool_block'))
        expect(line).toBeDefined()
        expect(line).toContain('reason=source_changed')
        expect(line).toContain('session=session_g11')
        // The address, so the refusal can be tied to a specific bubble.
        expect(line).toContain(`mtime=${REF.sourceMtimeMs}`)
        expect(line).toContain('record=4')
        expect(line).toContain('block=2')
    })

    it('logs an adapter with no expand support, which is otherwise invisible', () => {
        const result = handleExpandToolBlock(helpers({}), { toolBlockRef: REF })
        expect(result.reason).toBe('unsupported_source')
        expect(lines().some((l) => l.includes('reason=unsupported_source'))).toBe(true)
    })

    it('logs a throwing adapter as source_unavailable, carrying the thrown message', () => {
        const adapter = { expandToolBlock: () => { throw new Error('ENOENT: transcript gone') } }
        const result = handleExpandToolBlock(helpers(adapter), { toolBlockRef: REF })
        expect(result.reason).toBe('source_unavailable')
        const line = lines().find((l) => l.includes('reason=source_unavailable'))
        expect(line).toContain('ENOENT: transcript gone')
    })

    it('logs a missing ref rather than failing silently', () => {
        handleExpandToolBlock(helpers({}), {})
        expect(lines().some((l) => l.includes('reason=missing_ref'))).toBe(true)
    })

    it('does NOT log on success — the log is for refusals only', () => {
        const adapter = {
            expandToolBlock: () => ({ ok: true, toolName: 'Bash', callArgs: 'ls', truncated: true }),
        }
        const result = handleExpandToolBlock(helpers(adapter), { toolBlockRef: REF })
        expect(result.success).toBe(true)
        expect(lines().filter((l) => l.includes('expand_tool_block'))).toHaveLength(0)
    })

    it('keeps block bodies out of the log line', () => {
        const secret = 'SENSITIVE-TOOL-OUTPUT-BODY'
        const adapter = { expandToolBlock: () => ({ ok: false, reason: 'block_not_found', body: secret }) }
        handleExpandToolBlock(helpers(adapter), { toolBlockRef: { ...REF, extra: secret } })
        expect(lines().join('\n')).not.toContain(secret)
    })
})

describe('(G4) the debug bundle audits toolBlockRef seals against the live file', () => {
    let dir: string
    let transcript: string

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g4-seal-'))
        transcript = path.join(dir, 'session.jsonl')
        fs.writeFileSync(transcript, '{"role":"user"}\n')
    })
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

    // The auditor is called on the `readChat` block the bundle has already
    // assembled, so it is exercised directly on that shape rather than through
    // the whole command — same input, none of the unrelated harness.
    const audited = (readChat: Record<string, unknown>) => auditToolBlockRefSeals(readChat)

    it('reports a matching seal as expandable', () => {
        const live = fs.statSync(transcript).mtimeMs
        const audit = audited({
            success: true,
            messageSource: { sourcePath: transcript },
            messagesTail: [{ role: 'assistant', kind: 'tool', toolBlockRef: { sourceMtimeMs: live, recordIndex: 0, blockIndex: 0 } }],
        })
        expect(audit?.messagesWithToolBlockRef).toBe(1)
        expect(audit?.distinctRefMtimes).toBe(1)
        expect(audit?.expandWouldSucceed).toBe(true)
        expect((audit?.refMtimes as any[])[0].matchesLiveFile).toBe(true)
    })

    it('reports a broken seal as NOT expandable — the source_changed case', () => {
        const audit = audited({
            success: true,
            messageSource: { sourcePath: transcript },
            messagesTail: [{ toolBlockRef: { sourceMtimeMs: 1, recordIndex: 0, blockIndex: 0 } }],
        })
        expect(audit?.expandWouldSucceed).toBe(false)
        expect((audit?.refMtimes as any[])[0].matchesLiveFile).toBe(false)
    })

    it('records a stat failure as a finding, not as a mismatch', () => {
        const audit = audited({
            success: true,
            messageSource: { sourcePath: path.join(dir, 'does-not-exist.jsonl') },
            messagesTail: [{ toolBlockRef: { sourceMtimeMs: 1, recordIndex: 0, blockIndex: 0 } }],
        })
        expect(audit?.statError).toBe('ENOENT')
        expect(audit?.expandWouldSucceed).toBe(false)
        // ★ Unknown, not false: the file could not be read, so the seal state is
        // undecided rather than broken. Collapsing the two would report a
        // missing transcript as a rewritten one.
        expect((audit?.refMtimes as any[])[0].matchesLiveFile).toBeUndefined()
    })

    it('flags a tail spanning more than one seal generation', () => {
        const live = fs.statSync(transcript).mtimeMs
        const audit = audited({
            success: true,
            messageSource: { sourcePath: transcript },
            messagesTail: [
                { toolBlockRef: { sourceMtimeMs: live, recordIndex: 0, blockIndex: 0 } },
                { toolBlockRef: { sourceMtimeMs: live - 5000, recordIndex: 1, blockIndex: 0 } },
            ],
        })
        expect(audit?.distinctRefMtimes).toBe(2)
        expect(audit?.expandWouldSucceed).toBe(false)
    })

    it('omits the block entirely when there is nothing to audit', () => {
        expect(audited({ success: true, messagesTail: [{ role: 'user', content: 'hi' }] })).toBeUndefined()
        expect(audited({ success: false, error: 'nope' })).toBeUndefined()
    })
})
