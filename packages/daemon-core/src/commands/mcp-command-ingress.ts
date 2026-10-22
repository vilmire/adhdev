/**
 * An authenticated internal MCP request is not a dashboard owner. Retain only
 * its existing command authority across in-process argument copies. Capabilities
 * are specific to one artifact operation and its exact arguments; a generic
 * credential never becomes an owner proof or a reusable session/workspace grant.
 */
const ARTIFACT_COMMANDS = new Set([
    'artifact_register', 'session_artifact_register',
    'artifact_list', 'session_artifact_list',
    'artifact_read', 'artifact_fetch', 'session_artifact_fetch',
]);

interface McpCommandCapability {
    readonly command: string;
    readonly argumentsKey: string;
    readonly verifyCurrent: () => boolean;
    revoked: boolean;
    workspaceRoot?: string;
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
): T {
    if (!ARTIFACT_COMMANDS.has(command) || typeof verifyCurrent !== 'function') return args;
    let live = false;
    try { live = verifyCurrent() === true; } catch { /* fail closed */ }
    // Retain a denial too: expiry between verification and attachment cannot
    // erase provenance and turn the request into ordinary IPC.
    capabilities.set(args, { command, argumentsKey: argumentsKey(args), verifyCurrent, revoked: !live });
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
    try {
        if (capability.verifyCurrent() !== true) capability.revoked = true;
        return {
            present: true,
            valid: capability.command === command && record(args)
                && capability.argumentsKey === argumentsKey(args)
                && !capability.revoked,
        };
    } catch { capability.revoked = true; return { present: true, valid: false }; }
}

/** Bind the already-authorized registered workspace before any artifact I/O. */
export function bindAuthenticatedMcpWorkspace(args: unknown, workspaceRoot: string): boolean {
    const capability = record(args) ? capabilities.get(args) : undefined;
    if (!capability) return true;
    if (!workspaceRoot || !readAuthenticatedMcpCommand(args, capability.command).valid) return false;
    if (capability.workspaceRoot === undefined) capability.workspaceRoot = workspaceRoot;
    return capability.workspaceRoot === workspaceRoot;
}
