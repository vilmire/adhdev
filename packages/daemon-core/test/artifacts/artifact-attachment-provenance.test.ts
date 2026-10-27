/**
 * Regression (mission b295ce35 U2): ChatAttachmentMeta must carry the
 * artifact's provenance identifiers so a bubble rendered outside the producing
 * session (coordinator/assistant card, follower view) can verify and route the
 * fetch. The wire decoder keeps them by name and drops malformed values.
 */
import { describe, expect, it } from 'vitest';
import { toChatAttachmentMeta, type ArtifactRecord } from '../../src/artifacts/index.js';
import { readChatAttachment } from '../../src/seqscribe/transcript-keyed-codec.js';

const record: ArtifactRecord = {
    artifactId: 'art_0123456789abcdef',
    sessionId: 'worker-sess',
    taskId: 'task-7',
    meshId: 'mesh-1',
    missionId: 'mission-9',
    producerRole: 'worker',
    originDaemonId: 'daemon-worker',
    workspaceRoot: '/ws',
    relPath: 'out/report.md',
    kind: 'markdown',
    mime: 'text/markdown',
    title: 'Report',
    sizeBytes: 12,
    sha256: 'a'.repeat(64),
    previewText: '# Report',
    createdAt: 1000,
    updatedAt: 2000,
};

describe('ChatAttachmentMeta provenance', () => {
    it('projects the producing session, task, mesh, mission, daemon, and role', () => {
        expect(toChatAttachmentMeta(record)).toMatchObject({
            artifactId: record.artifactId,
            originSessionId: 'worker-sess',
            taskId: 'task-7',
            meshId: 'mesh-1',
            missionId: 'mission-9',
            originDaemonId: 'daemon-worker',
            producerRole: 'worker',
        });
    });

    it('omits absent provenance and never leaks the workspace root', () => {
        const meta = toChatAttachmentMeta({ ...record, taskId: null, meshId: null, missionId: null, originDaemonId: null, producerRole: 'bogus' });
        expect(meta.originSessionId).toBe('worker-sess');
        for (const key of ['taskId', 'meshId', 'missionId', 'originDaemonId', 'producerRole', 'workspaceRoot', 'relPath']) {
            expect(meta).not.toHaveProperty(key);
        }
    });

    it('round-trips provenance through the wire decoder and drops a malformed role', () => {
        const meta = toChatAttachmentMeta(record);
        expect(readChatAttachment(JSON.parse(JSON.stringify(meta)))).toEqual(meta);
        const decoded = readChatAttachment({ ...meta, producerRole: 'root', originSessionId: 42, extra: 'x' });
        expect(decoded).not.toBeNull();
        expect(decoded).not.toHaveProperty('producerRole');
        expect(decoded).not.toHaveProperty('originSessionId');
        expect(decoded).not.toHaveProperty('extra');
        expect(decoded?.meshId).toBe('mesh-1');
    });
});
