/**
 * Artifact MCP Tools (Task C — MCP Exposure for Session Artifacts)
 *
 * Surface split by MCP mode:
 *   - Worker mode (`--worker`): `artifact_register` only. Credentials (`bind` /
 *     `token`) come exclusively from the worker MCP process context — never
 *     from tool arguments. Any payload overrides (`workspace`, `workspaceRoot`,
 *     `sessionId`, `targetSessionId`, `bind`, `token`, `taskId`, `meshId`) are
 *     omitted from the schema and stripped before calling the daemon.
 *   - Coordinator / mesh mode (`--mesh`): `artifact_list` only (`CANONICAL_MESH_TOOL_NAMES`).
 *     Resolves the coordinator's authorized session / mesh scope before
 *     forwarding via `ctx.transport.command('artifact_list', ...)`.
 *   - Standard mode: `artifact_register` and `artifact_list` via the existing
 *     authenticated `transport.command(...)` channel.
 *
 * C8 boundary compliance:
 *   This module communicates with the daemon exclusively via `transport.command(...)`
 *   and has zero value imports from `daemon-core/src/artifacts/**` or
 *   `daemon-core/src/mesh/**`, and zero direct DB or filesystem access.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { CommandTransport } from '../transports/mode.js';
import { recordMeshCoordinatorToolCall, type MeshContext } from './mesh-tools-internal.js';
import type { WorkerCredentials } from './worker-tools.js';

export const ALLOWED_ARTIFACT_KINDS = ['markdown', 'image', 'diff', 'json', 'text'] as const;
export type AllowedArtifactKind = typeof ALLOWED_ARTIFACT_KINDS[number];

const ARTIFACT_KIND_SET: ReadonlySet<string> = new Set(ALLOWED_ARTIFACT_KINDS);

function trimString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

const ARTIFACT_REGISTER_BASE_PROPERTIES = {
    path: {
        type: 'string',
        description:
            'Workspace-relative path to the file inside the session workspace (e.g. "docs/report.md" or "screenshots/result.png"). Path traversal (..) and symlinks escaping the workspace are rejected.',
    },
    title: {
        type: 'string',
        description: 'Optional human-readable display title for the artifact (defaults to the file basename).',
    },
    kind: {
        type: 'string',
        enum: [...ALLOWED_ARTIFACT_KINDS],
        description:
            'Optional expected artifact kind (markdown, image, diff, json, text); validated against the file extension.',
    },
} as const;

/**
 * Worker-mode `artifact_register` tool schema.
 *
 * Credentials (`bind`, `token`) and session/task identity are injected from the
 * worker MCP server's trusted launch context, so no credential or session/workspace
 * override fields are published in `inputSchema.properties`.
 */
export const ARTIFACT_REGISTER_TOOL: Tool & { description: string } = {
    name: 'artifact_register',
    description:
        'Register a workspace file (markdown, image, diff, json, or text; max 4 MiB, max 50 artifacts per session) as a user-visible session artifact and publish an attachment bubble in the session chat.',
    inputSchema: {
        type: 'object',
        properties: {
            ...ARTIFACT_REGISTER_BASE_PROPERTIES,
        },
        required: ['path'],
        additionalProperties: false,
    },
};

/**
 * Standard-mode `artifact_register` tool schema.
 *
 * Allows an optional `session_id` naming the registered daemon session whose
 * workspace owns the file. Arbitrary workspace path overrides are never accepted.
 */
export const STANDARD_ARTIFACT_REGISTER_TOOL: Tool = {
    name: 'artifact_register',
    description: ARTIFACT_REGISTER_TOOL.description,
    inputSchema: {
        type: 'object',
        properties: {
            ...ARTIFACT_REGISTER_BASE_PROPERTIES,
            session_id: {
                type: 'string',
                description: 'Registered session ID owning the workspace file.',
            },
        },
        required: ['path'],
        additionalProperties: false,
    },
};

/**
 * Coordinator & standard-mode `artifact_list` tool schema.
 */
