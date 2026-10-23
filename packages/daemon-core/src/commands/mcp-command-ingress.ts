import { sessionIdsEquivalent } from '@adhdev/mesh-shared';
import { getCoordinatorForSession, listCoordinatorsForMesh } from '../mesh/coordinator-registry.js';

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
]);

export interface AuthenticatedMcpScope {
    readonly sessionId?: string;
    readonly meshId?: string;
    readonly isCoordinator?: boolean;
}

interface McpCommandCapability {
    readonly command: string;
    readonly argumentsKey: string;
    readonly verifyCurrent: () => boolean;
    readonly explicitScope?: AuthenticatedMcpScope | string;
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

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function trimString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
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
    explicitScope?: AuthenticatedMcpScope | string,
): { validScope: boolean; boundSessionId?: string; boundMeshId?: string; isCoordinator?: boolean } {
    const payloadSessionId = trimString(args.sessionId) || trimString(args.targetSessionId);
    const payloadCallerSessionId = trimString(args.callerSessionId);
    const payloadMeshId = trimString(args.meshId);
    const isListCmd = command === 'artifact_list' || command === 'session_artifact_list';

    if (explicitScope !== undefined) {
        const scopeObj = typeof explicitScope === 'string' ? { sessionId: explicitScope } : (explicitScope ?? {});
        const boundSessionId = trimString(scopeObj.sessionId);
        const coord = boundSessionId ? getCoordinatorForSession(boundSessionId) : undefined;
        const boundMeshId = trimString(scopeObj.meshId) || coord?.meshId || undefined;
        const isCoordinator =
            typeof scopeObj.isCoordinator === 'boolean'
                ? scopeObj.isCoordinator && Boolean(coord && (!boundMeshId || coord.meshId === boundMeshId))
                : Boolean(coord && (!boundMeshId || coord.meshId === boundMeshId));
        if (!boundSessionId && !hasWorkerCredentialFields(args)) return { validScope: false };
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
        return { validScope: true, boundSessionId: boundSessionId || undefined, boundMeshId, isCoordinator };
    }

    if (hasWorkerCredentialFields(args)) {
        return {
            validScope: true,
            boundSessionId: payloadSessionId || undefined,
            boundMeshId: payloadMeshId || undefined,
            isCoordinator: false,
        };
    }

    if (payloadMeshId) {
        if (isListCmd) {
            let coord = payloadCallerSessionId ? getCoordinatorForSession(payloadCallerSessionId) : undefined;
            if (payloadCallerSessionId && (!coord || coord.meshId !== payloadMeshId)) {
                return { validScope: false };
            }
            if (!coord && payloadSessionId) {
                const bySession = getCoordinatorForSession(payloadSessionId);
                if (bySession?.meshId === payloadMeshId) coord = bySession;
            }
            if (!coord) {
                coord = listCoordinatorsForMesh(payloadMeshId)[0];
            }
            if (!coord || coord.meshId !== payloadMeshId) return { validScope: false };
            return { validScope: true, boundSessionId: coord.sessionId, boundMeshId: coord.meshId, isCoordinator: true };
        }
        const coordId = payloadCallerSessionId || payloadSessionId;
        const coord = coordId ? getCoordinatorForSession(coordId) : undefined;
        if (!coord || coord.meshId !== payloadMeshId) return { validScope: false };
        if (payloadSessionId && !sessionIdsEquivalent(payloadSessionId, coord.sessionId)) {
            return { validScope: false };
        }
        return { validScope: true, boundSessionId: coord.sessionId, boundMeshId: coord.meshId, isCoordinator: true };
    }

    if (payloadCallerSessionId && payloadSessionId && !sessionIdsEquivalent(payloadCallerSessionId, payloadSessionId)) {
        return { validScope: false };
    }
    const sid = payloadSessionId || payloadCallerSessionId;
    if (!sid) return { validScope: false };
    const coord = getCoordinatorForSession(sid);
    if (payloadCallerSessionId && !coord) return { validScope: false };
    return { validScope: true, boundSessionId: sid, boundMeshId: coord?.meshId, isCoordinator: Boolean(coord) };
}

function argumentsKey(args: Record<string, unknown>): string {
    // The host adds only this correlation id. Every authority/file/operation
    // field remains bound; JSON serialization or spread does not copy the map.
    const sessionAlias = typeof args.sessionId === 'string' ? args.sessionId.trim() : undefined;
    return JSON.stringify(Object.keys(args).filter(key => key !== '_interactionId'
        && !(key === 'targetSessionId' && sessionAlias && args[key] === sessionAlias)).sort()
        .map(key => [key, args[key]]));
}

/** Called only by the authenticated daemon HTTP entry, never from wire fields. */
export function attachAuthenticatedMcpCommand<T extends Record<string, unknown>>(
    args: T,
    command: string,
    verifyCurrent: () => boolean,
    scope?: AuthenticatedMcpScope | string,
): T {
    if (!ARTIFACT_COMMANDS.has(command) || typeof verifyCurrent !== 'function') return args;
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
        revoked: !live || (scope !== undefined && !bound.validScope),
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
