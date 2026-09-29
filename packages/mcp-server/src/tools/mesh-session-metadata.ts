
import type { MeshContext } from './mesh-tools-internal.js';
import { ledgerQuery } from '../ipc/turn-commands.js';
import { readString } from '@adhdev/mesh-shared';

type MeshSessionProviderMetadata = {
    providerType: string;
    providerSessionId?: string;
};

export const SESSION_PROVIDER_METADATA_TTL_MS = 30 * 60_000;

type TimestampedSessionMetadata = MeshSessionProviderMetadata & { expiresAt: number };

export const meshSessionProviderMetadata = new Map<string, TimestampedSessionMetadata>();

export function getSessionMetadata(key: string): MeshSessionProviderMetadata | undefined {
    const entry = meshSessionProviderMetadata.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
        meshSessionProviderMetadata.delete(key);
        return undefined;
    }
    return entry;
}

export function meshSessionCacheKey(nodeId: string, runtimeSessionId: string): string {
    return `${nodeId}:${runtimeSessionId}`;
}

function rememberMeshSessionProviderMetadata(
    nodeId: string | undefined,
    runtimeSessionId: string | undefined,
    metadata: MeshSessionProviderMetadata,
): void {
    const keyNodeId = readString(nodeId);
    const keySessionId = readString(runtimeSessionId);
    if (!keyNodeId || !keySessionId) return;
    const providerType = readString(metadata.providerType);
    const providerSessionId = readString(metadata.providerSessionId);
    if (!providerType && !providerSessionId) return;
    const existing = getSessionMetadata(meshSessionCacheKey(keyNodeId, keySessionId)) || { providerType: '' };
    meshSessionProviderMetadata.set(meshSessionCacheKey(keyNodeId, keySessionId), {
        providerType: providerType || existing.providerType,
        providerSessionId: providerSessionId || existing.providerSessionId,
        expiresAt: Date.now() + SESSION_PROVIDER_METADATA_TTL_MS,
    });
}

export function rememberMeshSessionProviderMetadataFromEvent(event: any): void {
    const metadataEvent = event?.metadataEvent && typeof event.metadataEvent === 'object'
        ? event.metadataEvent as Record<string, unknown>
        : event && typeof event === 'object'
            ? event as Record<string, unknown>
            : {};
    const nodeId = readString(event?.nodeId) || readString(metadataEvent.nodeId) || readString(metadataEvent.meshNodeId);
    const sessionId = readString(metadataEvent.targetSessionId)
        || readString(metadataEvent.sessionId)
        || readString(metadataEvent.instanceId)
        || readString(event?.sessionId);
    rememberMeshSessionProviderMetadata(nodeId, sessionId, {
        providerType: readString(metadataEvent.providerType) || readString(event?.providerType) || '',
        providerSessionId: readString(metadataEvent.providerSessionId) || readString(event?.providerSessionId),
    });
}

async function resolveMeshSessionProviderMetadataFromLedger(
    ctx: MeshContext,
    nodeId: string,
    runtimeSessionId: string,
): Promise<MeshSessionProviderMetadata | undefined> {
    let entries: Awaited<ReturnType<typeof ledgerQuery>>['entries'] = [];
    try { entries = (await ledgerQuery(ctx.transport, { meshId: ctx.mesh.id, tail: 50 })).entries; } catch { return undefined; }
    for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        const payload = entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload)
            ? entry.payload as Record<string, unknown>
            : {};
        const entryNodeId = readString(entry.nodeId) || readString(payload.nodeId) || readString(payload.meshNodeId);
        if (entryNodeId && entryNodeId !== nodeId) continue;
        const entrySessionId = readString(entry.sessionId)
            || readString(payload.targetSessionId)
            || readString(payload.sessionId)
            || readString(payload.instanceId);
        if (entrySessionId !== runtimeSessionId) continue;
        const providerType = readString(entry.providerType) || readString(payload.providerType);
        const completionDiagnostic = payload.completionDiagnostic && typeof payload.completionDiagnostic === 'object' && !Array.isArray(payload.completionDiagnostic)
            ? payload.completionDiagnostic as Record<string, unknown>
            : {};
        const metadataEvent = payload.metadataEvent && typeof payload.metadataEvent === 'object' && !Array.isArray(payload.metadataEvent)
            ? payload.metadataEvent as Record<string, unknown>
            : {};
        const providerSessionId = readString(payload.providerSessionId)
            || readString(completionDiagnostic.providerSessionId)
            || readString(metadataEvent.providerSessionId);
        if (providerType || providerSessionId) {
            return { providerType: providerType || '', providerSessionId };
        }
    }
    return undefined;
}

export async function resolveMeshSessionProviderMetadata(
    ctx: MeshContext,
    nodeId: string,
    runtimeSessionId: string,
): Promise<MeshSessionProviderMetadata | undefined> {
    const cached = getSessionMetadata(meshSessionCacheKey(nodeId, runtimeSessionId));
    if (cached?.providerType || cached?.providerSessionId) return cached;
    const fromLedger = await resolveMeshSessionProviderMetadataFromLedger(ctx, nodeId, runtimeSessionId);
    if (fromLedger) rememberMeshSessionProviderMetadata(nodeId, runtimeSessionId, fromLedger);
    return fromLedger;
}
