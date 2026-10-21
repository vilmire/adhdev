/**
 * Projects the assistant is following (its open relay threads) plus checkout-less
 * remote project follow management (`assistant_remote_follow`), for the
 * dashboard: list them, follow a remote project (initializing high-water cursor
 * via `poll { cursorOnly: true }` without sending a message or reading old
 * transcript), stop following locally (`unfollow`), or mark access revoked.
 *
 * The list is read-only and also answers a local (`ipc`) client such as a
 * password-less standalone dashboard; mutating operations are owner-only
 * (`isTrustedOwnerIngress`, never `ipc`).
 */
import {
    ASSISTANT_ACCOUNT_SLOT,
    ASSISTANT_REMOTE_FOLLOW_COMMAND,
    ASSISTANT_VERB,
    canonicalDaemonId,
    daemonIdsEquivalent,
    followedRemoteProjectKey,
    sanitizeRemoteRepoIdentity,
    type AssistantOwnerBindingReceipt,
    type FollowedRemoteProjectEntry,
} from '@adhdev/mesh-shared';
import { isTrustedOwnerIngress } from '../command-args.js';
import { defineCommandSpecs } from '../command-registry.js';
import { ASSISTANT_OWNER_SOURCES, projectPortsFor } from './assistant-store.js';
import { getAssistantServices } from '../../assistant/assistant-services.js';
import { getAssistantRegistry } from '../../assistant/assistant-registry.js';
import { projectSlugBase, projectSlugs } from '../../assistant/assistant-projects.js';
import { MeshRuntimeStore } from '../../mesh/mesh-runtime-store.js';
import { SqliteAssistantRelayStore } from '../../assistant/assistant-relay-sqlite-store.js';
import type { AssistantRelayStore } from '../../assistant/assistant-relay-store.js';
import type { RemoteHostView } from '../../assistant/assistant-remote-host.js';
import type { HighFamilyHandler } from './types.js';

export interface AssistantThreadView {
    meshId: string;
    /** Project slug, or null when the project no longer exists (the relay closes it on its next tick). */
    project: string | null;
    openedAt: number;
    lastSendAt: number;
    hosting?: 'here' | 'remote' | 'remote_followed';
    hostDaemonId?: string;
    hostLabel?: string;
    canonicalKey?: string;
    grantRevision?: number;
    bindingRevision?: number;
    remoteState?: 'followed' | 'unfollowed' | 'revoked';
}

function str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

function isPositiveSafeInt(v: unknown): v is number {
    return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
}

async function runtimeOrNull() {
    // Lazy: assistant-runtime imports the command layer (cycle).
    const { getAssistantRuntime } = await import('../../assistant/assistant-runtime.js');
    return getAssistantRuntime();
}

function fallbackRelayStore(): AssistantRelayStore | null {
    try {
        return new SqliteAssistantRelayStore(MeshRuntimeStore.getInstance().db);
    } catch {
        return null;
    }
}

function slugsNow(): Map<string, string> {
    try { return projectSlugs(getAssistantServices().listMeshes()); } catch { return new Map(); }
}

const list: HighFamilyHandler = async () => {
    const runtime = await runtimeOrNull();
    const registry = runtime?.registry ?? getAssistantRegistry();
    const store = runtime?.store ?? fallbackRelayStore();
    const followedRemoteProjects: FollowedRemoteProjectEntry[] = registry.listFollowedRemoteProjects();
    const ownerBinding: AssistantOwnerBindingReceipt | null = registry.ownerBinding() ?? null;
    if (!store) {
        return { success: true, threads: [], followedRemoteProjects, ownerBinding };
    }
    const slugs = slugsNow();
    const meshes = (() => {
        try { return getAssistantServices().listMeshes(); } catch { return []; }
    })();
    const threads: AssistantThreadView[] = store.openThreads().map((t) => {
        const followed = followedRemoteProjects.find((f) => f.meshId === t.meshId && f.state === 'followed');
        const localMesh = meshes.find((m) => m.id === t.meshId);
        return {
            meshId: t.meshId,
            project: slugs.get(t.meshId) ?? followed?.slug ?? null,
            openedAt: t.openedAt,
            lastSendAt: t.lastSendAt,
            hosting: followed ? 'remote_followed' : localMesh ? 'here' : undefined,
            ...(followed
                ? {
                    hostDaemonId: followed.hostDaemonId,
                    ...(followed.hostLabel ? { hostLabel: followed.hostLabel } : {}),
                    canonicalKey: followed.key,
                    grantRevision: followed.grantRevision,
                    bindingRevision: followed.bindingRevision,
                    remoteState: followed.state,
                }
                : {}),
        };
    });
    threads.sort((a, b) => b.lastSendAt - a.lastSendAt);
    return { success: true, threads, followedRemoteProjects, ownerBinding };
};

