import { createHash } from 'crypto';
/**
 * Compact projections for the assistant project verbs (design
 * 2026-10-07-assistant-layer.md §4.2, §4.4, §4.6). Pure functions — the
 * verbs gather the inputs through `AssistantProjectPorts`.
 *
 * Content boundary: `projects` / `project_status` carry identifiers, enums,
 * counts, labels the operator set (machine nickname, mesh name), mission
 * titles and timestamps — no transcript text. `project_read` is the one verb
 * that returns coordinator transcript text, as its tool contract says.
 * `project_status.routing` (below) is the same rule applied to the routing
 * diagnostics: enums and numbers only, by allow-list.
 */

import { canonicalDaemonId, daemonIdsEquivalent, sanitizeRemoteRepoIdentity } from '@adhdev/mesh-shared';
import { resolveMeshHostStatus } from '../mesh/mesh-host-ownership.js';
import type { LocalMeshEntry } from '../repo-mesh-types.js';
import type { AssistantCoordinatorView } from './coordinator-lifecycle.js';
import type { QueueCounts } from './assistant-project-ports.js';
import type { ProjectUnreachableReason } from './assistant-remote-host.js';

/**
 * Scratch meshes (§4.2) are listed apart and not treated as projects:
 * `test-repo`, `scratch/*`, `local:*`, and repos under a temp directory.
 * A repo with no remote is still a project — onboarding gives it a
 * `local/<name>` or path identity, and the owner's local-only repos look
 * exactly like that.
 */
