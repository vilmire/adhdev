/**
 * Binds driver-result artifacts to the real artifact store.
 *
 * Authority comes from the daemon, never from the driver: the worker identity was
 * proven at the command boundary (or recorded on the staged request), the
 * workspace is the daemon-registered session workspace, and the mission comes
 * from the task row. A worker whose task is not held by this daemon (remote
 * worker) or whose workspace is gone gets `null` and the result stays inline.
 */
import { realpathSync } from 'node:fs';
import { ArtifactStore, type ArtifactKind } from '../../artifacts/index.js';
import type { DriverArtifactPort } from '../../drivers/driver-artifacts.js';
import { publishSessionArtifactBubble } from '../../seqscribe/transcript-publisher.js';
import { getArtifactStore, getMeshRuntimeStore, type ArtifactCommandContext } from './artifact-runtime.js';
import { resolveRegisteredSessionWorkspace } from './artifact-sharing.js';

const text = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
const canon = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };

export function createDriverArtifactPort(ctx: ArtifactCommandContext): DriverArtifactPort {
    return {
        async resolve(identity) {
            const meshStore = getMeshRuntimeStore(ctx);
            const queueEntry = meshStore.findQueueEntryById(identity.meshId, identity.taskId) as Record<string, unknown> | null;
            if (!queueEntry && !meshStore.findAssignedBySession(identity.meshId, identity.sessionId)) return null;
            const resolved = await resolveRegisteredSessionWorkspace(ctx, identity.sessionId, {
                meshId: identity.meshId, nodeId: identity.nodeId, taskId: identity.taskId,
                allowTrustedWorkerFallback: true, allowStoredArtifactWorkspaceFallback: false,
            });
            if (!resolved.workspaceRoot) return null;
            const workspace = canon(resolved.workspaceRoot);
            if (!workspace) return null;
            if (resolved.nodeWorkspaceRoot && canon(resolved.nodeWorkspaceRoot) !== workspace) return null;
            const missionId = text(queueEntry?.missionId) || text((queueEntry?.payload as Record<string, unknown> | undefined)?.missionId) || null;
            const store: ArtifactStore = getArtifactStore(ctx);
            return {
                workspaceRoot: workspace,
                async register(input) {
                    const registered = store.register({
                        sessionId: identity.sessionId, taskId: identity.taskId, meshId: identity.meshId, missionId,
                        producerRole: 'worker', originDaemonId: text(ctx.deps?.statusInstanceId) || null,
                        workspaceRoot: workspace, path: input.relPath,
                        declaredKind: input.kind as ArtifactKind, declaredMime: input.mime, title: input.title,
                    });
                    // The chat bubble is a convenience; the artifact is already shareable without it.
                    await publishSessionArtifactBubble(identity.sessionId, {
                        attachment: registered.attachment, providerType: resolved.providerType, status: resolved.status,
                        title: resolved.title, forceUpsert: true,
                    }).catch(() => null);
                    return { artifactId: registered.record.artifactId, sha256: registered.record.sha256, sizeBytes: registered.record.sizeBytes };
                },
            };
        },
    };
}
