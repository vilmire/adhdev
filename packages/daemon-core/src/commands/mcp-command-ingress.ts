import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { sessionIdsEquivalent } from '@adhdev/mesh-shared';
import { getCoordinatorForSession } from '../mesh/coordinator-registry.js';
import {
    FileMcpSessionCredentialStore,
    type McpSessionCredentialPersistence,
    type PersistedMcpSessionCredential,
} from './mcp-session-credential-store.js';

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
export const MCP_ATTRIBUTED_COMMANDS: ReadonlySet<string> = new Set(['mission_decision_answer', 'mission_live_check_resolve']);

/**
 * Release-object commands (design 2026-11-01-release-objects §4): the coordinator, owner and
 * assistant may call them, a worker may not. Unlike {@link MCP_ATTRIBUTED_COMMANDS} the
 * coordinator keeps its coordinator scope (the handler reads `isCoordinator` / `meshId`); any
 * worker credential is recorded as a DENIED capability.
 */
export const MCP_ROLE_CLASSIFIED_COMMANDS: ReadonlySet<string> = new Set([
    'release_upsert', 'release_scope', 'release_list', 'release_record_deploy', 'release_changelog_draft',
    'project_transfer_agent',
]);

export interface AuthenticatedMcpScope {
    readonly sessionId?: string;
    readonly meshId?: string;
    readonly isCoordinator?: boolean;
}

interface McpSessionCredentialRecord {
    readonly tokenHash: string;
    /** Raw secret. Set at mint and again when the child presents the token. Never persisted. */
    token?: string;
    readonly sessionId: string;
    meshId?: string;
    isCoordinator: boolean;
    mintedAtMs: number;
}

interface McpSessionCredentialStore {
    readonly byToken: Map<string, McpSessionCredentialRecord>;
    readonly byHash: Map<string, McpSessionCredentialRecord>;
    /** sessionId → tokenHash. */
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
            byHash: new Map<string, McpSessionCredentialRecord>(),
            bySessionId: new Map<string, string>(),
        },
        enumerable: false, configurable: false, writable: false,
    });
}
const credentialStore = sharedCredentials[CREDENTIAL_STORE_KEY]!;
// A process that loaded an older store shape has no hash index. Keep it present.
if (!credentialStore.byHash) {
    (credentialStore as { byHash: Map<string, McpSessionCredentialRecord> }).byHash = new Map();
}

let credentialPersistence: McpSessionCredentialPersistence | null = null;
let credentialPersistenceTestOwned = false;

