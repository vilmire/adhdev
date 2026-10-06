/**
 * The daemon reads/writes the assistant project verbs need
 * (commands/high-family/assistant.ts; design 2026-10-07-assistant-layer.md
 * §4.2–§4.4, §4.6), behind one port so the verbs stay testable with fakes.
 *
 * Everything here calls an existing function or command — the project
 * inventory (meshes.json via the assistant services), `hostedMeshes`,
 * `listLocalCoordinatorSessions` + the coordinator registry, queue stats and
 * missions, and the router's own commands in-process (`launch_mesh_coordinator`,
 * `send_chat`, `read_chat`, `mesh_status_view`, `plan_mesh_onboarding`,
 * `create_mesh`, `add_mesh_node`, `set_conversation_prefs`).
 *
 * Relay hooks (thread open/refresh, last relay time, skill-attach metric) are
 * owned by the relay unit; until boot installs them with
 * `setAssistantRelayHooks`, they are no-ops and the views report `null`.
 */

import type { DaemonComponents } from '../boot/daemon-components.js';
import type { LocalMeshEntry } from '../repo-mesh-types.js';
import type { AssistantCoordinatorView } from './coordinator-lifecycle.js';
import { getAssistantServices } from './assistant-services.js';

export interface AssistantRelayHooks {
    openThread?(meshId: string): void;
    isThreadOpen?(meshId: string): boolean;
    lastRelayAt?(meshId: string): number | null;
    /** `assistant_metric_daily.skill_attaches` for the target mesh (§4.6). */
    recordSkillAttaches?(meshId: string, count: number): void;
}

let relayHooks: AssistantRelayHooks = {};

/** Boot (relay wiring) installs the hooks; null clears them. */
export function setAssistantRelayHooks(hooks: AssistantRelayHooks | null): void {
    relayHooks = hooks ?? {};
}

export interface QueueCounts {
    pending: number;
    assigned: number;
    failed: number;
}

export type Execute = (cmd: string, args: Record<string, unknown>) => Promise<{ success: boolean; [key: string]: unknown }>;

export interface AssistantProjectPorts {
    selfDaemonId(): string;
    listMeshes(): LocalMeshEntry[];
    isHostedHere(mesh: LocalMeshEntry): boolean;
    aliases(): Record<string, string>;
    coordinators(meshId: string): AssistantCoordinatorView[];
    /** Newest coordinator registry session of the mesh (live or not) — read_chat history fallback. */
    lastCoordinatorSessionId(meshId: string): string | null;
    /** Mesh's last coordinator cliType, else the assistant's default; null → launch decides. */
    cliTypeFor(meshId: string): string | null;
    queueCounts(meshId: string): QueueCounts | null;
    activeMissionCount(meshId: string): number | null;
    /** Local CLI sessions of the mesh (coordinator or worker) parked on an approval/choice. */
    pendingApprovals(meshId: string): number;
    relay: AssistantRelayHooks;
    /** The router's own command, in-process. */
    execute: Execute;
}

export interface ProjectPortsContext {
    components: () => DaemonComponents;
    execute: Execute;
    selfDaemonId: string;
}

type PortsFactory = (ctx: ProjectPortsContext) => AssistantProjectPorts;
let factoryOverride: PortsFactory | null = null;

/** Tests: replace the ports (null → the default factory). */
export function setAssistantProjectPortsForTests(factory: PortsFactory | null): void {
    factoryOverride = factory;
}

export async function getAssistantProjectPorts(ctx: ProjectPortsContext): Promise<AssistantProjectPorts> {
    if (factoryOverride) return factoryOverride(ctx);
    await preloadAssistantProjectReaders();
    return createDefaultProjectPorts(ctx);
}

