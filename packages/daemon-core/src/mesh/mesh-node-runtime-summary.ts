/**
 * Content-free RUNTIME summary of a mesh node's daemon — the half of a node's
 * state that is not git: its live sessions (ids / status / provider / turn
 * stage), its build stamp, a failed-upgrade marker and its facts bundle (which
 * carries the provider quota snapshot).
 *
 * Owner principle (2026-09-26): nothing on a request path fetches fresh values
 * from a remote machine — every node PUSHES to the coordinator daemon, which
 * holds the latest values and answers from them. The git half is
 * mesh-node-git-state.ts; this summary rides the same member push
 * (`mesh_node_git_report`, mesh-node-state-pusher.ts) and is held in the same
 * store row, so `mesh_status` (daemon and MCP) answers sessions / build / quota
 * for remote nodes without a per-daemon `get_status_metadata` round trip.
 *
 * ★CONTENT BOUNDARY: this is an ALLOW-LIST projection, applied on the member
 * before sending AND again on the coordinator at ingest (a legacy or tampered
 * member cannot land more). Identifiers, enums, booleans, counters and
 * timestamps only — never chat text: no message previews, no titles, no
 * transcript, no upgrade-notice prose. Adding a key here means asserting it is
 * non-content. It never leaves the daemons: mesh_status travels over P2P only
 * and the server status_report allow-list (RoutingSessionEntry) does not carry it.
 */
import { normalizeMeshNodeFacts, type MeshNodeFacts, readOptionalRecord } from '@adhdev/mesh-shared';

export const MESH_NODE_RUNTIME_SUMMARY_SCHEMA_VERSION = 1;
/** Upper bound on sessions carried per node (a daemon rarely hosts more than a handful). */
export const MESH_NODE_RUNTIME_MAX_SESSIONS = 64;
/** Upper bound on provider catalog rows carried per node. */
export const MESH_NODE_RUNTIME_MAX_PROVIDERS = 96;
const MAX_AUTO_APPROVE_MODES = 16;
const MAX_ID_CHARS = 200;
/** Manifest-authored labels / warnings (provider catalog, never user or agent text). */
const MAX_LABEL_CHARS = 300;

/** One session, in the RAW get_status_metadata session shape (so existing readers need no adapter), allow-listed. */
export interface MeshNodeRuntimeSession {
    id: string;
    instanceId?: string;
    sessionId?: string;
    providerType?: string;
    transport?: string;
    status?: string;
    providerSessionId?: string;
    surfaceHidden?: boolean;
    muted?: boolean;
    model?: string;
    modelSource?: string;
    thinkingLevel?: string;
    lastMessageRole?: string;
    lastMessageAt?: number;
    activeChat?: { status?: string; providerSessionId?: string };
    turn?: { attemptId?: string; stage?: string };
    coordinator?: { meshId?: string };
    settings?: {
        userHidden?: boolean;
        userMuted?: boolean;
        meshNodeFor?: string;
        meshNodeId?: string;
        meshCoordinatorFor?: string;
        launchedByCoordinator?: boolean;
        /** Sticky node marker of a detached session (identifier). */
        meshLastNodeId?: string;
        /** Coordinator daemon the session relays to (identifier). */
        meshCoordinatorDaemonId?: string;
    };
}

export interface MeshNodeRuntimeDaemonBuild {
    commit: string;
    commitShort?: string;
    version?: string;
    builtAt?: string;
    track: 'stable' | 'preview' | 'unknown';
}

/** One provider-declared auto-approve choice (manifest metadata; launch args are not carried). */
interface MeshNodeRuntimeAutoApproveMode {
    id: string;
    label?: string;
    strategy?: string;
    risk?: string;
    warning?: string;
}

/**
 * One provider in the node's catalog — what a launch surface needs to offer it
 * on that machine without asking the machine: identity, whether it is
 * installed / enabled there, its versions and its auto-approve choices.
 * Everything is manifest / detection metadata; nothing is user or agent text.
 */
export interface MeshNodeRuntimeProvider {
    type: string;
    category?: string;
    installed?: boolean;
    enabled?: boolean;
    machineStatus?: string;
    /** CLI binary version detected on the node (same source as nodeFacts.providerVersions). */
    version?: string;
    /** Provider manifest version the node loads. */
    providerVersion?: string;
    autoApproveModes?: { default?: string; modes: MeshNodeRuntimeAutoApproveMode[] };
}