/** SHA-256 hex of a session credential. This is the only form written to disk. */
export function hashMcpSessionCredential(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Install the 0600 hash file under `configDir`. Tests that inject a store keep
 * it; this never replaces a test-owned port and never writes the raw token.
 */
export function installMcpSessionCredentialFilePersistence(configDir: string): void {
    if (credentialPersistenceTestOwned) return;
    const dir = trimString(configDir);
    if (!dir) return;
    credentialPersistence = new FileMcpSessionCredentialStore(join(dir, 'mcp-session-credentials.json'));
}

/** @internal Vitest injects a temp store. Production boot uses the file port above. */
export function __setMcpSessionCredentialPersistenceForTest(port: McpSessionCredentialPersistence | null): void {
    credentialPersistence = port;
    credentialPersistenceTestOwned = port !== null;
}

function persistCredential(entry: McpSessionCredentialRecord): void {
    if (!credentialPersistence) return;
    const row: PersistedMcpSessionCredential = {
        tokenHash: entry.tokenHash,
        sessionId: entry.sessionId,
        ...(entry.meshId ? { meshId: entry.meshId } : {}),
        isCoordinator: entry.isCoordinator,
        mintedAtMs: entry.mintedAtMs,
    };
    try {
        credentialPersistence.put(row);
        // put() replaces every row of this session, so the stale hash is gone.
        undeletedRevocations.delete(entry.sessionId);
    } catch { /* best-effort: memory stays authoritative */ }
}

/**
 * Sessions whose persisted hash could not be deleted (full disk, EACCES). A
 * revoked credential must not come back from the file: these sessions are never
 * re-adopted from persistence, and the delete is retried on the next write.
 */
const undeletedRevocations = new Set<string>();

function deletePersistedCredential(sessionId: string): void {
    if (!credentialPersistence) return;
    undeletedRevocations.add(sessionId);
    for (const pending of [...undeletedRevocations]) {
        try {
            credentialPersistence.deleteBySession(pending);
            undeletedRevocations.delete(pending);
        } catch { /* stays tombstoned for this process; retried on the next revoke */ }
    }
}

function persistedCredential(sessionId: string): PersistedMcpSessionCredential | null {
    if (!credentialPersistence || undeletedRevocations.has(sessionId)) return null;
    try { return credentialPersistence.getBySession(sessionId); } catch { return null; }
}

function persistedCredentialByHash(tokenHash: string): PersistedMcpSessionCredential | null {
    if (!credentialPersistence) return null;
    try {
        const row = credentialPersistence.getByHash(tokenHash);
        return row && !undeletedRevocations.has(row.sessionId) ? row : null;
    } catch { return null; }
}

function adoptPersistedCredential(row: PersistedMcpSessionCredential): McpSessionCredentialRecord {
    const current = credentialStore.bySessionId.get(row.sessionId);
    if (current && current !== row.tokenHash) {
        throw new Error('mcp session credential hash does not match the live session binding');
    }
    const entry: McpSessionCredentialRecord = {
        tokenHash: row.tokenHash,
        sessionId: row.sessionId,
        ...(row.meshId ? { meshId: row.meshId } : {}),
        isCoordinator: row.isCoordinator,
        mintedAtMs: row.mintedAtMs,
    };
    credentialStore.byHash.set(entry.tokenHash, entry);
    credentialStore.bySessionId.set(entry.sessionId, entry.tokenHash);
    return entry;
}

function recallCredential(sessionId: string): McpSessionCredentialRecord | null {
    const hash = credentialStore.bySessionId.get(sessionId);
    if (hash) {
        const live = credentialStore.byHash.get(hash);
        if (live) return live;
    }
    const row = persistedCredential(sessionId);
    if (!row) return null;
    try { return adoptPersistedCredential(row); } catch { return null; }
}

function dropCredential(sessionId: string): void {
    const hash = credentialStore.bySessionId.get(sessionId);
    if (hash) {
        const entry = credentialStore.byHash.get(hash);
        if (entry?.token) credentialStore.byToken.delete(entry.token);
        credentialStore.byHash.delete(hash);
        credentialStore.bySessionId.delete(sessionId);
    }
    deletePersistedCredential(sessionId);
}

function applyCredentialScope(entry: McpSessionCredentialRecord, scope: {
    meshId?: string;
    isCoordinator?: boolean;
}): void {
    const meshId = trimString(scope.meshId) || undefined;
    if (meshId) entry.meshId = meshId;
    else delete entry.meshId;
    if (typeof scope.isCoordinator === 'boolean') entry.isCoordinator = scope.isCoordinator;
    persistCredential(entry);
}

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
    dropCredential(sessionId);
    const token = `mcp_sess_${randomBytes(24).toString('base64url')}`;
    const meshId = trimString(scope.meshId) || undefined;
    const entry: McpSessionCredentialRecord = {
        tokenHash: hashMcpSessionCredential(token),
        token,
        sessionId,
        ...(meshId ? { meshId } : {}),
        isCoordinator: scope.isCoordinator === true,
        mintedAtMs: Date.now(),
    };
    credentialStore.byToken.set(token, entry);
    credentialStore.byHash.set(entry.tokenHash, entry);
    credentialStore.bySessionId.set(sessionId, entry.tokenHash);
    persistCredential(entry);
    return token;
}

