import { randomBytes } from 'node:crypto';
import { sessionIdsEquivalent } from '@adhdev/mesh-shared';
import { getCoordinatorForSession } from '../mesh/coordinator-registry.js';

/**
 * An authenticated internal MCP request is not a dashboard owner. Retain only
 * its existing command authority across in-process argument copies. Capabilities
 * are specific to one artifact operation, its bound session/coordinator scope,
 * and its exact arguments; a generic credential never becomes an owner proof or
 * a reusable session/workspace grant.
 */
const ARTIFACT_COMMANDS = new Set([
    'artifact_register', 'session_artifact_register',
    'artifact_list', 'session_artifact_list',
    'artifact_read',
    'assistant_artifact_list', 'assistant_artifact_read',
]);

/**
 * Commands that are not artifact verbs but must still SEE whether an MCP session
 * (coordinator / worker / assistant) is behind the call. The capability records
 * the presented credential even when the command otherwise runs as plain `ipc`,
 * so a handler can refuse MCP-origin callers (owner-decision answers: a
 * coordinator or worker must never answer its own question).
 */
export const MCP_ATTRIBUTED_COMMANDS: ReadonlySet<string> = new Set(['mission_decision_answer']);

export interface AuthenticatedMcpScope {
    readonly sessionId?: string;
    readonly meshId?: string;
    readonly isCoordinator?: boolean;
}

interface McpSessionCredentialRecord {
    readonly token: string;
    readonly sessionId: string;
    meshId?: string;
    isCoordinator: boolean;
}

interface McpSessionCredentialStore {
    readonly byToken: Map<string, McpSessionCredentialRecord>;
    readonly bySessionId: Map<string, string>;
}

interface McpCommandCapability {
    readonly command: string;
    readonly argumentsKey: string;
    readonly verifyCurrent: () => boolean;
    readonly explicitScope: AuthenticatedMcpScope | string | null;
    revoked: boolean;
    scopeResolved?: boolean;
    workspaceRoot?: string;
    boundSessionId?: string;
    boundMeshId?: string;
    isCoordinator?: boolean;
}

const STATE_KEY = Symbol.for('adhdev.daemon-core.authenticatedMcpCommandIngress');
const shared = globalThis as Record<symbol, WeakMap<object, McpCommandCapability> | undefined>;
if (!shared[STATE_KEY]) {
    Object.defineProperty(shared, STATE_KEY, {
        value: new WeakMap<object, McpCommandCapability>(),
        enumerable: false, configurable: false, writable: false,
    });
}
const capabilities = shared[STATE_KEY]!;

const CREDENTIAL_STORE_KEY = Symbol.for('adhdev.daemon-core.mcpSessionCredentials');
const sharedCredentials = globalThis as Record<symbol, McpSessionCredentialStore | undefined>;
if (!sharedCredentials[CREDENTIAL_STORE_KEY]) {
    Object.defineProperty(sharedCredentials, CREDENTIAL_STORE_KEY, {
        value: {
            byToken: new Map<string, McpSessionCredentialRecord>(),
            bySessionId: new Map<string, string>(),
        },
        enumerable: false, configurable: false, writable: false,
    });
}
const credentialStore = sharedCredentials[CREDENTIAL_STORE_KEY]!;

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function trimString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/** Mint a fresh session-bound MCP credential, replacing any prior credential for the session. */
export function mintMcpSessionCredential(scope: {
    sessionId: string;
    meshId?: string;
    isCoordinator?: boolean;
}): string {
    const sessionId = trimString(scope.sessionId);
    if (!sessionId) {
        throw new Error('mintMcpSessionCredential requires a non-empty sessionId');
    }
    const previousToken = credentialStore.bySessionId.get(sessionId);
    if (previousToken) {
        credentialStore.byToken.delete(previousToken);
    }
    const token = `mcp_sess_${randomBytes(24).toString('base64url')}`;
    const meshId = trimString(scope.meshId) || undefined;
    const entry: McpSessionCredentialRecord = {
        token,
        sessionId,
        ...(meshId ? { meshId } : {}),
        isCoordinator: scope.isCoordinator === true,
    };
    credentialStore.byToken.set(token, entry);
    credentialStore.bySessionId.set(sessionId, token);
    return token;
}

/** Reuse an existing credential for `sessionId` (updating its scope metadata) or mint a new one. */
export function ensureMcpSessionCredential(scope: {
    sessionId: string;
    meshId?: string;
    isCoordinator?: boolean;
}): string {
    const sessionId = trimString(scope.sessionId);
    if (!sessionId) {
        throw new Error('ensureMcpSessionCredential requires a non-empty sessionId');
    }
    const existingToken = credentialStore.bySessionId.get(sessionId);
    if (existingToken) {
        const existing = credentialStore.byToken.get(existingToken);
        if (existing) {
            const meshId = trimString(scope.meshId) || undefined;
            if (meshId) existing.meshId = meshId;
            else delete existing.meshId;
            if (typeof scope.isCoordinator === 'boolean') {
                existing.isCoordinator = scope.isCoordinator;
            }
            return existingToken;
        }
    }
    return mintMcpSessionCredential(scope);
}

