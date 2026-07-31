import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildConversations } from '../../src/components/dashboard/buildConversations'
import { dedupeChatIdes } from '../../src/hooks/useDashboardConversations'
import { deriveApprovalsFromConversations } from '../../src/components/MeshGraph/PendingApprovalsInbox'
import type { DaemonData } from '../../src/types'

function readSource(relativePath: string): string {
    return fs.readFileSync(path.join(import.meta.dirname, '../../src', relativePath), 'utf8')
}

/** A session entry as the dashboard receives it (one per machine). */
function session(o: Partial<DaemonData> & { id: string }): DaemonData {
    return { type: 'cli-session', status: 'idle', ...o } as DaemonData
}

/**
 * Exercise the exact pipeline the Approvals page runs:
 *   ides → dedupeChatIdes → buildConversations → deriveApprovalsFromConversations
 * This is what proves the page aggregates across machines from real daemon entries,
 * rather than only that the leaf component renders a hand-made list.
 */
function approvalsFrom(ides: DaemonData[]) {
    return deriveApprovalsFromConversations(buildConversations(dedupeChatIdes(ides), ides, {}))
}

describe('Approvals page pipeline', () => {
    it('aggregates waiting_approval sessions from multiple machines into one list', () => {
        const items = approvalsFrom([
            session({
                id: 'daemon-mac:s1', sessionId: 's1', daemonId: 'daemon-mac', status: 'waiting_approval',
                agentType: 'claude-cli', workspace: '/repo/mac',
                activeChat: { activeModal: { message: 'Run rm -rf /tmp?', buttons: ['Yes', 'No'] } } as any,
            }),
            session({
                id: 'daemon-win:s2', sessionId: 's2', daemonId: 'daemon-win', status: 'waiting_approval',
                agentType: 'codex-cli', workspace: '/repo/win',
            }),
            session({
                id: 'daemon-lin:s3', sessionId: 's3', daemonId: 'daemon-lin', status: 'generating',
                agentType: 'claude-cli', workspace: '/repo/lin',
            }),
        ])

        // Spans two distinct machines; the generating session is excluded.
        expect(items).toHaveLength(2)
        expect(new Set(items.map(i => i.nodeId))).toEqual(new Set(['daemon-mac', 'daemon-win']))

        // The hydrated modal carries the question text and its button labels through.
        const mac = items.find(i => i.nodeId === 'daemon-mac')!
        expect(mac.detail).toBe('Run rm -rf /tmp?')
        expect(mac.options).toEqual(['Yes', 'No'])
    })

    it('yields nothing when no session is awaiting approval', () => {
        expect(approvalsFrom([
            session({ id: 'd:a', sessionId: 'a', daemonId: 'd', status: 'idle', workspace: '/w' }),
        ])).toEqual([])
    })
})

describe('Approvals import boundaries', () => {
    it('does not import the @adhdev/web-core barrel from inside web-core', () => {
        expect(readSource('pages/Approvals.tsx')).not.toContain("from '@adhdev/web-core'")
    })

    it('does not value-import the daemon-core root barrel (bundle-death trap)', () => {
        const source = readSource('pages/Approvals.tsx')
        // A VALUE import of the daemon-core root barrel pulls node-only code into the
        // web bundle and kills it. Type-only imports are fine; this page needs neither.
        expect(source).not.toMatch(/^import\s+(?!type)[^;]*from '@adhdev\/daemon-core'/m)
    })
})