/**
 * Reuse the session's credential, or mint one when this session has never had one.
 * A restarted daemon that only has the persisted hash adopts it and returns null:
 * minting would invalidate the MCP child that still holds the original token.
 * Explicit {@link mintMcpSessionCredential} still rotates.
 */
export function ensureMcpSessionCredential(scope: {
    sessionId: string;
    meshId?: string;
    isCoordinator?: boolean;
}): string | null {
    const sessionId = trimString(scope.sessionId);
    if (!sessionId) {
        throw new Error('ensureMcpSessionCredential requires a non-empty sessionId');
    }
    const existing = recallCredential(sessionId);
    if (existing) {
        applyCredentialScope(existing, scope);
        return existing.token ?? null;
    }
    return mintMcpSessionCredential(scope);
}

export function getMcpSessionCredentialForSession(sessionId: string): string | null {
    const sid = trimString(sessionId);
    if (!sid) return null;
    return recallCredential(sid)?.token ?? null;
}

export function revokeMcpSessionCredential(sessionId: string): void {
    const sid = trimString(sessionId);
    if (!sid) return;
    dropCredential(sid);
}

export function __resetMcpSessionCredentialsForTest(): void {
    undeletedRevocations.clear();
    credentialStore.byToken.clear();
    credentialStore.byHash.clear();
    credentialStore.bySessionId.clear();
    if (credentialPersistenceTestOwned && credentialPersistence) {
        try { credentialPersistence.deleteAll(); } catch { /* test store */ }
    }
}

/** Drop in-memory tokens without deleting the persisted hashes. Simulates a daemon restart. */
export function __forgetMcpSessionCredentialMemoryForTest(): void {
    credentialStore.byToken.clear();
    credentialStore.byHash.clear();
    credentialStore.bySessionId.clear();
}

/** Verify a session-bound MCP credential and return its live AuthenticatedMcpScope, or null. */
export function verifyMcpSessionCredential(credential: unknown): AuthenticatedMcpScope | null {
    const token = trimString(credential);
    if (!token) return null;
    let entry = credentialStore.byToken.get(token);
    if (!entry) {
        const tokenHash = hashMcpSessionCredential(token);
        entry = credentialStore.byHash.get(tokenHash);
        if (!entry) {
            const row = persistedCredentialByHash(tokenHash);
            if (!row) return null;
            const current = credentialStore.bySessionId.get(row.sessionId);
            if (current && current !== row.tokenHash) return null;
            try { entry = adoptPersistedCredential(row); } catch { return null; }
        }
        if (!entry) return null;
        entry.token = token;
        credentialStore.byToken.set(token, entry);
    }
    if (credentialStore.bySessionId.get(entry.sessionId) !== entry.tokenHash) return null;
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

    if (MCP_ROLE_CLASSIFIED_COMMANDS.has(command)) {
        // Session-bound principals only (coordinator / assistant); the handler classifies the role.
        if (!boundSessionId || hasWorkerCredentialFields(args)) return { validScope: false };
        const roleCoord = getCoordinatorForSession(boundSessionId);
        const isCoordinator = scopeObj.isCoordinator !== false && Boolean(roleCoord);
        return {
            validScope: true,
            boundSessionId,
            boundMeshId: (isCoordinator ? roleCoord?.meshId : undefined) || trimString(scopeObj.meshId) || undefined,
            isCoordinator,
        };
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
    return JSON.stringify(Object.keys(args).filter(key => key !== '_interactionId' && key !== '_commandSource' && key !== '_unverifiedDashboardInput' // router-stamped (command-args.ts COMMAND_SOURCE_ARG)
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
    if (!(ARTIFACT_COMMANDS.has(command) || MCP_ATTRIBUTED_COMMANDS.has(command) || MCP_ROLE_CLASSIFIED_COMMANDS.has(command)) || typeof verifyCurrent !== 'function') return args;
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