export function getMcpSessionCredentialForSession(sessionId: string): string | null {
    const sid = trimString(sessionId);
    if (!sid) return null;
    return credentialStore.bySessionId.get(sid) ?? null;
}

export function revokeMcpSessionCredential(sessionId: string): void {
    const sid = trimString(sessionId);
    if (!sid) return;
    const token = credentialStore.bySessionId.get(sid);
    if (token) {
        credentialStore.byToken.delete(token);
        credentialStore.bySessionId.delete(sid);
    }
}

export function __resetMcpSessionCredentialsForTest(): void {
    credentialStore.byToken.clear();
    credentialStore.bySessionId.clear();
}

/** Verify a session-bound MCP credential and return its live AuthenticatedMcpScope, or null. */
export function verifyMcpSessionCredential(credential: unknown): AuthenticatedMcpScope | null {
    const token = trimString(credential);
    if (!token) return null;
    const entry = credentialStore.byToken.get(token);
    if (!entry) return null;
    if (credentialStore.bySessionId.get(entry.sessionId) !== token) return null;
    if (entry.isCoordinator) {
        const coord = getCoordinatorForSession(entry.sessionId);
        if (!coord) return null;
        if (entry.meshId && coord.meshId !== entry.meshId) return null;
        return {
            sessionId: entry.sessionId,
            meshId: coord.meshId,
            isCoordinator: true,
        };
    }
    return {
        sessionId: entry.sessionId,
        ...(entry.meshId ? { meshId: entry.meshId } : {}),
        isCoordinator: false,
    };
}

function hasWorkerCredentialFields(args: Record<string, unknown>): boolean {
    const rawBind = args?.bind;
    const rawToken = args?.token;
    return (
        (typeof rawBind === 'string' && rawBind.trim().length > 0) ||
        (typeof rawToken === 'string' && rawToken.trim().length > 0) ||
        (rawBind !== undefined && rawBind !== null) ||
        (rawToken !== undefined && rawToken !== null)
    );
}

function resolveBoundMcpScope(
    args: Record<string, unknown>,
    command: string,
    explicitScope: AuthenticatedMcpScope | string | null | undefined,
): { validScope: boolean; boundSessionId?: string; boundMeshId?: string; isCoordinator?: boolean } {
    if (explicitScope === undefined || explicitScope === null) {
        return { validScope: false };
    }
    const scopeObj = typeof explicitScope === 'string' ? { sessionId: explicitScope } : explicitScope;
    const boundSessionId = trimString(scopeObj.sessionId);
    const isWorkerScoped = scopeObj.isCoordinator === false && hasWorkerCredentialFields(args);
    if (!boundSessionId && !isWorkerScoped) {
        return { validScope: false };
    }

    const isAssistantCmd = command === 'assistant_artifact_list' || command === 'assistant_artifact_read'
        // attribution-only verb: resolve the session-bound principal; the handler decides who may pass
        || MCP_ATTRIBUTED_COMMANDS.has(command);
    if (isAssistantCmd) {
        if (!boundSessionId || scopeObj.isCoordinator === true || hasWorkerCredentialFields(args)) {
            return { validScope: false };
        }
        const payloadAssistantSid = trimString(args.assistantSessionId) || trimString(args.assistant_session_id);
        if (payloadAssistantSid && !sessionIdsEquivalent(payloadAssistantSid, boundSessionId)) {
            return { validScope: false };
        }
        return { validScope: true, boundSessionId, isCoordinator: false };
    }

    const payloadSessionId = trimString(args.sessionId) || trimString(args.targetSessionId);
    const payloadCallerSessionId = trimString(args.callerSessionId);
    const payloadMeshId = trimString(args.meshId);
    const isListCmd = command === 'artifact_list' || command === 'session_artifact_list';

    const coord = boundSessionId ? getCoordinatorForSession(boundSessionId) : undefined;
    const boundMeshId =
        trimString(scopeObj.meshId) ||
        (scopeObj.isCoordinator !== false ? coord?.meshId : undefined) ||
        undefined;
    const isCoordinator =
        typeof scopeObj.isCoordinator === 'boolean'
            ? scopeObj.isCoordinator && Boolean(coord && (!boundMeshId || coord.meshId === boundMeshId))
            : Boolean(coord && (!boundMeshId || coord.meshId === boundMeshId));

    if (boundSessionId) {
        if (payloadCallerSessionId && !sessionIdsEquivalent(payloadCallerSessionId, boundSessionId)) {
            return { validScope: false };
        }
        if (payloadMeshId && (!boundMeshId || payloadMeshId !== boundMeshId)) {
            return { validScope: false };
        }
        if (!isCoordinator && payloadMeshId && !hasWorkerCredentialFields(args)) {
            return { validScope: false };
        }
        if (
            payloadSessionId &&
            !sessionIdsEquivalent(payloadSessionId, boundSessionId) &&
            !(isCoordinator && isListCmd)
        ) {
            return { validScope: false };
        }
    }
    return {
        validScope: true,
        boundSessionId: boundSessionId || payloadSessionId || undefined,
        boundMeshId: boundMeshId || (isWorkerScoped ? payloadMeshId || undefined : undefined),
        isCoordinator,
    };
}

