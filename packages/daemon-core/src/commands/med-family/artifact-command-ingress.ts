/** Artifact transport admission, before authorization, I/O, forwarding or reporting. */
import { COMMAND_SOURCE_ARG, hasRevokedTrustedOwnerIngress, isTrustedOwnerIngress, readRouterCommandIngress } from '../command-args.js';
import { readAuthenticatedMcpCommand } from '../mcp-command-ingress.js';
import type { CommandRouterResult } from '../router.js';

function trimString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

export function hasWorkerCredentialInput(args: Record<string, unknown>): boolean {
    const rawBind = args?.bind;
    const rawToken = args?.token;
    return (
        (typeof rawBind === 'string' && rawBind.trim().length > 0) ||
        (typeof rawToken === 'string' && rawToken.trim().length > 0) ||
        (rawBind !== undefined && rawBind !== null) ||
        (rawToken !== undefined && rawToken !== null)
    );
}

export function verifyArtifactCommandIngress(
    args: unknown,
    mode: 'register' | 'list' | 'fetch',
):
    | { ok: true; recordArgs: Record<string, unknown>; ownerTrusted: boolean }
    | { ok: false; result: CommandRouterResult } {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return {
            ok: false,
            result: {
                success: false,
                code: 'COMMAND_SOURCE_REJECTED',
                error: 'Artifact command requires a valid object arguments reference',
            },
        };
    }
    const recordArgs = args as Record<string, unknown>;
    const routerIngress = readRouterCommandIngress(recordArgs);
    const mcp = readAuthenticatedMcpCommand(recordArgs, routerIngress?.command ?? '');
    if (mcp.present && (!mcp.valid || routerIngress?.source !== 'ipc')) {
        return {
            ok: false,
            result: { success: false, code: 'COMMAND_SOURCE_REJECTED', error: 'Artifact MCP command authority is invalid, changed, or revoked' },
        };
    }
    const expectedOwnerSource =
        routerIngress?.source === 'p2p' || routerIngress?.source === 'standalone'
            ? routerIngress.source
            : undefined;
    const ownerTrusted = isTrustedOwnerIngress(recordArgs, expectedOwnerSource);

    if (
        hasRevokedTrustedOwnerIngress(recordArgs, expectedOwnerSource) ||
        routerIngress?.hasRevokedOwnerProof
    ) {
        return {
            ok: false,
            result: {
                success: false,
                code: 'COMMAND_SOURCE_REJECTED',
                error: 'Artifact command rejected: owner ingress proof is missing, invalid, or revoked',
            },
        };
    }

    if (
        !ownerTrusted &&
        (routerIngress?.hasForgedProvenanceFields ||
            'ownerVerified' in recordArgs ||
            '_ownerVerified' in recordArgs ||
            'source' in recordArgs ||
            COMMAND_SOURCE_ARG in recordArgs)
    ) {
        return {
            ok: false,
            result: {
                success: false,
                code: 'COMMAND_SOURCE_REJECTED',
                error: 'Artifact command rejected: forged provenance fields in command payload',
            },
        };
    }

    if (!routerIngress && !ownerTrusted && '_interactionId' in recordArgs) {
        return {
            ok: false,
            result: {
                success: false,
                code: 'COMMAND_SOURCE_REJECTED',
                error: 'Artifact command rejected: cloned router arguments missing live provenance',
            },
        };
    }

    if (routerIngress) {
        if (
            routerIngress.source !== 'p2p' &&
            routerIngress.source !== 'standalone' &&
            routerIngress.source !== 'ipc'
        ) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'COMMAND_SOURCE_REJECTED',
                    error: `Artifact command is not accepted from source '${routerIngress.source}'`,
                },
            };
        }
        if (routerIngress.inProcess === true) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'COMMAND_SOURCE_REJECTED',
                    error: 'Artifact command rejected: in-process dispatch is not an authorized ingress',
                },
            };
        }
        if ((routerIngress.source === 'p2p' || routerIngress.source === 'standalone') && !ownerTrusted) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'COMMAND_SOURCE_REJECTED',
                    error: `Artifact command on '${routerIngress.source}' requires verified owner ingress`,
                },
            };
        }
        if (routerIngress.source === 'ipc' && routerIngress.ownerVerified === false) {
            return {
                ok: false,
                result: {
                    success: false,
                    code: 'COMMAND_SOURCE_REJECTED',
                    error: 'Artifact command rejected: downgraded unverified owner ingress',
                },
            };
        }
        if (routerIngress.source === 'ipc' && !ownerTrusted && !hasWorkerCredentialInput(recordArgs)) {
            if (mode === 'fetch') {
                return {
                    ok: false,
                    result: {
                        success: false,
                        code: 'COMMAND_SOURCE_REJECTED',
                        error: 'Artifact fetch over IPC requires verified owner or live worker credential',
                    },
                };
            }
            if (mode === 'list' && !mcp.valid && !trimString(recordArgs.meshId)) {
                return {
                    ok: false,
                    result: {
                        success: false,
                        code: 'COMMAND_SOURCE_REJECTED',
                        error: 'Artifact list over IPC requires verified owner, worker credential, or coordinator mesh scope',
                    },
                };
            }
        }
    }

    return { ok: true, recordArgs, ownerTrusted };
}

