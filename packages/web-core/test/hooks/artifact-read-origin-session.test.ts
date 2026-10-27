/**
 * Regression (mission b295ce35 U1): "View full" on a coordinator/assistant card
 * fetches through the viewing session, but the daemon answers with the
 * artifact's own (producing) session. The response check must accept the
 * attachment's provenance session while still refusing any other session.
 */
import { describe, expect, it } from 'vitest'
import type { ChatAttachmentMeta } from '@adhdev/daemon-core'
import { readArtifactFetchCommandResponse } from '../../src/hooks/useArtifactRead'

const attachment: ChatAttachmentMeta = {
    artifactId: 'art_0123456789abcdef',
    kind: 'text',
    mime: 'text/plain',
    filename: 'report.txt',
    title: 'Report',
    sizeBytes: 5,
    sha256: 'a'.repeat(64),
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_005_000,
}

function respond(sessionId: string) {
    return {
        success: true,
        artifactId: attachment.artifactId,
        sessionId,
        kind: 'text',
        mime: 'text/plain',
        encoding: 'utf8',
        content: 'hello',
    }
}

const expectedFromCoordinator = (meta: ChatAttachmentMeta) => ({
    daemonId: 'daemon-1',
    sessionId: 'coord-sess',
    artifactId: attachment.artifactId,
    attachment: meta,
})

describe('artifact fetch response session check', () => {
    it('accepts the producing worker session named by the attachment provenance', () => {
        const result = readArtifactFetchCommandResponse(
            respond('worker-sess'),
            expectedFromCoordinator({ ...attachment, originSessionId: 'worker-sess' }),
        )
        expect(result.errorCode).toBeNull()
        expect(result.data?.sessionId).toBe('worker-sess')
        expect(result.data?.textContent).toBe('hello')
    })

    it('still accepts the requested session itself', () => {
        const result = readArtifactFetchCommandResponse(respond('coord-sess'), expectedFromCoordinator(attachment))
        expect(result.errorCode).toBeNull()
    })

    it('refuses a session that is neither requested nor the provenance session', () => {
        const withProvenance = readArtifactFetchCommandResponse(
            respond('sess-attacker'),
            expectedFromCoordinator({ ...attachment, originSessionId: 'worker-sess' }),
        )
        expect(withProvenance.data).toBeNull()
        expect(withProvenance.errorCode).toBe('session_mismatch')
        const withoutProvenance = readArtifactFetchCommandResponse(respond('worker-sess'), expectedFromCoordinator(attachment))
        expect(withoutProvenance.errorCode).toBe('session_mismatch')
    })
})
