/**
 * Shared "attach MCP authority to one command" primitives.
 *
 * Both transports that serve daemon-launched MCP servers use the SAME
 * verification and capability code, so the trust model cannot drift:
 *  - daemon-standalone HTTP (`standalone-http.ts`) takes the credentials from
 *    request headers (after its loopback + per-boot token gate);
 *  - the cloud daemon's local IPC WebSocket takes them from the `mcpAuth`
 *    envelope of the `ext:command` frame (`attachIpcMcpAuthority`).
 *
 * Nothing here trusts a payload-supplied id: authority is whatever the
 * credential store / worker registries resolve for the presented secret, and
 * `attachAuthenticatedMcpCommand` re-checks it (and the argument shape) when
 * the artifact ingress finally reads it. A missing, unknown, revoked or
 * ambiguous credential never raises authority: on an artifact verb it attaches
 * a DENIED capability (the command is refused), on every other verb the frame
 * runs exactly as a credential-less `ipc` command does today.
 */
import { attachAuthenticatedMcpCommand, verifyMcpSessionCredential } from './mcp-command-ingress.js';
import {
    isLiveWorkerMcpCredential,
    matchesLiveArtifactWorkerCredential,
    resolveLiveArtifactWorkerScope,
} from '../standalone-mcp-auth-verify.js';
import { isWorkerMcpDaemonVerb } from '../standalone-mcp-auth.js';

/** Max accepted credential length on the wire (real tokens are < 100 chars). */
const MAX_CREDENTIAL_LENGTH = 512;

const WORKER_ARTIFACT_COMMANDS: ReadonlySet<string> = new Set(['artifact_register', 'artifact_list', 'artifact_read']);

/** Session-bound (coordinator / assistant / CLI session) authority for one command. */
export function attachSessionMcpAuthority(
    args: Record<string, unknown>,
    command: string,
    credential: string,
    /** Transport-specific liveness (standalone: boot token + epoch; IPC: socket open). */
    extraLive?: () => boolean,
): void {
    const boundScope = verifyMcpSessionCredential(credential);
    attachAuthenticatedMcpCommand(
        args,
        command,
        () => (extraLive ? extraLive() === true : true) && verifyMcpSessionCredential(credential) !== null,
        boundScope,
    );
}

export type WorkerArtifactAttachResult =
    | { ok: true }
    | { ok: false; reason: 'credential_mismatch' | 'no_live_scope' };

/** Worker bind/token authority for the worker artifact verbs. */
export function attachWorkerArtifactMcpAuthority(
    args: Record<string, unknown>,
    command: string,
    credential: string,
    opts: {
        verify?: (credential: string, args: Record<string, unknown>) => boolean;
        /** Must resolve against the same registries as `verify` (embedding boundaries). */
        resolveScope?: typeof resolveLiveArtifactWorkerScope;
        extraLive?: () => boolean;
    } = {},
): WorkerArtifactAttachResult {
    const verify = opts.verify ?? matchesLiveArtifactWorkerCredential;
    let matches = false;
    try { matches = verify(credential, args) === true; } catch { /* fail closed */ }
    if (!matches) return { ok: false, reason: 'credential_mismatch' };
    const workerScope = (opts.resolveScope ?? resolveLiveArtifactWorkerScope)(credential, args);
    if (!workerScope) return { ok: false, reason: 'no_live_scope' };
    attachAuthenticatedMcpCommand(
        args,
        command,
        () => (opts.extraLive ? opts.extraLive() === true : true) && verify(credential, args) === true,
        workerScope,
    );
    return { ok: true };
}

/** The `mcpAuth` envelope of a local-IPC `ext:command` frame (never part of `args`). */
export interface IpcMcpAuthEnvelope {
    sessionCredential?: string;
    workerCredential?: string;
}

/** Sanitize the untrusted envelope: strings only, trimmed, bounded. `null` = nothing presented. */
export function readIpcMcpAuthEnvelope(payload: unknown): IpcMcpAuthEnvelope | null {
    if (!payload || typeof payload !== 'object') return null;
    const raw = (payload as Record<string, unknown>).mcpAuth;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const pick = (value: unknown): string | undefined => {
        if (typeof value !== 'string') return undefined;
        const v = value.trim();
        return v && v.length <= MAX_CREDENTIAL_LENGTH ? v : undefined;
    };
    const e = raw as Record<string, unknown>;
    const sessionCredential = pick(e.sessionCredential);
    const workerCredential = pick(e.workerCredential);
    if (!sessionCredential && !workerCredential) return null;
    return {
        ...(sessionCredential ? { sessionCredential } : {}),
        ...(workerCredential ? { workerCredential } : {}),
    };
}

export type IpcMcpAttachResult =
    | { ok: true }
    | { ok: false; code: 'worker_scope_forbidden'; error: string };

/**
 * Attach MCP authority to `args` (the object later handed to `host.execute`)
 * from a local-IPC envelope. `isConnectionLive` ties the capability to the
 * socket that presented the credential.
 */
export function attachIpcMcpAuthority(
    args: Record<string, unknown>,
    command: string,
    envelope: IpcMcpAuthEnvelope | null,
    isConnectionLive: () => boolean = () => true,
): IpcMcpAttachResult {
    if (!envelope) return { ok: true };
    const { sessionCredential, workerCredential } = envelope;
    if (sessionCredential && workerCredential) {
        // Ambiguous principal (standalone answers 401 to both headers): no authority.
        attachAuthenticatedMcpCommand(args, command, () => false, null);
        return { ok: true };
    }
    if (sessionCredential) {
        attachSessionMcpAuthority(args, command, sessionCredential, isConnectionLive);
        return { ok: true };
    }
    const credential = workerCredential as string;
    let live = false;
    try { live = isLiveWorkerMcpCredential(credential); } catch { /* fail closed */ }
    if (!live) {
        attachAuthenticatedMcpCommand(args, command, () => false, null);
        return { ok: true };
    }
    // A live worker credential admits only the worker toolset's verbs (same as standalone).
    if (!isWorkerMcpDaemonVerb(command)) {
        return { ok: false, code: 'worker_scope_forbidden', error: `Command ${command} is not available to a worker MCP credential.` };
    }
    if (WORKER_ARTIFACT_COMMANDS.has(command)) {
        const attached = attachWorkerArtifactMcpAuthority(args, command, credential, { extraLive: isConnectionLive });
        if (!attached.ok) {
            attachAuthenticatedMcpCommand(args, command, () => false, null);
        }
    }
    return { ok: true };
}