/** A failed/rolled-back upgrade on record — structured fields only, never the notice prose. */
export interface MeshNodeRuntimeUpgradeFailure {
    recordedAt?: string;
    targetVersion?: string;
    noticePath?: string;
    logPath?: string;
}

export interface MeshNodeRuntimeSummary {
    schemaVersion: number;
    /** The reporting daemon's status instance id. */
    daemonId?: string;
    /**
     * Per-process id of the reporting daemon (a new value on every daemon
     * start). Lets the coordinator tell a restarted member from a late report of
     * the process it replaced.
     */
    daemonBootId?: string;
    daemonBuild?: MeshNodeRuntimeDaemonBuild;
    upgradeFailure?: MeshNodeRuntimeUpgradeFailure;
    sessions: MeshNodeRuntimeSession[];
    /** Versioned facts bundle (build / provider versions / pins / quota / enablement) — relayed opaquely. */
    nodeFacts?: MeshNodeFacts;
    /** True when `sessions` hit MESH_NODE_RUNTIME_MAX_SESSIONS. */
    sessionsTruncated?: boolean;
    /** The node's provider catalog (installed / enabled / versions / auto-approve modes). */
    providers?: MeshNodeRuntimeProvider[];
}

/** A short identifier-class string (trimmed, bounded, no newlines) — anything else is dropped. */
function readId(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_ID_CHARS || /[\r\n]/.test(trimmed)) return undefined;
    return trimmed;
}