function argumentsKey(args: Record<string, unknown>): string {
    // The host adds only this correlation id. Every authority/file/operation
    // field remains bound; JSON serialization or spread does not copy the map.
    const sessionAlias = typeof args.sessionId === 'string' ? args.sessionId.trim() : undefined;
    return JSON.stringify(Object.keys(args).filter(key => key !== '_interactionId' && key !== '_commandSource' // router-stamped (command-args.ts COMMAND_SOURCE_ARG)
        && !(key === 'targetSessionId' && sessionAlias && args[key] === sessionAlias)).sort()
        .map(key => [key, args[key]]));
}

/** Called only by the authenticated daemon HTTP entry, never from wire fields. */
export function attachAuthenticatedMcpCommand<T extends Record<string, unknown>>(
    args: T,
    command: string,
    verifyCurrent: () => boolean,
    scope: AuthenticatedMcpScope | string | null,
): T {
    if (!(ARTIFACT_COMMANDS.has(command) || MCP_ATTRIBUTED_COMMANDS.has(command)) || typeof verifyCurrent !== 'function') return args;
    let live = false;
    try { live = verifyCurrent() === true; } catch { /* fail closed */ }
    const bound = resolveBoundMcpScope(args, command, scope);
    // Retain a denial too: expiry or scope conflict between verification and
    // attachment cannot erase provenance and turn the request into ordinary IPC.
    capabilities.set(args, {
        command,
        argumentsKey: argumentsKey(args),
        verifyCurrent,
        explicitScope: scope,
        revoked: !live || !bound.validScope,
        scopeResolved: bound.validScope,
        boundSessionId: bound.boundSessionId,
        boundMeshId: bound.boundMeshId,
        isCoordinator: bound.isCoordinator,
    });
    return args;
}

export function preserveAuthenticatedMcpCommand<T extends Record<string, unknown>>(
    source: unknown, target: T,
): T {
    if (record(source)) {
        const capability = capabilities.get(source);
        // Retain revoked capabilities too: copying must not downgrade them to
        // ordinary IPC and accidentally authorize a different path.
        if (capability) capabilities.set(target, capability);
    }
    return target;
}

export function readAuthenticatedMcpCommand(
    args: unknown, command: string,
): { present: boolean; valid: boolean } {
    const capability = record(args) ? capabilities.get(args) : undefined;
    if (!capability) return { present: false, valid: false };
    if (capability.revoked) return { present: true, valid: false };
    const effectiveCommand = command || capability.command;
    try {
        if (capability.verifyCurrent() !== true) {
            capability.revoked = true;
            return { present: true, valid: false };
        }
        if (capability.command !== effectiveCommand || !record(args) || capability.argumentsKey !== argumentsKey(args)) {
            return { present: true, valid: false };
        }
        if (!capability.scopeResolved) {
            const bound = resolveBoundMcpScope(args, capability.command, capability.explicitScope);
            if (!bound.validScope) {
                capability.revoked = true;
                return { present: true, valid: false };
            }
            capability.scopeResolved = true;
            capability.boundSessionId = bound.boundSessionId;
            capability.boundMeshId = bound.boundMeshId;
            capability.isCoordinator = bound.isCoordinator;
        }
        return {
            present: true,
            valid: !capability.revoked,
        };
    } catch { capability.revoked = true; return { present: true, valid: false }; }
}

export function readAuthenticatedMcpScope(
    args: unknown, command?: string,
): AuthenticatedMcpScope | null {
    const capability = record(args) ? capabilities.get(args) : undefined;
    if (!capability) return null;
    if (!readAuthenticatedMcpCommand(args, command || capability.command).valid) return null;
    return {
        ...(capability.boundSessionId ? { sessionId: capability.boundSessionId } : {}),
        ...(capability.boundMeshId ? { meshId: capability.boundMeshId } : {}),
        isCoordinator: Boolean(capability.isCoordinator),
    };
}

/** Bind the already-authorized registered workspace before any artifact I/O. */
export function bindAuthenticatedMcpWorkspace(args: unknown, workspaceRoot: string): boolean {
    const capability = record(args) ? capabilities.get(args) : undefined;
    if (!capability) return true;
    if (!readAuthenticatedMcpCommand(args, capability.command).valid) return false;
    if (!workspaceRoot && capability.isCoordinator) return true;
    if (!workspaceRoot) return false;
    if (capability.workspaceRoot === undefined) capability.workspaceRoot = workspaceRoot;
    return capability.workspaceRoot === workspaceRoot;
}