export const ARTIFACT_LIST_TOOL: Tool = {
    name: 'artifact_list',
    description:
        'List artifacts registered for a session, mission, or mesh (returns artifact metadata and ChatAttachmentMeta entries; never raw file bytes).',
    inputSchema: {
        type: 'object',
        properties: {
            session_id: {
                type: 'string',
                description:
                    'Optional session ID to list artifacts for. In coordinator mode, defaults to the coordinator session or an authorized session within the mesh.',
            },
            mission_id: {
                type: 'string',
                description: 'Optional mission ID filter.',
            },
            limit: {
                type: 'number',
                description: 'Optional maximum number of artifacts to return (1..50).',
            },
        },
        required: [],
        additionalProperties: false,
    },
};

/**
 * Worker-mode `artifact_list` tool schema.
 *
 * Never accepts `session_id` / `task_id` — worker identity comes from the launch
 * credential, and daemon-side OD-4 filtering returns the worker's own session
 * artifacts plus the `inputArtifactIds` artifacts the coordinator named.
 */
export const WORKER_ARTIFACT_LIST_TOOL: Tool & { description: string } = {
    name: 'artifact_list',
    description:
        'List artifacts visible to this worker (its own session artifacts, plus artifacts the coordinator named in input_artifact_ids (any mission); metadata only, never raw file bytes).',
    inputSchema: {
        type: 'object',
        properties: {
            mission_id: {
                type: 'string',
                description: 'Optional mission ID filter (must match this worker task mission).',
            },
            limit: {
                type: 'number',
                description: 'Optional maximum number of artifacts to return (1..50).',
            },
        },
        required: [],
        additionalProperties: false,
    },
};

/**
 * Shared `artifact_read` tool schema (worker, coordinator, and standard mode).
 */
export const ARTIFACT_READ_TOOL: Tool & { description: string } = {
    name: 'artifact_read',
    description:
        'Read an artifact by artifact_id with 256 KiB paging (OD-7). Text/markdown/diff/json content is wrapped in <untrusted_artifact_content> tags.',
    inputSchema: {
        type: 'object',
        properties: {
            artifact_id: {
                type: 'string',
                description: 'Artifact ID (art_*) to read.',
            },
            offset: {
                type: 'number',
                description: 'Optional byte offset for paging (default 0).',
            },
            limit: {
                type: 'number',
                description: 'Optional maximum bytes to read in this page (default/max 262144 = 256 KiB).',
            },
        },
        required: ['artifact_id'],
        additionalProperties: false,
    },
};

function collectMeshAuthorizedSessionIds(ctx: MeshContext): Set<string> {
    const authorized = new Set<string>();
    const coordSessionId = trimString(ctx.coordinatorSessionId);
    if (coordSessionId) {
        authorized.add(coordSessionId);
    }
    const nodes = Array.isArray(ctx.mesh?.nodes) ? (ctx.mesh.nodes as unknown as Array<Record<string, unknown>>) : [];
    for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        for (const key of ['sessionId', 'activeSessionId', 'coordinatorSessionId']) {
            const val = trimString(node[key]);
            if (val) authorized.add(val);
        }
        for (const listKey of ['sessions', 'delegatedSessions']) {
            const list = node[listKey];
            if (!Array.isArray(list)) continue;
            for (const entry of list) {
                if (typeof entry === 'string') {
                    const trimmed = trimString(entry);
                    if (trimmed) authorized.add(trimmed);
                } else if (entry && typeof entry === 'object') {
                    const rec = entry as Record<string, unknown>;
                    for (const idKey of ['id', 'sessionId', 'runtimeSessionId']) {
                        const val = trimString(rec[idKey]);
                        if (val) authorized.add(val);
                    }
                }
            }
        }
    }
    return authorized;
}

/**
 * Worker-mode handler for `artifact_register`.
 *
 * Forwards ONLY allowlisted file metadata (`path`, optional `title`, optional `kind`)
 * plus the worker MCP server's trusted `credentials` (`bind` / `token`). Any
 * caller-supplied `workspace`, `workspaceRoot`, `sessionId`, `session_id`,
 * `targetSessionId`, `bind`, `token`, `taskId`, or `meshId` in `args` is ignored.
 */