function readBool(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function readTimestamp(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function compact<T extends Record<string, unknown>>(record: T): T | undefined {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) if (value !== undefined) out[key] = value;
    return Object.keys(out).length > 0 ? out as T : undefined;
}

export function sanitizeMeshNodeRuntimeSession(raw: unknown): MeshNodeRuntimeSession | null {
    const s = readOptionalRecord(raw);
    if (!s) return null;
    const id = readId(s.instanceId) ?? readId(s.id) ?? readId(s.sessionId);
    if (!id) return null;
    const activeChat = readOptionalRecord(s.activeChat);
    const turn = readOptionalRecord(s.turn);
    const coordinator = readOptionalRecord(s.coordinator);
    const settings = readOptionalRecord(s.settings);
    const lastMessageRole = readId(s.lastMessageRole);
    const session: MeshNodeRuntimeSession = {
        id,
        instanceId: readId(s.instanceId),
        sessionId: readId(s.sessionId),
        providerType: readId(s.providerType) ?? readId(s.cliType) ?? readId(s.type),
        transport: readId(s.transport),
        status: readId(s.status) ?? readId(s.lifecycle) ?? readId(s.state),
        providerSessionId: readId(s.providerSessionId),
        surfaceHidden: readBool(s.surfaceHidden),
        muted: readBool(s.muted),
        model: readId(s.model),
        modelSource: readId(s.modelSource),
        thinkingLevel: readId(s.thinkingLevel),
        // Role is an enum; anything that is not one is dropped (never free text).
        lastMessageRole: lastMessageRole && /^[a-z_]{1,32}$/.test(lastMessageRole) ? lastMessageRole : undefined,
        lastMessageAt: readTimestamp(s.lastMessageAt),
        activeChat: activeChat ? compact({ status: readId(activeChat.status), providerSessionId: readId(activeChat.providerSessionId) }) : undefined,
        turn: turn ? compact({ attemptId: readId(turn.attemptId), stage: readId(turn.stage) }) : undefined,
        coordinator: coordinator ? compact({ meshId: readId(coordinator.meshId) }) : undefined,
        settings: settings ? compact({
            userHidden: readBool(settings.userHidden),
            userMuted: readBool(settings.userMuted),
            meshNodeFor: readId(settings.meshNodeFor),
            meshNodeId: readId(settings.meshNodeId),
            meshCoordinatorFor: readId(settings.meshCoordinatorFor),
            launchedByCoordinator: readBool(settings.launchedByCoordinator),
            meshLastNodeId: readId(settings.meshLastNodeId),
            meshCoordinatorDaemonId: readId(settings.meshCoordinatorDaemonId),
        }) : undefined,
    };
    return compact(session as unknown as Record<string, unknown>) as unknown as MeshNodeRuntimeSession;
}

/** A single-line manifest label, bounded; newlines collapse to spaces. */
function readLabel(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const collapsed = value.replace(/[\r\n]+/g, ' ').trim();
    if (!collapsed) return undefined;
    return collapsed.length > MAX_LABEL_CHARS ? collapsed.slice(0, MAX_LABEL_CHARS) : collapsed;
}

function sanitizeAutoApproveModes(raw: unknown): MeshNodeRuntimeProvider['autoApproveModes'] | undefined {
    const config = readOptionalRecord(raw);
    if (!config || !Array.isArray(config.modes)) return undefined;
    const modes: MeshNodeRuntimeAutoApproveMode[] = [];
    for (const entry of config.modes) {
        const mode = readOptionalRecord(entry);
        const id = readId(mode?.id);
        if (!mode || !id) continue;
        if (modes.length >= MAX_AUTO_APPROVE_MODES) break;
        modes.push(compact({
            id,
            label: readLabel(mode.label),
            strategy: readId(mode.strategy),
            risk: readId(mode.risk),
            warning: readLabel(mode.warning),
        }) as MeshNodeRuntimeAutoApproveMode);
    }
    if (modes.length === 0) return undefined;
    const def = readId(config.default);
    return { ...(def ? { default: def } : {}), modes };
}

export function sanitizeMeshNodeRuntimeProvider(raw: unknown): MeshNodeRuntimeProvider | null {
    const p = readOptionalRecord(raw);
    const type = readId(p?.type) ?? readId(p?.id);
    if (!p || !type) return null;
    return compact({
        type,
        category: readId(p.category),
        installed: readBool(p.installed),
        enabled: readBool(p.enabled),
        machineStatus: readId(p.machineStatus),
        version: readId(p.version),
        providerVersion: readId(p.providerVersion),
        autoApproveModes: sanitizeAutoApproveModes(p.autoApproveModes),
    }) as MeshNodeRuntimeProvider;
}

function sanitizeProviders(raw: unknown): MeshNodeRuntimeProvider[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const out: MeshNodeRuntimeProvider[] = [];
    for (const entry of raw) {
        const provider = sanitizeMeshNodeRuntimeProvider(entry);
        if (!provider) continue;
        if (out.length >= MESH_NODE_RUNTIME_MAX_PROVIDERS) break;
        out.push(provider);
    }
    return out;
}

/**
 * Project a provider catalog (`buildAvailableProviders` / ProviderLoader info
 * rows) plus the node's detected CLI versions into runtime provider rows.
 */
export function buildMeshNodeRuntimeProviders(
    rows: unknown,
    providerVersions?: Record<string, string> | null,
): MeshNodeRuntimeProvider[] | undefined {
    if (!Array.isArray(rows)) return undefined;
    return sanitizeProviders(rows.map((row) => {
        const record = readOptionalRecord(row);
        const type = readId(record?.type);
        const version = type && providerVersions ? readId(providerVersions[type]) : undefined;
        // `version` is ALWAYS the detected binary version, never a same-named manifest field.
        return record ? { ...record, version } : row;
    }));
}

function sanitizeDaemonBuild(raw: unknown): MeshNodeRuntimeDaemonBuild | undefined {
    const build = readOptionalRecord(raw);
    const commit = readId(build?.commit);
    if (!build || !commit || commit === 'unknown') return undefined;
    const track = build.track === 'stable' || build.track === 'preview' ? build.track : 'unknown';
    return compact({
        commit,
        commitShort: readId(build.commitShort),
        version: readId(build.version),
        builtAt: readId(build.builtAt),
        track,
    }) as MeshNodeRuntimeDaemonBuild;
}

function sanitizeUpgradeFailure(raw: unknown): MeshNodeRuntimeUpgradeFailure | undefined {
    const failure = readOptionalRecord(raw);
    if (!failure) return undefined;
    // Presence of a notice (prose or path) is the fact; the prose itself never travels.
    if (typeof failure.notice !== 'string' && !readId(failure.noticePath) && failure.present !== true
        && !readId(failure.recordedAt) && !readId(failure.targetVersion)) {
        return undefined;
    }
    return compact({
        recordedAt: readId(failure.recordedAt),
        targetVersion: readId(failure.targetVersion),
        noticePath: readId(failure.noticePath),
        logPath: readId(failure.logPath),
    }) ?? {};
}

/** The allow-list. Idempotent: sanitizing a sanitized summary returns an equal one. */
export function sanitizeMeshNodeRuntimeSummary(raw: unknown): MeshNodeRuntimeSummary | null {
    const record = readOptionalRecord(raw);
    if (!record) return null;
    const rawSessions = Array.isArray(record.sessions) ? record.sessions : null;
    if (!rawSessions) return null;
    const sessions: MeshNodeRuntimeSession[] = [];
    for (const entry of rawSessions) {
        const session = sanitizeMeshNodeRuntimeSession(entry);
        if (!session) continue;
        if (sessions.length >= MESH_NODE_RUNTIME_MAX_SESSIONS) break;
        sessions.push(session);
    }
    const daemonBuild = sanitizeDaemonBuild(record.daemonBuild);
    const upgradeFailure = sanitizeUpgradeFailure(record.upgradeFailure);
    const nodeFacts = normalizeMeshNodeFacts(record.nodeFacts);
    const daemonId = readId(record.daemonId);
    const daemonBootId = readId(record.daemonBootId);
    const truncated = rawSessions.length > sessions.length && sessions.length >= MESH_NODE_RUNTIME_MAX_SESSIONS;
    const providers = sanitizeProviders(record.providers);
    return {
        schemaVersion: MESH_NODE_RUNTIME_SUMMARY_SCHEMA_VERSION,
        ...(daemonId ? { daemonId } : {}),
        ...(daemonBootId ? { daemonBootId } : {}),
        ...(daemonBuild ? { daemonBuild } : {}),
        ...(upgradeFailure ? { upgradeFailure } : {}),
        sessions,
        ...(nodeFacts ? { nodeFacts } : {}),
        ...(truncated ? { sessionsTruncated: true } : {}),
        ...(providers ? { providers } : {}),
    };
}

/**
 * Build a summary from a `get_status_metadata`-shaped result (`{ status: {
 * instanceId, sessions }, daemonBuild, upgradeFailure }`, bare or wrapped in
 * `{ result }`) plus an optional facts bundle and provider catalog.
 */
export function buildMeshNodeRuntimeSummary(statusMetadata: unknown, nodeFacts?: unknown, providers?: unknown): MeshNodeRuntimeSummary | null {
    let payload = readOptionalRecord(statusMetadata);
    if (payload && readOptionalRecord(payload.result) && !readOptionalRecord(payload.status)) payload = readOptionalRecord(payload.result);
    if (!payload) return null;
    const status = readOptionalRecord(payload.status) ?? payload;
    if (!Array.isArray(status.sessions)) return null;
    return sanitizeMeshNodeRuntimeSummary({
        daemonId: status.instanceId,
        daemonBootId: payload.daemonBootId ?? status.daemonBootId,
        daemonBuild: payload.daemonBuild,
        upgradeFailure: payload.upgradeFailure,
        sessions: status.sessions,
        nodeFacts: nodeFacts ?? undefined,
        ...(providers ? { providers } : {}),
    });
}

/**
 * Change signature. Ignores timestamps that move without a visible change
 * (the facts bundle stamp, per-quota fetch stamps, a session's lastMessageAt),
 * so an unchanged daemon stays quiet between heartbeats.
 */
export function computeMeshNodeRuntimeSignature(summary: MeshNodeRuntimeSummary | null | undefined): string {
    if (!summary) return 'none';
    const stripTimes = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(stripTimes);
        const record = readOptionalRecord(value);
        if (!record) return value;
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(record).sort()) {
            if (/At$/.test(key) || key === 'ageMs') continue;
            out[key] = stripTimes(record[key]);
        }
        return out;
    };
    return JSON.stringify([
        summary.daemonId ?? null,
        summary.daemonBootId ?? null,
        summary.daemonBuild ?? null,
        summary.upgradeFailure ? stripTimes(summary.upgradeFailure) : null,
        summary.sessions.map((s) => stripTimes(s)),
        summary.nodeFacts ? stripTimes(summary.nodeFacts) : null,
        summary.providers ?? null,
    ]);
}

/** Signature of the facts bundle (quota / build) and provider catalog — the parts the dashboard renders. */
export function computeMeshNodeFactsSignature(summary: MeshNodeRuntimeSummary | null | undefined): string {
    if (!summary?.nodeFacts && !summary?.providers) return 'none';
    // `reportedAt` (like every *At key) is ignored by the signature.
    return computeMeshNodeRuntimeSignature({
        schemaVersion: 1,
        sessions: [],
        ...(summary.nodeFacts ? { nodeFacts: summary.nodeFacts } : {}),
        ...(summary.providers ? { providers: summary.providers } : {}),
    });
}
