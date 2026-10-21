/**
 * Artifact Viewer store, file guard, and domain types (Task A).
 */

export {
    ARTIFACT_EXTENSION_MAP,
    ARTIFACT_KINDS,
    ArtifactGuardError,
    MAX_ARTIFACTS_PER_SESSION,
    MAX_ARTIFACT_BYTES,
    MAX_PREVIEW_TEXT_CHARS,
    MIME_BY_KIND,
    toChatAttachmentMeta,
    type ArtifactErrorCode,
    type ArtifactKind,
    type ArtifactRecord,
    type ChatAttachmentMeta,
    type ExtensionKindMimeSpec,
} from './types.js';

export {
    extractUtf8Preview,
    readVerifiedArtifactFile,
    resolveArtifactFile,
    sanitizeArtifactTitle,
    type ArtifactTestRaceHooks,
    type ResolveArtifactFileOptions,
    type ResolvedArtifactFile,
    type VerifiedArtifactFileRead,
} from './artifact-path-guard.js';

export {
    ArtifactStore,
    SESSION_ARTIFACTS_SCHEMA_DDL,
    ensureArtifactStoreSchema,
    fetchArtifactContent,
    generateArtifactId,
    listSessionArtifacts,
    registerSessionArtifact,
    type ArtifactDatabaseInput,
    type ArtifactStoreDatabase,
    type ArtifactStoreStatement,
    type ArtifactStoreTransactionFn,
    type FetchArtifactContentOptions,
    type FetchArtifactContentResult,
    type ListSessionArtifactsOptions,
    type RegisterArtifactInput,
    type RegisterArtifactResult,
} from './artifact-store.js';