export async function callWorkerArtifactRegister(
    transport: CommandTransport,
    credentials: WorkerCredentials,
    args: Record<string, unknown>,
): Promise<string> {
    const path = trimString(args.path);
    if (!path) {
        return JSON.stringify(
            {
                success: false,
                code: 'invalid_arguments',
                error: 'artifact_register requires a non-empty workspace-relative "path"',
            },
            null,
            2,
        );
    }

    const kind = trimString(args.kind);
    if (kind && !ARTIFACT_KIND_SET.has(kind)) {
        return JSON.stringify(
            {
                success: false,
                code: 'unsupported_artifact_kind',
                error: `Unsupported artifact kind "${kind}". Allowed kinds: ${ALLOWED_ARTIFACT_KINDS.join(', ')}`,
            },
            null,
            2,
        );
    }

    const title = typeof args.title === 'string' && args.title.trim().length > 0 ? args.title : undefined;

    const result = await transport.command('artifact_register', {
        path,
        ...(title !== undefined ? { title } : {}),
        ...(kind ? { kind } : {}),
        ...(credentials.token ? { token: credentials.token } : {}),
        ...(credentials.bind ? { bind: credentials.bind } : {}),
    });
    return JSON.stringify(result, null, 2);
}

/**
 * Coordinator-mode handler for `artifact_list`.
 *
 * Resolves the target session within the coordinator's authorized session /
 * mesh scope and queries the daemon via `ctx.transport.command('artifact_list', ...)`.
 */
