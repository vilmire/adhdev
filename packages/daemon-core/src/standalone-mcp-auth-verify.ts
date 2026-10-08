/**
 * Worker-scope credential check for the standalone HTTP gate — see
 * standalone-mcp-auth.ts for the contract.
 */
import { verifyWorkerSessionBind } from './worker-session-bind-registry.js';
import { verifyWorkerTaskToken } from './mesh/worker-mcp-isolation.js';

/**
 * True when `credential` is a live worker session bind (including one
 * persisted before a restart whose session came back) or a live per-task
 * worker token. Fail-closed for anything else.
 */
export function isLiveWorkerMcpCredential(credential: unknown): boolean {
    if (typeof credential !== 'string' || !credential.trim()) return false;
    return !!verifyWorkerSessionBind(credential) || !!verifyWorkerTaskToken(credential);
}