const close: HighFamilyHandler = async (_ctx, args) => {
    if (!isTrustedOwnerIngress(args)) {
        return {
            success: false,
            code: 'owner_authorization_required',
            error: 'Closing a watched project requires authenticated owner ingress.',
        };
    }
    const meshId = typeof args?.meshId === 'string' ? args.meshId.trim() : '';
    const key = typeof args?.key === 'string' ? args.key.trim() : '';
    if ((!meshId || meshId.length > 200) && !key) {
        return { success: false, code: 'invalid_args', error: 'meshId required' };
    }
    const runtime = await runtimeOrNull();
    const registry = runtime?.registry ?? getAssistantRegistry();
    const store = runtime?.store ?? fallbackRelayStore();
    const followed = key
        ? registry.getFollowedRemoteProject(key)
        : registry.listFollowedRemoteProjects().find((f) => f.meshId === meshId && f.state === 'followed');
    if (followed) {
        registry.updateFollowedRemoteProject(followed.key, { state: 'unfollowed', unfollowedAt: Date.now() });
    }
    const targetMeshId = followed?.meshId || meshId;
    if (!runtime && !store && !followed) {
        return { success: false, code: 'assistant_unavailable' };
    }
    const closed = runtime
        ? runtime.relay.closeThread(targetMeshId, { suppressPending: true })
        : (store ? (store.closeThread(targetMeshId, Date.now()), true) : Boolean(followed));
    return { success: true, closed, ...(followed ? { unfollowedKey: followed.key } : {}) };
};