export async function callCoordinatorArtifactList(
    ctx: MeshContext,
    args: { session_id?: string; mission_id?: string; limit?: number } = {},
): Promise<string> {
    await recordMeshCoordinatorToolCall(ctx, 'artifact_list');

    const requestedSessionId = trimString(args.session_id);
    const requestedMissionId = trimString(args.mission_id);
    const coordSessionId = trimString(ctx.coordinatorSessionId);
    const meshId = trimString(ctx.mesh?.id);
    const authorizedSessions = collectMeshAuthorizedSessionIds(ctx);

    if (!meshId || authorizedSessions.size === 0) {
        return JSON.stringify(
            {
                success: false,
                code: 'artifact_session_mismatch',
                error: 'Coordinator has no authorized session/project scope for artifact_list (artifact_session_mismatch)',
            },
            null,
            2,
        );
    }

    // The live roster only names sessions that are running now. A worker session that
    // already STOPPED is still part of this mesh's history, which only the daemon holds
    // (queue rows, stored artifacts), so such a session is forwarded with
    // `requireMeshMembership` and the daemon refuses it unless it belongs to `meshId`.
    const requiresDaemonMembership = Boolean(requestedSessionId && !authorizedSessions.has(requestedSessionId));

    let resolvedSessionId = requestedSessionId || coordSessionId;
    if (!resolvedSessionId) {
        resolvedSessionId = [...authorizedSessions][0];
    }

    if (!resolvedSessionId || (!requiresDaemonMembership && !authorizedSessions.has(resolvedSessionId))) {
        return JSON.stringify(
            {
                success: false,
                code: 'artifact_session_mismatch',
                error: 'Target session is outside the coordinator authorized session scope (artifact_session_mismatch)',
            },
            null,
            2,
        );
    }

    const limit =
        typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
            ? Math.trunc(args.limit)
            : undefined;

    const result = await ctx.transport.command('artifact_list', {
        sessionId: resolvedSessionId,
        ...(coordSessionId ? { callerSessionId: coordSessionId } : {}),
        meshId,
        ...(requestedMissionId ? { missionId: requestedMissionId } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(requiresDaemonMembership ? { requireMeshMembership: true } : {}),
    });
    return JSON.stringify(result, null, 2);
}

/**
 * Coordinator-mode handler for `artifact_register`.
 */
export async function callCoordinatorArtifactRegister(
    ctx: MeshContext,
    args: Record<string, unknown> = {},
): Promise<string> {
    await recordMeshCoordinatorToolCall(ctx, 'artifact_register');

    const path = trimString(args.path);
    if (!path) {
        return JSON.stringify(
            {
                success: false,
                code: 'invalid_arguments',
                error: 'artifact_register requires a non-empty workspace-relative "path"',
            },
            null,
            2,
        );
    }

    const kind = trimString(args.kind);
    if (kind && !ARTIFACT_KIND_SET.has(kind)) {
        return JSON.stringify(
            {
                success: false,
                code: 'unsupported_artifact_kind',
                error: `Unsupported artifact kind "${kind}". Allowed kinds: ${ALLOWED_ARTIFACT_KINDS.join(', ')}`,
            },
            null,
            2,
        );
    }

    const coordSessionId = trimString(ctx.coordinatorSessionId);
    const meshId = trimString(ctx.mesh?.id);
    const authorizedSessions = collectMeshAuthorizedSessionIds(ctx);
    const resolvedSessionId = coordSessionId || [...authorizedSessions][0] || '';

    if (!meshId || !resolvedSessionId) {
        return JSON.stringify(
            {
                success: false,
                code: 'artifact_session_mismatch',
                error: 'Coordinator has no authorized session/project scope for artifact_register (artifact_session_mismatch)',
            },
            null,
            2,
        );
    }

    const title = typeof args.title === 'string' && args.title.trim().length > 0 ? args.title : undefined;
    const missionId = trimString(args.mission_id) || trimString(args.missionId);

    const result = await ctx.transport.command('artifact_register', {
        path,
        ...(title !== undefined ? { title } : {}),
        ...(kind ? { kind } : {}),
        sessionId: resolvedSessionId,
        callerSessionId: resolvedSessionId,
        meshId,
        ...(missionId ? { missionId } : {}),
    });
    return JSON.stringify(result, null, 2);
}

/**
 * Coordinator-mode handler for `artifact_read`.
 */
export async function callCoordinatorArtifactRead(
    ctx: MeshContext,
    args: { artifact_id?: string; offset?: number; limit?: number } = {},
): Promise<string> {
    await recordMeshCoordinatorToolCall(ctx, 'artifact_read');

    const artifactId = trimString(args.artifact_id);
    if (!artifactId) {
        return JSON.stringify(
            {
                success: false,
                code: 'invalid_arguments',
                error: 'artifact_read requires a non-empty "artifact_id"',
            },
            null,
            2,
        );
    }

    const coordSessionId = trimString(ctx.coordinatorSessionId);
    const meshId = trimString(ctx.mesh?.id);
    const authorizedSessions = collectMeshAuthorizedSessionIds(ctx);
    const resolvedSessionId = coordSessionId || [...authorizedSessions][0] || '';

    if (!meshId || !resolvedSessionId) {
        return JSON.stringify(
            {
                success: false,
                code: 'artifact_session_mismatch',
                error: 'Coordinator has no authorized session/project scope for artifact_read (artifact_session_mismatch)',
            },
            null,
            2,
        );
    }

    const offset =
        typeof args.offset === 'number' && Number.isFinite(args.offset) && args.offset >= 0
            ? Math.trunc(args.offset)
            : undefined;
    const limit =
        typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
            ? Math.trunc(args.limit)
            : undefined;

    const result = await ctx.transport.command('artifact_read', {
        artifactId,
        callerSessionId: resolvedSessionId,
        meshId,
        ...(offset !== undefined ? { offset } : {}),
        ...(limit !== undefined ? { limit } : {}),
    });
    return JSON.stringify(result, null, 2);
}

/**
 * Worker-mode handler for `artifact_list`.
 */
export async function callWorkerArtifactList(
    transport: CommandTransport,
    credentials: WorkerCredentials,
    args: Record<string, unknown> = {},
): Promise<string> {
    const missionId = trimString(args.mission_id);
    const limit =
        typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
            ? Math.trunc(args.limit)
            : undefined;

    const result = await transport.command('artifact_list', {
        ...(missionId ? { missionId } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(credentials.token ? { token: credentials.token } : {}),
        ...(credentials.bind ? { bind: credentials.bind } : {}),
    });
    return JSON.stringify(result, null, 2);
}

/**
 * Worker-mode handler for `artifact_read`.
 */
export async function callWorkerArtifactRead(
    transport: CommandTransport,
    credentials: WorkerCredentials,
    args: Record<string, unknown> = {},
): Promise<string> {
    const artifactId = trimString(args.artifact_id);
    if (!artifactId) {
        return JSON.stringify(
            {
                success: false,
                code: 'invalid_arguments',
                error: 'artifact_read requires a non-empty "artifact_id"',
            },
            null,
            2,
        );
    }

    const offset =
        typeof args.offset === 'number' && Number.isFinite(args.offset) && args.offset >= 0
            ? Math.trunc(args.offset)
            : undefined;
    const limit =
        typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
            ? Math.trunc(args.limit)
            : undefined;

    const result = await transport.command('artifact_read', {
        artifactId,
        ...(offset !== undefined ? { offset } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(credentials.token ? { token: credentials.token } : {}),
        ...(credentials.bind ? { bind: credentials.bind } : {}),
    });
    return JSON.stringify(result, null, 2);
}

/**
 * Standard-mode handler for `artifact_read`.
 */
export async function callStandardArtifactRead(
    transport: CommandTransport,
    args: Record<string, unknown> = {},
): Promise<string> {
    const artifactId = trimString(args.artifact_id);
    if (!artifactId) {
        return JSON.stringify(
            {
                success: false,
                code: 'invalid_arguments',
                error: 'artifact_read requires a non-empty "artifact_id"',
            },
            null,
            2,
        );
    }

    const sessionId = trimString(args.session_id);
    const offset =
        typeof args.offset === 'number' && Number.isFinite(args.offset) && args.offset >= 0
            ? Math.trunc(args.offset)
            : undefined;
    const limit =
        typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
            ? Math.trunc(args.limit)
            : undefined;

    const result = await transport.command('artifact_read', {
        artifactId,
        ...(sessionId ? { sessionId } : {}),
        ...(offset !== undefined ? { offset } : {}),
        ...(limit !== undefined ? { limit } : {}),
    });
    return JSON.stringify(result, null, 2);
}

/**
 * Standard-mode handler for `artifact_register`.
 *
 * Uses the authenticated `transport.command('artifact_register', ...)` channel
 * and never forwards caller-supplied workspace root or worker credentials.
 */
export async function callStandardArtifactRegister(
    transport: CommandTransport,
    args: Record<string, unknown>,
): Promise<string> {
    const path = trimString(args.path);
    if (!path) {
        return JSON.stringify(
            {
                success: false,
                code: 'invalid_arguments',
                error: 'artifact_register requires a non-empty workspace-relative "path"',
            },
            null,
            2,
        );
    }

    const kind = trimString(args.kind);
    if (kind && !ARTIFACT_KIND_SET.has(kind)) {
        return JSON.stringify(
            {
                success: false,
                code: 'unsupported_artifact_kind',
                error: `Unsupported artifact kind "${kind}". Allowed kinds: ${ALLOWED_ARTIFACT_KINDS.join(', ')}`,
            },
            null,
            2,
        );
    }

    const title = typeof args.title === 'string' && args.title.trim().length > 0 ? args.title : undefined;
    const sessionId = trimString(args.session_id);

    const result = await transport.command('artifact_register', {
        path,
        ...(title !== undefined ? { title } : {}),
        ...(kind ? { kind } : {}),
        ...(sessionId ? { sessionId } : {}),
    });
    return JSON.stringify(result, null, 2);
}

/**
 * Standard-mode handler for `artifact_list`.
 */
export async function callStandardArtifactList(
    transport: CommandTransport,
    args: Record<string, unknown> = {},
): Promise<string> {
    const sessionId = trimString(args.session_id);
    const limit =
        typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
            ? Math.trunc(args.limit)
            : undefined;

    const result = await transport.command('artifact_list', {
        ...(sessionId ? { sessionId } : {}),
        ...(limit !== undefined ? { limit } : {}),
    });
    return JSON.stringify(result, null, 2);
}
