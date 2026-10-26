/** Reasons that end the credential lifetime, unlike a recoverable WS outage. */
export function endsPeerAuthorization(reason?: string): boolean {
    return reason !== undefined && new Set([
        'token_revoked', 'credential_rejected', 'evicted', 'force_disconnected',
        'clean_shutdown', 'version_incompatible', 'credentials_changed',
    ]).has(reason);
}