function readText(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

type CliInstanceLike = { getState(): any };

function cliInstances(ctx: ProjectPortsContext): CliInstanceLike[] {
    return ctx.components().instanceManager.getByCategory('cli') as unknown as CliInstanceLike[];
}

const APPROVAL_STATUSES: ReadonlySet<string> = new Set(['waiting_approval', 'waiting_choice']);

/**
 * Default ports over the live daemon. The mesh reader modules are loaded by
 * `preloadAssistantProjectReaders()` (the verbs await it once) so the reads
 * below stay synchronous; queue/mission reads are best-effort (null on failure).
 */
export function createDefaultProjectPorts(ctx: ProjectPortsContext): AssistantProjectPorts {
    const svc = getAssistantServices();
    const lazy = loadMeshReaders();
    return {
        selfDaemonId: () => ctx.selfDaemonId,
        listMeshes: () => svc.listMeshes(),
        isHostedHere: (mesh) => (svc.isMeshHostedHere ? svc.isMeshHostedHere(mesh) : lazy.hostedMeshes(ctx.components(), [mesh]).length > 0),
        aliases: () => lazy.assistantAliases(),
        coordinators: (meshId) => {
            const started = new Map(lazy.listCoordinatorsForMesh(meshId).map((e) => [e.sessionId, e.startedAt]));
            const settingsOf = new Map<string, Record<string, unknown>>();
            for (const inst of cliInstances(ctx)) {
                const state = inst.getState?.();
                const id = readText(state?.instanceId);
                if (id && state?.settings && typeof state.settings === 'object') settingsOf.set(id, state.settings);
            }
            return lazy.listLocalCoordinatorSessions(ctx.components(), meshId).map((v) => ({
                sessionId: v.sessionId,
                idle: v.idle,
                modalParked: v.modalParked,
                managedByAssistant: settingsOf.get(v.sessionId)?.managedByAssistant === true,
                ...(started.has(v.sessionId) ? { startedAt: started.get(v.sessionId) } : {}),
            }));
        },
        lastCoordinatorSessionId: (meshId) => lazy.listCoordinatorsForMesh(meshId)[0]?.sessionId ?? null,
        cliTypeFor: (meshId) => {
            const fromMesh = lazy.listCoordinatorsForMesh(meshId).find((e) => readText(e.cliType))?.cliType;
            return readText(fromMesh) || readText(lazy.assistantCliType()) || null;
        },
        queueCounts: (meshId) => {
            try {
                const s = lazy.getMeshQueueStats(meshId);
                return { pending: s.pending, assigned: s.assigned, failed: s.failed };
            } catch { return null; }
        },
        activeMissionCount: (meshId) => {
            try { return lazy.getMeshMissions(meshId, ['active']).length; } catch { return null; }
        },
        pendingApprovals: (meshId) => {
            let n = 0;
            for (const inst of cliInstances(ctx)) {
                const state = inst.getState?.();
                const settings = state?.settings ?? {};
                if (readText(settings.meshCoordinatorFor) !== meshId && readText(settings.meshNodeFor) !== meshId) continue;
                if (APPROVAL_STATUSES.has(readText(state?.status).toLowerCase())) n++;
            }
            return n;
        },
        relay: relayHooks,
        execute: ctx.execute,
    };
}

// ── mesh readers ────────────────────────────────────────────────────────────
// Static imports would pull the mesh runtime into every importer of the
// assistant module index; the verbs load them once on first use instead.

interface MeshReaders {
    hostedMeshes: typeof import('../mesh/mesh-housekeeping-tick.js').hostedMeshes;
    listLocalCoordinatorSessions: typeof import('../mesh/mesh-event-forwarding.js').listLocalCoordinatorSessions;
    listCoordinatorsForMesh: typeof import('../mesh/coordinator-registry.js').listCoordinatorsForMesh;
    getMeshQueueStats: typeof import('../mesh/mesh-work-queue.js').getMeshQueueStats;
    getMeshMissions: typeof import('../mesh/mesh-missions.js').getMeshMissions;
    assistantAliases: () => Record<string, string>;
    assistantCliType: () => string | null;
}

let readers: MeshReaders | null = null;

/** Load the mesh reader modules (call before the first default-ports read). */
export async function preloadAssistantProjectReaders(): Promise<void> {
    if (readers) return;
    const [hk, fwd, reg, queue, missions, registry] = await Promise.all([
        import('../mesh/mesh-housekeeping-tick.js'),
        import('../mesh/mesh-event-forwarding.js'),
        import('../mesh/coordinator-registry.js'),
        import('../mesh/mesh-work-queue.js'),
        import('../mesh/mesh-missions.js'),
        import('./assistant-registry.js'),
    ]);
    const assistantRegistry = new registry.AssistantRegistry();
    readers = {
        hostedMeshes: hk.hostedMeshes,
        listLocalCoordinatorSessions: fwd.listLocalCoordinatorSessions,
        listCoordinatorsForMesh: reg.listCoordinatorsForMesh,
        getMeshQueueStats: queue.getMeshQueueStats,
        getMeshMissions: missions.getMeshMissions,
        assistantAliases: () => assistantRegistry.reload()?.aliases ?? {},
        assistantCliType: () => assistantRegistry.reload()?.cliType ?? null,
    };
}

function loadMeshReaders(): MeshReaders {
    if (!readers) throw new Error('assistant project readers not loaded (call preloadAssistantProjectReaders first)');
    return readers;
}
