/**
 * Worker-scope credential check for the standalone HTTP gate — see
 * standalone-mcp-auth.ts for the contract.
 */
import { verifyWorkerSessionBind } from './worker-session-bind-registry.js';
import { verifyWorkerTaskToken } from './mesh/worker-mcp-isolation.js';
import { sessionIdsEquivalent } from '@adhdev/mesh-shared';

/**
 * True when `credential` is a live worker session bind (including one
 * persisted before a restart whose session came back) or a live per-task
 * worker token. Fail-closed for anything else.
 */
export function isLiveWorkerMcpCredential(credential: unknown): boolean {
    if (typeof credential !== 'string' || !credential.trim()) return false;
    return !!verifyWorkerSessionBind(credential) || !!verifyWorkerTaskToken(credential);
}

/** Bind artifact arguments to the credential that authenticated this HTTP request. */
export function matchesLiveArtifactWorkerCredential(
    credential: string,
    args: Record<string, unknown>,
): boolean {
    const headerBind = verifyWorkerSessionBind(credential);
    const headerToken = headerBind ? null : verifyWorkerTaskToken(credential);
    const principal = headerBind ?? headerToken;
    if (!principal?.sessionId) return false;
    if (headerBind ? args.bind !== credential : args.token !== credential) return false;
    const bind = args.bind == null ? null : verifyWorkerSessionBind(args.bind);
    const token = args.token == null ? null : verifyWorkerTaskToken(args.token);
    if ((args.bind != null && !bind) || (args.token != null && !token)) return false;
    // A second credential must name the SAME principal. Keep both arguments:
    // the artifact consumer must still fence their task/attempt against the
    // actual current queue and ledger, rather than silently dropping a token.
    return [bind, token].every(value => !value || (
        value.meshId === principal.meshId && typeof value.sessionId === 'string'
        && sessionIdsEquivalent(value.sessionId, principal.sessionId!)
    ));
}

/** Resolve the verified session/mesh scope for a live worker artifact MCP request. */
export function resolveLiveArtifactWorkerScope(
    credential: string,
    args: Record<string, unknown>,
): { sessionId: string; meshId?: string; isCoordinator: false } | null {
    if (!matchesLiveArtifactWorkerCredential(credential, args)) return null;
    const headerBind = verifyWorkerSessionBind(credential);
    const headerToken = headerBind ? null : verifyWorkerTaskToken(credential);
    const principal = headerBind ?? headerToken;
    if (!principal?.sessionId) return null;
    return {
        sessionId: principal.sessionId,
        ...(typeof principal.meshId === 'string' && principal.meshId.trim()
            ? { meshId: principal.meshId.trim() }
            : {}),
        isCoordinator: false,
    };
}