const remoteFollow: HighFamilyHandler = async (ctx, args) => {
    if (!isTrustedOwnerIngress(args)) {
        return {
            success: false,
            code: 'owner_authorization_required',
            error: 'Remote project follow management requires authenticated owner ingress.',
        };
    }
    const action = str(args?.action);
    const runtime = await runtimeOrNull();
    const registry = runtime?.registry ?? getAssistantRegistry();
    const store = runtime?.store ?? fallbackRelayStore();
    const selfDaemonId = canonicalDaemonId(str(ctx.deps?.statusInstanceId)) ?? str(ctx.deps?.statusInstanceId);

    if (action === 'ensure_binding' || action === 'reconcile_binding') {
        if (!selfDaemonId) {
            return { success: false, code: 'daemon_id_missing', error: 'Local assistant daemonId is unavailable.' };
        }
        const ownerBinding = registry.reconcileOwnerBinding(selfDaemonId, {
            forceNewRevision: args?.forceNewRevision === true,
        });
        return { success: true, ownerBinding };
    }

    if (action === 'follow') {
        const hostDaemonId = canonicalDaemonId(str(args?.hostDaemonId));
        const meshId = str(args?.meshId);
        const grantRevision = Number(args?.grantRevision);
        if (!hostDaemonId || !meshId || !isPositiveSafeInt(grantRevision)) {
            return {
                success: false,
                code: 'invalid_args',
                error: 'hostDaemonId, meshId, and positive integer grantRevision are required.',
            };
        }
        if (daemonIdsEquivalent(hostDaemonId, selfDaemonId)) {
            return {
                success: false,
                code: 'remote_host_is_self',
                error: 'Cannot remote-follow a project hosted on this same daemon.',
            };
        }

        // Verify local durable owner binding receipt; if none exists yet and
        // caller requested initial bindingRevision 1 (or omitted it on first
        // owner follow), initialize it once under trusted owner ingress.
        let bindingCheck = registry.verifyLocalOwnerBinding(selfDaemonId);
        if (!bindingCheck.ok && bindingCheck.code === 'local_owner_binding_missing' && (args?.bindingRevision === undefined || Number(args?.bindingRevision) === 1)) {
            registry.reconcileOwnerBinding(selfDaemonId);
            bindingCheck = registry.verifyLocalOwnerBinding(selfDaemonId);
        }
        if (!bindingCheck.ok) {
            return {
                success: false,
                code: bindingCheck.code,
                error: bindingCheck.error,
            };
        }
        if (args?.bindingRevision !== undefined && Number(args.bindingRevision) !== bindingCheck.receipt.bindingRevision) {
            return {
                success: false,
                code: 'binding_revision_mismatch',
                error: `Requested bindingRevision (${String(args.bindingRevision)}) does not match local ownerBinding (${bindingCheck.receipt.bindingRevision}).`,
            };
        }

        const hostLabel = str(args?.hostLabel) || hostDaemonId;
        const name = str(args?.name) || meshId;
        const sanitizedRepoIdentity = sanitizeRemoteRepoIdentity(str(args?.sanitizedRepoIdentity));
        const slug = str(args?.slug) || projectSlugBase(sanitizedRepoIdentity ?? undefined) || projectSlugBase(name) || meshId.toLowerCase();

        // Initialize high-water cursor via authorized cursorOnly poll on the
        // remote host. Never sends a message and never reads prior transcript.
        const ports = await projectPortsFor(ctx);
        const target: RemoteHostView = {
            label: hostLabel,
            hostDaemonId,
            hostMeshId: meshId,
            reachable: true,
            followerAccess: {
                accountSlot: ASSISTANT_ACCOUNT_SLOT,
                bindingRevision: bindingCheck.receipt.bindingRevision,
                grantRevision,
            },
        };
        const pollOut = await ports.callHost(target, 'poll', { cursorOnly: true });
        if (!pollOut.ok) {
            return {
                success: false,
                code: pollOut.code,
                error: pollOut.error,
                ...(pollOut.kind === 'unreachable' ? { reason: pollOut.reason } : {}),
            };
        }
        const pollRes = pollOut.result as Record<string, unknown>;
        const initialCursor = typeof pollRes.cursor === 'string' && pollRes.cursor.trim() ? pollRes.cursor.trim() : null;
        const coordinatorSessionId = typeof pollRes.coordinatorSessionId === 'string' && pollRes.coordinatorSessionId.trim()
            ? pollRes.coordinatorSessionId.trim()
            : null;
        const coordinatorState = typeof pollRes.coordinator === 'string' && pollRes.coordinator.trim()
            ? pollRes.coordinator.trim()
            : 'none';

        const entry = registry.upsertFollowedRemoteProject({
            hostDaemonId,
            ...(hostLabel ? { hostLabel } : {}),
            meshId,
            name,
            slug,
            sanitizedRepoIdentity,
            bindingRevision: bindingCheck.receipt.bindingRevision,
            grantRevision,
            state: 'followed',
            lastCursor: initialCursor,
            coordinatorSessionId,
            lastObserved: {
                observedAt: new Date().toISOString(),
                coordinatorState,
                coordinatorMissing: coordinatorState === 'none',
            },
        });

        if (runtime) {
            runtime.activate('registry');
            runtime.relay.openThread(meshId);
            runtime.store.setThreadCursor?.(meshId, initialCursor, coordinatorSessionId);
            runtime.remotePoller.noteSent(meshId, initialCursor);
        } else {
            store?.openThread(meshId, Date.now());
            store?.setThreadCursor?.(meshId, initialCursor, coordinatorSessionId);
            ports.relay.openThread?.(meshId);
            ports.relay.remoteSent?.(meshId, initialCursor);
        }

        return {
            success: true,
            entry,
            cursor: initialCursor,
            coordinatorSessionId,
            coordinator: coordinatorState,
        };
    }

    if (action === 'unfollow' || action === 'mark_revoked') {
        const keyArg = str(args?.key);
        const hostDaemonId = canonicalDaemonId(str(args?.hostDaemonId));
        const meshId = str(args?.meshId);
        const lookupKey = keyArg || (hostDaemonId && meshId ? followedRemoteProjectKey(hostDaemonId, meshId) : '');
        const existing = lookupKey
            ? registry.getFollowedRemoteProject(lookupKey)
            : (meshId ? registry.listFollowedRemoteProjects().find((f) => f.meshId === meshId) ?? null : null);
        if (!existing) {
            return {
                success: false,
                code: 'followed_project_not_found',
                error: 'Followed remote project entry not found.',
            };
        }
        const nextState = action === 'mark_revoked' ? 'revoked' : 'unfollowed';
        const now = Date.now();
        const updated = registry.updateFollowedRemoteProject(existing.key, {
            state: nextState,
            ...(nextState === 'revoked' ? { revokedAt: now } : { unfollowedAt: now }),
        });
        if (runtime) {
            runtime.relay.closeThread(existing.meshId, { suppressPending: true });
        } else {
            store?.closeThread(existing.meshId, now);
            try {
                const ports = await projectPortsFor(ctx);
                ports.relay.closeThread?.(existing.meshId, { suppressPending: true });
            } catch { /* ignore */ }
        }
        return {
            success: true,
            entry: updated,
            closed: true,
        };
    }

    return {
        success: false,
        code: 'invalid_args',
        error: `Unknown assistant_remote_follow action: ${action || 'none'}`,
    };
};

export const assistantThreadSpecs = defineCommandSpecs('high', {
    [ASSISTANT_VERB.threads]: list,
    [ASSISTANT_VERB.threadClose]: close,
    [ASSISTANT_REMOTE_FOLLOW_COMMAND]: remoteFollow,
}, {
    [ASSISTANT_VERB.threads]: { sources: [...ASSISTANT_OWNER_SOURCES, 'ipc'] },
    [ASSISTANT_VERB.threadClose]: { sources: [...ASSISTANT_OWNER_SOURCES] },
    [ASSISTANT_REMOTE_FOLLOW_COMMAND]: { sources: [...ASSISTANT_OWNER_SOURCES] },
});
