/**
 * Maps daemon artifact-fetch failures to a localized message key. Pure: the tab
 * resolves the key through i18n and keeps the raw reason for a tooltip.
 */
export type ArtifactOpenErrorKey =
    | 'mesh.obs.artifactsErrNotFound'
    | 'mesh.obs.artifactsErrWorkspaceGone'
    | 'mesh.obs.artifactsErrMismatch'
    | 'mesh.obs.artifactsErrOffline'
    | 'mesh.obs.artifactsErrNoSession'
    | 'mesh.obs.artifactsErrTooLarge'
    | 'mesh.obs.artifactsErrDenied'
    | 'mesh.obs.artifactsErrGeneric'

const OFFLINE_PATTERN = /timed?[\s_-]?out|timeout|unreachable|offline|not connected|disconnected|peer|relay_result_malformed|no route/i

export function classifyArtifactOpenError(code: string | null | undefined, rawReason?: string | null): ArtifactOpenErrorKey {
    switch ((code ?? '').trim()) {
        case 'artifact_not_found':
        case 'file_missing':
        case 'not_a_regular_file':
            return 'mesh.obs.artifactsErrNotFound'
        case 'path_outside_workspace':
        case 'invalid_workspace_root':
            return 'mesh.obs.artifactsErrWorkspaceGone'
        case 'artifact_session_mismatch':
        case 'session_mismatch':
        case 'artifact_mismatch':
            return 'mesh.obs.artifactsErrMismatch'
        case 'missing_session_context':
            return 'mesh.obs.artifactsErrNoSession'
        case 'artifact_too_large':
        case 'file_too_large':
            return 'mesh.obs.artifactsErrTooLarge'
        case 'artifact_access_denied':
        case 'secret_file_refused':
        case 'unauthenticated':
            return 'mesh.obs.artifactsErrDenied'
        case 'timeout':
        case 'peer_unreachable':
        case 'origin_offline':
        case 'relay_result_malformed':
            return 'mesh.obs.artifactsErrOffline'
        default:
            break
    }
    if (rawReason && OFFLINE_PATTERN.test(rawReason)) return 'mesh.obs.artifactsErrOffline'
    return 'mesh.obs.artifactsErrGeneric'
}

/** Code carried by a thrown fetch error, when it has one (MeshArtifactFetchError). */
export function artifactErrorCodeOf(err: unknown): string | null {
    const code = (err as { code?: unknown } | null)?.code
    return typeof code === 'string' ? code : null
}