export function isUnmanagedRepoIdentity(repoIdentity: string | undefined): boolean {
    const id = String(repoIdentity ?? '').trim();
    if (!id) return true;
    if (/^test-repo$/i.test(id) || /^scratch\//i.test(id) || /^local:/i.test(id)) return true;
    return /^(?:\/private)?\/tmp\//.test(id) || /^\/var\/folders\//.test(id) || /^[A-Za-z]:[\\/].*[\\/](?:Temp|tmp)[\\/]/i.test(id);
}

function readText(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

function shortId(id: string): string {
    return id.length > 16 ? `${id.slice(0, 16)}…` : id;
}

/** Label of the daemon hosting a mesh: the host node's machine nickname, else a short daemon id. */
export function meshHostLabel(mesh: LocalMeshEntry, selfDaemonId: string): string {
    const host = resolveMeshHostStatus(mesh, { localDaemonId: selfDaemonId });
    const hostId = readText(host.hostDaemonId);
    const node = (mesh.nodes ?? []).find((n) => (hostId && daemonIdsEquivalent(readText(n.daemonId), hostId)) || (!!host.hostNodeId && n.id === host.hostNodeId));
    return readText(node?.machineNickname) || (hostId ? shortId(canonicalDaemonId(hostId) ?? hostId) : 'unknown host');
}

export type CoordinatorState = 'none' | 'idle' | 'working' | 'waiting';

export function coordinatorState(views: readonly AssistantCoordinatorView[]): CoordinatorState {
    if (views.length === 0) return 'none';
    if (views.some((v) => v.modalParked)) return 'waiting';
    return views.some((v) => !v.idle) ? 'working' : 'idle';
}

export interface ProjectRow {
    slug: string;
    meshId: string;
    name: string;
    repo: string;
    /** `here`: this daemon hosts the mesh. `remote`: another daemon does; it is driven by relay (owner decision 2026-10-08). `remote_followed`: checkout-less followed remote project. */
    hosting: 'here' | 'remote' | 'remote_followed';
    /** `this machine`, or the remote host's label. */
    host: string;
    /** Remote only: same as `host`. */
    hostLabel?: string;
    /** Remote only, when it differs from `meshId`: the id the host keys this mesh by (standalone address + code pairing). */
    hostMeshId?: string;
    /** Canonical host daemon id for followed remote projects. */
    hostDaemonId?: string;
    /** Canonical `${hostDaemonId}::${meshId}` key for followed remote projects. */
    canonicalKey?: string;
    /** Monotonic host grant revision for followed remote projects. */
    grantRevision?: number;
    /** Local owner binding revision for followed remote projects. */
    bindingRevision?: number;
    /** `local` (hosted here), `relay` (remote, reachable now) or `unreachable` (with `unreachableReason`). */
    reachability: 'local' | 'relay' | 'unreachable';
    unreachableReason?: ProjectUnreachableReason;
    coordinator?: CoordinatorState;
    threadOpen?: boolean | null;
    queue?: QueueCounts | null;
    activeMissions?: number | null;
    pendingApprovals?: number;
}

export interface MachineSummary {
    label: string;
    daemonId: string | null;
    os: string | null;
    build: string | null;
    /** True for this daemon; null when this daemon holds no liveness for it. */
    online: boolean | null;
    self: boolean;
}

/** A daemon that hosts a mesh this daemon does not (from the remote-host resolution). */
export interface RemoteHostMachine {
    daemonId: string | null;
    label: string;
}

/**
 * Machines across every mesh's nodes, one per daemon (canonical id), plus
 * this daemon. Labels and platform come from what the nodes report.
 *
 * `meshes` is the project inventory — meshes.json plus the meshes this daemon
 * is a MEMBER of (member-meshes.ts), so their nodes are walked too.
 * `remoteHosts` folds in the host of every remote project: a member that holds
 * only a host record + push subscription knows no host NODE (its member entry
 * lists only this daemon's node), so without it the list was "this machine"
 * alone (live 2026-10-09). Dedup is by `daemonIdsEquivalent` (mach_ vs
 * daemon_mach_ forms).
 */
export function machinesSummary(
    meshes: readonly LocalMeshEntry[],
    selfDaemonId: string,
    selfLabel?: string,
    remoteHosts: readonly RemoteHostMachine[] = [],
): MachineSummary[] {
    const selfKey = canonicalDaemonId(selfDaemonId) ?? selfDaemonId;
    const facts = new Map<string, { daemonId: string | null; nick: string; os: string; build: string; self: boolean }>();
    if (selfKey) facts.set(selfKey, { daemonId: selfDaemonId || null, nick: selfLabel ?? '', os: process.platform, build: '', self: true });
    const keyOf = (raw: string): { key: string; self: boolean } => {
        const self = !raw || (!!selfDaemonId && daemonIdsEquivalent(raw, selfDaemonId));
        if (self) return { key: selfKey, self };
        const existing = [...facts.keys()].find((k) => daemonIdsEquivalent(k, raw));
        return { key: existing ?? canonicalDaemonId(raw) ?? raw, self };
    };
    for (const mesh of meshes) {
        for (const node of mesh.nodes ?? []) {
            const raw = readText(node.daemonId);
            const { key, self } = keyOf(raw);
            if (!key) continue;
            const f = facts.get(key) ?? { daemonId: raw || null, nick: '', os: '', build: '', self };
            f.nick ||= readText(node.machineNickname);
            f.os ||= readText(node.reportedPlatform);
            f.build ||= readText(node.reportedDaemonBuildVersion);
            facts.set(key, f);
        }
    }
    for (const host of remoteHosts) {
        const raw = readText(host.daemonId);
        if (!raw) continue;
        const { key, self } = keyOf(raw);
        if (!key || self) continue;
        const f = facts.get(key) ?? { daemonId: raw, nick: '', os: '', build: '', self: false };
        // A node-reported nickname wins; the resolution's label is a nickname or a short id.
        const label = readText(host.label);
        if (!f.nick && label && label !== 'unknown host') f.nick = label;
        facts.set(key, f);
    }
    return [...facts.entries()]
        .map(([key, f]) => ({
            label: f.nick || (f.self ? 'this machine' : `daemon ${shortId(key)}`),
            daemonId: f.daemonId,
            os: f.os || null,
            build: f.build || null,
            online: f.self ? true : null,
            self: f.self,
        }))
        .sort((a, b) => Number(b.self) - Number(a.self) || a.label.localeCompare(b.label));
}

// ── project_status ─────────────────────────────────────────────────────────

function rec(v: unknown): Record<string, any> | null {
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : null;
}

export interface ProjectStatusExtras {
    queue: QueueCounts | null;
    pendingApprovals: number;
    coordinator: CoordinatorState;
    threadOpen: boolean | null;
    lastRelayAt: number | null;
    /**
     * Coordinator turns in THIS project that settled without their body
     * reaching the assistant (relay batch fold / aged-out backlog). The relay
     * envelope is the primary notice; this is the backstop for when the relay
     * carrying it is itself the thing that went missing. A count, never a body.
     */
    missedReports?: number;
    /** Clock for stale-mission ages (tests). */
    now?: number;
}

/** An active mission with no task activity for this long is reported as stale. */
export const STALE_MISSION_AFTER_MS = 3 * 24 * 60 * 60_000;

function firstText(sources: readonly any[], pick: (x: any) => unknown[]): string {
    for (const x of sources) {
        for (const v of pick(x)) {
            const t = readText(v);
            if (t) return t;
        }
    }
    return '';
}

/**
 * A node's machine label: the operator nickname (record, or the node's own
 * facts), else the machine identity's display name — unless that is only an
 * id (`buildMeshNodeMachineIdentity` falls back to the daemon/machine id) —
 * else its machine name. Standalone nodes usually carry no nickname, so the
 * label was null there (live 2026-10-09).
 */
function nodeMachineLabel(sources: readonly any[]): string {
    const nick = firstText(sources, (x) => [x?.machineNickname, rec(x?.nodeFacts)?.machineNickname]);
    if (nick) return nick;
    for (const x of sources) {
        const machine = rec(x?.machine);
        const ids = new Set([readText(machine?.daemonId), readText(machine?.machineId), readText(x?.daemonId), readText(x?.machineId)].filter(Boolean));
        for (const v of [machine?.displayName, machine?.machineName, x?.machineName]) {
            const t = readText(v);
            if (t && !ids.has(t)) return t;
        }
    }
    return '';
}

/** `os=<platform>` among a node's capability tags. */
function osTag(x: any): string {
    for (const list of [x?.capabilities, x?.capabilityTags]) {
        if (!Array.isArray(list)) continue;
        for (const tag of list) {
            const m = /^os=(.+)$/.exec(readText(tag));
            if (m && m[1]!.trim()) return m[1]!.trim();
        }
    }
    return '';
}

/** Reported platform (record, then the node's facts), else the `os=` capability tag. */
function nodePlatform(sources: readonly any[]): string {
    return firstText(sources, (x) => [x?.reportedPlatform, rec(x?.nodeFacts)?.platform]) || firstText(sources, (x) => [osTag(x)]);
}

/** The compact projection of a `mesh_status_view` answer (§4.4 project_status). */
export function compactProjectStatus(view: Record<string, unknown>, extras: ProjectStatusExtras): Record<string, unknown> {
    const routes = rec(view.routes) ?? {};
    const statusNodes: any[] = Array.isArray(rec(view.status)?.nodes) ? rec(view.status)!.nodes : [];
    const memberNodes: any[] = Array.isArray(rec(rec(view.membership)?.mesh)?.nodes) ? rec(rec(view.membership)!.mesh)!.nodes : [];
    const nodes = statusNodes.length > 0 ? statusNodes : memberNodes;
    const memberById = new Map<string, any>();
    for (const m of memberNodes) {
        const id = readText(m?.id) || readText(m?.nodeId);
        if (id && !memberById.has(id)) memberById.set(id, m);
    }
    const machines = nodes.map((n) => {
        const id = readText(n?.id) || readText(n?.nodeId);
        const local = rec(routes[id])?.route === 'local';
        // A status node carries the machine identity but not the raw record's
        // platform; the membership record (same id) fills what it lacks.
        const sources = [n, memberById.get(id)].filter(Boolean);
        return {
            node: id,
            label: nodeMachineLabel(sources) || null,
            os: nodePlatform(sources) || null,
            build: firstText(sources, (x) => [x?.reportedDaemonBuildVersion, x?.daemonBuildVersion, rec(rec(x?.nodeFacts)?.daemonBuild)?.version]) || null,
            online: local || readText(n?.machineStatus) === 'online',
            ...(readText(n?.worktreeBranch) ? { branch: readText(n.worktreeBranch) } : {}),
        };
    });
    const missionList: any[] = Array.isArray(rec(rec(view.missions)?.list)?.missions) ? rec(rec(view.missions)!.list)!.missions : [];
    const activeMissions = missionList
        .filter((m) => readText(m?.status) === 'active' || readText(m?.status) === 'paused')
        .map((m) => ({ id: readText(m?.id), title: readText(m?.title), status: readText(m?.status) }));
    // Active missions nothing has happened in for days (2026-10-18: one project
    // carried 16 "active" missions, most of them long dead, into every status
    // answer). Last activity = latest task update, else the mission's own update.
    const now = extras.now ?? Date.now();
    const staleMissions = missionList
        .filter((m) => readText(m?.status) === 'active')
        .map((m) => {
            const last = Date.parse(readText(rec(m?.tasks)?.lastActivityAt) || readText(m?.updatedAt) || readText(m?.createdAt));
            return { id: readText(m?.id), title: readText(m?.title), last };
        })
        .filter((m) => Number.isFinite(m.last) && now - m.last > STALE_MISSION_AFTER_MS)
        .sort((a, b) => a.last - b.last)
        .map((m) => ({ id: m.id, title: m.title, idleDays: Math.floor((now - m.last) / 86_400_000) }));
    const activeWork = rec(rec(view.activeWork)?.activeWork);
    const heldTasks = (Array.isArray(activeWork?.activeWork) ? activeWork.activeWork : []).filter((task: any) => task.status === 'pending' && task.hold);
    return {
        machines,
        machinesOnline: machines.filter((m) => m.online).length,
        queue: extras.queue,
        heldTasks: heldTasks.map((task: any) => ({ taskId: task.taskId, title: task.taskTitle, hold: task.hold })),
        heldCount: rec(activeWork?.summary)?.heldCount ?? heldTasks.length,
        heldReasons: rec(activeWork?.summary)?.heldReasons ?? {},
        activeMissions,
        failedTasks: extras.queue?.failed ?? null,
        pendingApprovals: extras.pendingApprovals,
        coordinator: extras.coordinator,
        threadOpen: extras.threadOpen,
        lastRelayAt: extras.lastRelayAt ? new Date(extras.lastRelayAt).toISOString() : null,
        // Only when there is something to report — a `0` every time is noise
        // the assistant would learn to skip.
        ...(extras.missedReports && extras.missedReports > 0 ? { missedReports: extras.missedReports } : {}),
        ...(staleMissions.length ? { staleMissions } : {}),
    };
}

// ── project_status: routing ────────────────────────────────────────────────
/**
 * Routing visibility (A7d, owner 2026-10-10): "모델선택 이런것에 대해서 비서가
 * 가시적으로 확인이 항상 가능하고" — the assistant must be able to see WHY a
 * provider is or is not the one a project would route to, without asking a
 * coordinator. The data already exists in `mesh_route_preview`
 * (mesh/mesh-route-preview.ts), which is fetch-free and read-only; this is its
 * projection down to the assistant's content boundary.
 *
 * Read-only in both senses: no quota is fetched (the preview reads cached
 * facts only), and nothing here changes routing. Changing/removing a route is
 * deliberately NOT part of this surface.
 *
 * ALLOW-LIST, not a deny-list (the same discipline as the server status
 * boundary): the types below enumerate every field that crosses, so a field
 * added upstream to `NodeRoutePreview` or `ProviderQuotaGateDiagnostic` cannot
 * leak by default. Everything listed is an identifier, enum, boolean or
 * number — never free text. In particular the preview's prose fields
 * (`note`, `availabilityAssumption`, `warning`, `limitations`) are omitted.
 */

/** Why a configured slot did not reach the ranking. Enum from the preview's difficulty-floor stage. */
export interface RoutingExcludedSlot {
    providerType: string;
    model?: string;
    /** e.g. `slot_capacity_exhausted`, `higher_difficulty_tier_deferred`, `difficulty_floor_unavailable`. */
    reason: string;
}

export interface RoutingSlot {
    providerType: string;
    model?: string;
}

/** One provider's quota evidence: why its bonus is what it is, and how the gate ruled. */
export interface RoutingQuotaRow {
    providerType: string;
    /** The cached snapshot's status (e.g. `ok`, `error`, `stale`); absent when no snapshot exists. */
    snapshotStatus?: string;
    /** How the last quota read failed, when it did. */
    failureKind?: string;
    /** Why the spread bonus is 0 — `no-data`, `stale`, `opted-out`, `provider-disabled`, `snapshot-error`. */
    zeroReason?: string;
    /** `clear` | `skip` | `hard-block` | `fail-open` | `not-evaluated-floor`. */
    gateOutcome: string;
    /** The gate's own reason enum, when it blocked or skipped. */
    gateReason?: string;
    bonusValue: number;
    /** Headroom on the ranked axis; absent when the axis had no readable reading. */
    remainingPercent?: number;
    /** The window axis this candidate was measured on. */
    axis?: 'weekly' | 'session';
}

export interface RoutingNodeRow {
    nodeId: string;
    /** The node's machine label when `project_status` knows one, else null. */
    machineName: string | null;
    /** What this node would route to now, or null (then `reason` says why). */
    predictedWinner: { providerType: string; model?: string; fitnessScore: number } | null;
    /** The node-level refusal enum (e.g. `provider_priority_unusable`, `task_difficulty_floor_unavailable:<d>`). */
    reason?: string;
    admitted: RoutingSlot[];
    excluded: RoutingExcludedSlot[];
    quota: RoutingQuotaRow[];
    /** True when quota ranking displaced the fitness stage's first choice. */
    reordered: boolean;
    displacedFitnessWinner?: string;
}

export interface ProjectRoutingView {
    /** The mesh's scheduling strategy (`fitness`, `first_eligible`, …). */
    strategy: string;
    /** The difficulty tier this preview was computed for. */
    difficulty: string;
    /** Mesh-wide prediction: the node+provider a task of this difficulty would land on. */
    predictedWinner: { nodeId: string; providerType: string; model?: string; fitnessScore: number } | null;
    perNode: RoutingNodeRow[];
    /** Set instead of the rows when the preview could not be computed here. */
    error?: string;
}

function routingNum(v: unknown): number | undefined {
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function routingSlot(v: unknown): RoutingSlot | null {
    const r = rec(v);
    const providerType = readText(r?.providerType);
    if (!providerType) return null;
    const model = readText(r?.model);
    return { providerType, ...(model ? { model } : {}) };
}

function axisOf(v: unknown): 'weekly' | 'session' | undefined {
    const t = readText(v);
    return t === 'weekly' || t === 'session' ? t : undefined;
}

function quotaRow(v: unknown): RoutingQuotaRow | null {
    const r = rec(v);
    const providerType = readText(r?.providerType);
    if (!providerType) return null;
    const bonus = rec(r?.bonus) ?? {};
    const gate = rec(r?.gate) ?? {};
    const ranking = rec(r?.ranking);
    const snapshotStatus = readText(bonus.snapshotStatus);
    const failureKind = readText(bonus.failureKind);
    const zeroReason = readText(bonus.zeroReason);
    const gateReason = readText(gate.reason);
    const remainingPercent = routingNum(ranking?.remainingPercent);
    const axis = axisOf(ranking?.axis);
    return {
        providerType,
        ...(snapshotStatus ? { snapshotStatus } : {}),
        ...(failureKind ? { failureKind } : {}),
        ...(zeroReason ? { zeroReason } : {}),
        gateOutcome: readText(gate.outcome) || 'unknown',
        ...(gateReason ? { gateReason } : {}),
        bonusValue: routingNum(bonus.value) ?? 0,
        ...(remainingPercent !== undefined ? { remainingPercent } : {}),
        ...(axis ? { axis } : {}),
    };
}

function routingNodeRow(v: unknown, labelOf: (nodeId: string) => string | null): RoutingNodeRow | null {
    const r = rec(v);
    const nodeId = readText(r?.nodeId);
    if (!nodeId) return null;
    const stages = rec(r?.stages) ?? {};
    const floor = rec(stages.difficultyFloor) ?? {};
    const quotaStage = rec(stages.quota) ?? {};
    const winner = rec(r?.predictedWinner);
    const winnerProvider = readText(winner?.providerType);
    const winnerModel = readText(winner?.model);
    const reason = readText(r?.reason);
    const displaced = readText(quotaStage.displacedFitnessWinner);
    return {
        nodeId,
        machineName: labelOf(nodeId),
        predictedWinner: winnerProvider
            ? { providerType: winnerProvider, ...(winnerModel ? { model: winnerModel } : {}), fitnessScore: routingNum(winner?.fitnessScore) ?? 0 }
            : null,
        ...(reason ? { reason } : {}),
        admitted: (Array.isArray(floor.admittedSlots) ? floor.admittedSlots : []).map(routingSlot).filter((s): s is RoutingSlot => !!s),
        excluded: (Array.isArray(floor.excludedSlots) ? floor.excludedSlots : [])
            .map((e: unknown) => {
                const s = routingSlot(e);
                const er = readText(rec(e)?.reason);
                return s && er ? { ...s, reason: er } : null;
            })
            .filter((e): e is RoutingExcludedSlot => !!e),
        quota: (Array.isArray(r?.quotaDiagnostics) ? r!.quotaDiagnostics : []).map(quotaRow).filter((q): q is RoutingQuotaRow => !!q),
        reordered: quotaStage.reordered === true,
        ...(displaced ? { displacedFitnessWinner: displaced } : {}),
    };
}

/**
 * Project a `mesh_route_preview` answer onto the assistant's routing view.
 * `machineLabels` maps nodeId → the label `project_status` already resolved,
 * so the assistant reads "mac-studio", not a node id.
 */
export function projectRoutingView(
    preview: Record<string, unknown> | null | undefined,
    difficulty: string,
    machineLabels: ReadonlyMap<string, string | null> = new Map(),
): ProjectRoutingView {
    const p = rec(preview) ?? {};
    const labelOf = (nodeId: string): string | null => machineLabels.get(nodeId) ?? null;
    const winner = rec(p.predictedWinner);
    const winnerNode = readText(winner?.nodeId);
    const winnerProvider = readText(winner?.providerType);
    const winnerModel = readText(winner?.model);
    return {
        strategy: readText(p.schedulingStrategy) || 'unknown',
        difficulty,
        predictedWinner: winnerNode && winnerProvider
            ? { nodeId: winnerNode, providerType: winnerProvider, ...(winnerModel ? { model: winnerModel } : {}), fitnessScore: routingNum(winner?.fitnessScore) ?? 0 }
            : null,
        perNode: (Array.isArray(p.nodes) ? p.nodes : [])
            .map((n: unknown) => routingNodeRow(n, labelOf))
            .filter((n): n is RoutingNodeRow => !!n),
    };
}

/** The difficulty tier `project_status` previews routing for (the queue's default tier). */
export const PROJECT_STATUS_ROUTING_DIFFICULTY = 'medium';

// ── live sessions (A2 session visibility) ──────────────────────────────────

/**
 * One live CLI session as the assistant may see it (owner decision 2026-10-10).
 *
 * Motivation: the assistant could read queue counts, missions and approvals but
 * NOT the live sessions, so an orphan worker — a session holding no task and no
 * messages — was invisible to it. The owner found one before the assistant did
 * (live 2026-10-10). These fields are what makes that detectable:
 * `messageCount: 0` with `spawnedForTaskId: null` IS the orphan signature.
 *
 * ★This interface is the content boundary, declared as a TYPE so it cannot be
 * widened by accident. It is an ALLOW-LIST: identifiers, enums, booleans,
 * counters and timestamps only — never free text authored by the user or the
 * agent. Do NOT rewrite it as a deny-list (`delete` / `Omit` over the live
 * state): `ProviderState` carries `activeChat.messages`, `errorMessage` and the
 * neighbouring `SessionEntry` carries `lastMessagePreview`, every one of which
 * would then leak the moment it is populated. Adding a field here means
 * asserting it is non-content.
 */
export interface SessionRow {
    sessionId: string;
    /** Provider type enum (`claude-cli`, `antigravity-cli`, …). */
    provider: string;
    /** Live status enum (`idle`, `generating`, `waiting_approval`, …). */
    status: string;
    /** Mesh/node this session is stamped to; null for a non-mesh session. */
    meshId: string | null;
    nodeId: string | null;
    /** Session age from its launch record; null when no launch record exists. */
    ageMs: number | null;
    /** Visible bubble count. 0 = this session has never been given work. */
    messageCount: number;
    /** Workspace ROOT only — never a sub-path or a file name. */
    workspace: string | null;
    isCoordinator: boolean;
    assistant: boolean;
    /** The queue task this session was auto-launched for; null if none. */
    spawnedForTaskId: string | null;
    /** Launch provenance enum; null when no launch record exists. */
    launchedBy: string | null;
}

function countVisibleBubbles(activeChat: unknown): number {
    const messages = rec(activeChat)?.messages;
    return Array.isArray(messages) ? messages.length : 0;
}

/**
 * Project live CLI instance states onto `SessionRow[]`.
 *
 * Scope is DAEMON-WIDE by default and that is deliberate: one daemon hosts
 * several meshes (live: adhdev-cloud + BATRP), and an orphan is found by
 * looking at the whole daemon, not one mesh — a coordinator that scoped the
 * question to one mesh was refused outright ("Node '…' is not a member of mesh
 * '…'"). Passing `meshId` narrows to that mesh plus sessions carrying no mesh
 * stamp at all (an orphan frequently has none). Same read-wide/write-narrow
 * asymmetry `machinesSummary` already uses: this is READ ONLY — nothing here
 * grants the assistant a way to act on another mesh's session.
 */
export function sessionRows(
    states: readonly unknown[],
    opts: { meshId?: string; now?: number } = {},
): SessionRow[] {
    const now = opts.now ?? Date.now();
    const want = readText(opts.meshId);
    const out: SessionRow[] = [];
    for (const raw of states) {
        const state = rec(raw);
        if (!state) continue;
        const sessionId = readText(state.instanceId);
        if (!sessionId) continue;
        const settings = rec(state.settings) ?? {};
        const launch = rec(state.launch);
        const meshId = readText(settings.meshNodeFor) || readText(settings.meshCoordinatorFor);
        // Narrowing keeps unstamped sessions: an orphan often carries no mesh
        // stamp, and dropping it would hide the very thing this surface is for.
        if (want && meshId && meshId !== want) continue;
        const launchedAt = typeof launch?.launchedAt === 'number' && Number.isFinite(launch.launchedAt)
            ? launch.launchedAt
            : null;
        out.push({
            sessionId,
            provider: readText(state.type) || readText(settings.providerType),
            status: readText(state.status),
            meshId: meshId || null,
            nodeId: readText(settings.meshNodeId) || null,
            ageMs: launchedAt === null ? null : Math.max(0, now - launchedAt),
            messageCount: countVisibleBubbles(state.activeChat),
            workspace: readText(state.workspace) || null,
            isCoordinator: !!readText(settings.meshCoordinatorFor),
            assistant: settings.assistant === true,
            spawnedForTaskId: readText(settings.autoLaunchedForQueueTaskId) || null,
            launchedBy: readText(launch?.launchedBy) || null,
        });
    }
    return out.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

function followerRoutingQuotaRow(v: unknown): RoutingQuotaRow | null {
    const r = rec(v);
    const providerType = readText(r?.providerType);
    if (!providerType) return null;
    const snapshotStatus = readText(r?.snapshotStatus);
    const failureKind = readText(r?.failureKind);
    const zeroReason = readText(r?.zeroReason);
    const gateReason = readText(r?.gateReason);
    const remainingPercent = routingNum(r?.remainingPercent);
    const axis = axisOf(r?.axis);
    return {
        providerType,
        ...(snapshotStatus ? { snapshotStatus } : {}),
        ...(failureKind ? { failureKind } : {}),
        ...(zeroReason ? { zeroReason } : {}),
        gateOutcome: readText(r?.gateOutcome) || 'unknown',
        ...(gateReason ? { gateReason } : {}),
        bonusValue: routingNum(r?.bonusValue) ?? 0,
        ...(remainingPercent !== undefined ? { remainingPercent } : {}),
        ...(axis ? { axis } : {}),
    };
}

function followerRoutingNodeRow(v: unknown): RoutingNodeRow | null {
    const r = rec(v);
    const nodeId = readText(r?.nodeId);
    if (!nodeId) return null;
    const winner = rec(r?.predictedWinner);
    const winnerProvider = readText(winner?.providerType);
    const winnerModel = readText(winner?.model);
    const reason = readText(r?.reason);
    const displaced = readText(r?.displacedFitnessWinner);
    return {
        nodeId,
        machineName: readText(r?.machineName) || null,
        predictedWinner: winnerProvider
            ? { providerType: winnerProvider, ...(winnerModel ? { model: winnerModel } : {}), fitnessScore: routingNum(winner?.fitnessScore) ?? 0 }
            : null,
        ...(reason ? { reason } : {}),
        admitted: (Array.isArray(r?.admitted) ? r.admitted : []).map(routingSlot).filter((s): s is RoutingSlot => !!s),
        excluded: (Array.isArray(r?.excluded) ? r.excluded : [])
            .map((e: unknown): RoutingExcludedSlot | null => {
                const s = routingSlot(e);
                const er = readText(rec(e)?.reason);
                return s && er ? { providerType: s.providerType, ...(s.model ? { model: s.model } : {}), reason: er } : null;
            })
            .filter((e): e is RoutingExcludedSlot => !!e),
        quota: (Array.isArray(r?.quota) ? r.quota : []).map(followerRoutingQuotaRow).filter((q): q is RoutingQuotaRow => !!q),
        reordered: r?.reordered === true,
        ...(displaced ? { displacedFitnessWinner: displaced } : {}),
    };
}

/**
 * Strict allow-list projection of a host's `localProjectStatus` result for a
 * checkout-less remote follower (`assistant_remote_project { op: 'status' }`).
 *
 * Follows the same allow-list discipline as the server content boundary and
 * `SessionRow` above (never object spread + delete):
 *   - `repo` is sanitized via `sanitizeRemoteRepoIdentity` (strips embedded
 *     credentials and rejects local filesystem paths);
 *   - `sessions` includes ONLY non-assistant sessions stamped to `mesh.id`,
 *     rebuilt field-by-field with `workspace: null`;
 *   - host-local assistant thread state (`threadOpen`, `lastRelayAt`,
 *     `missedReports`) is never forwarded.
 */
export function followerStatusView(
    raw: Record<string, unknown>,
    mesh: LocalMeshEntry,
): Record<string, unknown> {
    const rawRepo = readText((mesh as { repoRemoteUrl?: unknown }).repoRemoteUrl) || readText(mesh.repoIdentity) || readText(raw.repo);
    const machines = (Array.isArray(raw.machines) ? raw.machines : [])
        .map((item: unknown) => {
            const m = rec(item);
            const node = readText(m?.node);
            if (!node) return null;
            const branch = readText(m?.branch);
            return {
                node,
                label: readText(m?.label) || null,
                os: readText(m?.os) || null,
                build: readText(m?.build) || null,
                online: m?.online === true,
                ...(branch ? { branch } : {}),
            };
        })
        .filter((m): m is NonNullable<typeof m> => m !== null);
    const rawQueue = rec(raw.queue);
    const queue: QueueCounts | null = rawQueue
        ? {
            pending: typeof rawQueue.pending === 'number' && Number.isFinite(rawQueue.pending) ? rawQueue.pending : 0,
            assigned: typeof rawQueue.assigned === 'number' && Number.isFinite(rawQueue.assigned) ? rawQueue.assigned : 0,
            failed: typeof rawQueue.failed === 'number' && Number.isFinite(rawQueue.failed) ? rawQueue.failed : 0,
        }
        : null;
    const heldTasks = (Array.isArray(raw.heldTasks) ? raw.heldTasks : [])
        .map((item: unknown) => {
            const t = rec(item);
            const taskId = readText(t?.taskId);
            if (!taskId) return null;
            return {
                taskId,
                title: readText(t?.title),
                hold: readText(t?.hold) || null,
            };
        })
        .filter((t): t is NonNullable<typeof t> => t !== null);
    const heldReasonsRaw = rec(raw.heldReasons);
    const heldReasons: Record<string, number> = {};
    if (heldReasonsRaw) {
        for (const [k, v] of Object.entries(heldReasonsRaw)) {
            if (typeof v === 'number' && Number.isFinite(v)) heldReasons[k] = v;
        }
    }
    const activeMissions = (Array.isArray(raw.activeMissions) ? raw.activeMissions : [])
        .map((item: unknown) => {
            const m = rec(item);
            const id = readText(m?.id);
            if (!id) return null;
            return {
                id,
                title: readText(m?.title),
                status: readText(m?.status),
            };
        })
        .filter((m): m is NonNullable<typeof m> => m !== null);
    const staleMissions = (Array.isArray(raw.staleMissions) ? raw.staleMissions : [])
        .map((item: unknown) => {
            const m = rec(item);
            const id = readText(m?.id);
            if (!id) return null;
            return {
                id,
                title: readText(m?.title),
                idleDays: typeof m?.idleDays === 'number' && Number.isFinite(m.idleDays) ? m.idleDays : 0,
            };
        })
        .filter((m): m is NonNullable<typeof m> => m !== null);
    const sessions: SessionRow[] = (Array.isArray(raw.sessions) ? raw.sessions : [])
        .map((item: unknown): SessionRow | null => {
            const s = rec(item);
            if (!s) return null;
            const sessionId = readText(s.sessionId);
            const sessionMeshId = readText(s.meshId);
            if (!sessionId || sessionMeshId !== mesh.id || s.assistant === true) return null;
            return {
                sessionId,
                provider: readText(s.provider),
                status: readText(s.status),
                meshId: mesh.id,
                nodeId: readText(s.nodeId) || null,
                ageMs: typeof s.ageMs === 'number' && Number.isFinite(s.ageMs) ? s.ageMs : null,
                messageCount: typeof s.messageCount === 'number' && Number.isFinite(s.messageCount) ? s.messageCount : 0,
                workspace: null,
                isCoordinator: s.isCoordinator === true,
                assistant: false,
                spawnedForTaskId: readText(s.spawnedForTaskId) || null,
                launchedBy: readText(s.launchedBy) || null,
            };
        })
        .filter((s): s is SessionRow => s !== null);
    const rawRouting = rec(raw.routing);
    const routing: ProjectRoutingView | null = rawRouting
        ? {
            strategy: readText(rawRouting.strategy) || 'unknown',
            difficulty: readText(rawRouting.difficulty) || PROJECT_STATUS_ROUTING_DIFFICULTY,
            predictedWinner: rec(rawRouting.predictedWinner) && readText(rec(rawRouting.predictedWinner)!.nodeId) && readText(rec(rawRouting.predictedWinner)!.providerType)
                ? {
                    nodeId: readText(rec(rawRouting.predictedWinner)!.nodeId),
                    providerType: readText(rec(rawRouting.predictedWinner)!.providerType),
                    ...(readText(rec(rawRouting.predictedWinner)!.model) ? { model: readText(rec(rawRouting.predictedWinner)!.model) } : {}),
                    fitnessScore: routingNum(rec(rawRouting.predictedWinner)!.fitnessScore) ?? 0,
                }
                : null,
            perNode: (Array.isArray(rawRouting.perNode) ? rawRouting.perNode : [])
                .map(followerRoutingNodeRow)
                .filter((n): n is RoutingNodeRow => !!n),
            ...(readText(rawRouting.error) ? { error: readText(rawRouting.error) } : {}),
        }
        : null;
    const coord = readText(raw.coordinator);
    const coordinator: CoordinatorState = coord === 'idle' || coord === 'working' || coord === 'waiting' ? coord : 'none';
    return {
        name: readText(raw.name) || readText(mesh.name),
        repo: sanitizeRemoteRepoIdentity(rawRepo),
        machines,
        machinesOnline: machines.filter((m) => m.online).length,
        queue,
        heldTasks,
        heldCount: typeof raw.heldCount === 'number' && Number.isFinite(raw.heldCount) ? raw.heldCount : heldTasks.length,
        heldReasons,
        activeMissions,
        failedTasks: queue ? queue.failed : null,
        pendingApprovals: typeof raw.pendingApprovals === 'number' && Number.isFinite(raw.pendingApprovals) ? raw.pendingApprovals : 0,
        coordinator,
        threadOpen: null,
        lastRelayAt: null,
        ...(staleMissions.length > 0 ? { staleMissions } : {}),
        ...(routing ? { routing } : {}),
        sessions,
        ...(readText(raw.statusError) ? { statusError: 'mesh_status_view failed' } : {}),
    };
}

// ── project_read ───────────────────────────────────────────────────────────

export const PROJECT_READ_DEFAULT_TAIL = 10;
export const PROJECT_READ_MAX_TAIL = 50;
export const PROJECT_READ_MESSAGE_MAX_CHARS = 4_000;

export function messageText(m: any): string {
    const c = m?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((p: any) => (typeof p === 'string' ? p : readText(p?.text) ? p.text : '')).join('');
    return typeof m?.text === 'string' ? m.text : '';
}

/** Same visibility rule as the MCP read_chat compact mode: user/assistant bubbles, no tool/terminal/system chatter. */
export function isVisible(m: any): boolean {
    if (!m || typeof m !== 'object') return false;
    const role = readText(m.role).toLowerCase();
    if (role !== 'user' && role !== 'assistant' && role !== 'agent') return false;
    const kind = readText(m.kind ?? m.type ?? m.messageKind).toLowerCase();
    if (['tool', 'tool_call', 'tool_result', 'terminal', 'internal', 'control', 'debug', 'status'].includes(kind)) return false;
    const meta = m.meta ?? m.metadata;
    return !(meta?.internal === true || meta?.debug === true || meta?.control === true || meta?.userVisible === false);
}

export function compactTranscriptTail(readChat: Record<string, unknown>, tail: number, maxChars = PROJECT_READ_MESSAGE_MAX_CHARS): Record<string, unknown> {
    const messages: any[] = Array.isArray(readChat.messages) ? readChat.messages : [];
    const visible = messages.filter(isVisible);
    const picked = visible.slice(-tail).map((m) => {
        const text = messageText(m);
        const truncated = text.length > maxChars;
        const time = m.timestamp ?? m.receivedAt ?? m.createdAt;
        const at = typeof time === 'number' ? new Date(time).toISOString() : readText(time) || undefined;
        return {
            messageId: reportMessageId(m),
            totalChars: text.length,
            complete: !truncated && m.bubbleState !== 'streaming' && m.isStreaming !== true && m.meta?.streaming !== true,
            nextOffset: truncated ? maxChars : null,
            role: readText(m.role).toLowerCase() === 'user' ? 'user' : 'assistant',
            kind: readText(m.kind ?? m.messageKind) || 'standard',
            text: truncated ? `${text.slice(0, maxChars)}…` : text,
            ...(truncated ? { truncated: true } : {}),
            ...(at ? { at } : {}),
        };
    });
    return {
        messages: picked,
        visibleCount: visible.length,
        omitted: Math.max(0, visible.length - picked.length),
        ...(typeof readChat.status === 'string' ? { status: readChat.status } : {}),
    };
}

/** Content-bound identity: a changed/growing bubble cannot silently splice pages. */
export function reportMessageId(message: unknown): string {
    const m = message as any;
    return createHash('sha256').update(JSON.stringify([
        // read_chat stamps presentation ids; chat_history returns native rows.
        // A timestamped native reply must keep one cursor across both lanes.
        m?.timestamp == null && m?.receivedAt == null && m?.createdAt == null
            ? m?.messageId ?? m?.bubbleId ?? m?.id ?? null : null,
        m?.role, m?.timestamp ?? m?.receivedAt ?? m?.createdAt ?? null,
        m?.kind ?? m?.messageKind ?? 'standard', messageText(m),
    ])).digest('hex');
}
