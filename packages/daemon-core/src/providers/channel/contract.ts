/**
 * Provider channel contract (Stage 2 runtime loader).
 *
 * Defines the runtime-side view of the explicit stable/preview provider
 * channels landed in Stage 1A (adhdev-providers channel manifests) and
 * Stage 1B (packages/server registry channel reads):
 *
 * - A channel is ALWAYS explicit: 'stable' or 'preview'. Absent or ambiguous
 *   configuration resolves to 'stable'. Stable never falls through to preview.
 * - Every channel entry carries a typed, versioned digest algorithm
 *   (`digestAlgorithm`) and a content digest (`bundleDigest`). The runtime
 *   verifies the downloaded artifact tree against that digest BEFORE
 *   activation; it never compares the digest against transport bytes
 *   (tarballs), only against the reconstructed provider tree.
 * - Rows without a verified identity (`bundleDigest: null`,
 *   `digestAlgorithm: 'legacy-unverified'`) are NON-ACTIVATABLE. They are
 *   skipped with a typed reason, never treated as an error and never
 *   activated.
 *
 * Fail-closed rule: digest/metadata mismatch, unsupported algorithm, missing
 * verified artifact, registry failure or a NULL/legacy-unverified row must
 * never activate new bytes. The last-known-good active object stays live.
 */

/** Explicit provider channels. */
export type ProviderChannel = 'stable' | 'preview';

export const PROVIDER_CHANNELS: readonly ProviderChannel[] = ['stable', 'preview'];

/** Default channel when configuration is absent or ambiguous. */
export const DEFAULT_PROVIDER_CHANNEL: ProviderChannel = 'stable';

/** Env var that selects the provider channel when config does not. */
export const PROVIDER_CHANNEL_ENV_VAR = 'ADHDEV_PROVIDER_CHANNEL';

/**
 * Digest algorithms this runtime can verify end-to-end. Anything else is an
 * unsupported-algorithm state: the entry is isolated (skipped) and never
 * activated. New algorithms must be added here as typed/versioned strings
 * together with a verifier — never by reinterpreting an existing algorithm.
 */
export const KNOWN_DIGEST_ALGORITHMS: ReadonlySet<string> = new Set([
  'adhdev-provider-tree-sha256-v1',
]);

/** Stage 1B marker for rows that predate verified digests. */
export const LEGACY_UNVERIFIED_ALGORITHM = 'legacy-unverified';

export const BUNDLE_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** Typed non-activation / channel error codes. */
export type ProviderChannelErrorCode =
  /** Channel metadata (registry) could not be fetched or was malformed. */
  | 'CHANNEL_METADATA_UNAVAILABLE'
  /** Entry has no verified identity (NULL digest / legacy-unverified row). */
  | 'ENTRY_NON_ACTIVATABLE'
  /** Entry digest is malformed (not sha256:<64 lowercase hex>). */
  | 'ENTRY_DIGEST_INVALID'
  /** Entry digestAlgorithm is not verifiable by this runtime. */
  | 'ENTRY_ALGORITHM_UNSUPPORTED'
  /** Artifact tree not found in the downloaded transport for this entry. */
  | 'ENTRY_ARTIFACT_NOT_FOUND'
  /** Artifact tree contains non-regular files (symlinks etc.) or is empty. */
  | 'ENTRY_TREE_INVALID'
  /** Recomputed tree digest differs from the channel entry digest. */
  | 'DIGEST_MISMATCH'
  /** Transport (tarball download/extraction) failed. */
  | 'TRANSPORT_FAILED'
  /** Local store pointer/object is corrupt. */
  | 'STORE_CORRUPT'
  /** Unverified tarball fallback attempted in a mode that refuses it. */
  | 'TARBALL_FALLBACK_REFUSED';

export class ProviderChannelError extends Error {
  readonly code: ProviderChannelErrorCode;
  readonly providerType?: string;

  constructor(code: ProviderChannelErrorCode, message: string, providerType?: string) {
    super(message);
    this.name = 'ProviderChannelError';
    this.code = code;
    this.providerType = providerType;
  }
}

/**
 * Resolve the effective provider channel.
 *
 * Priority: explicit config value → env var → default. Absent, empty or
 * unrecognized values resolve to 'stable' (never to preview): an ambiguous
 * runtime must behave like the most conservative channel.
 */
export function resolveProviderChannel(
  configured?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): ProviderChannel {
  const raw = (configured && configured.trim()) || (env[PROVIDER_CHANNEL_ENV_VAR] ?? '').trim();
  return raw === 'preview' ? 'preview' : 'stable';
}

/**
 * Normalized channel entry consumed by the runtime. This is the intersection
 * of the Stage 1A channel-manifest entry shape and the Stage 1B registry
 * `rowToMeta` shape — only the fields required for verified activation.
 */
export interface ChannelEntry {
  providerType: string;
  providerVersion: string;
  category: string;
  /** 'sha256:<64 lowercase hex>' or null for legacy-unverified rows. */
  bundleDigest: string | null;
  digestAlgorithm: string | null;
}

export interface ActivatableEntry extends ChannelEntry {
  bundleDigest: string;
  digestAlgorithm: string;
}

export interface SkippedEntry {
  entry: ChannelEntry;
  code: ProviderChannelErrorCode;
  reason: string;
}

/**
 * Partition raw channel entries into activatable entries and typed skips.
 *
 * An entry is activatable iff it carries a well-formed sha256 digest AND a
 * digest algorithm this runtime can verify. NULL/legacy-unverified rows are
 * skipped (non-activatable), never activated and never fatal.
 */
export function partitionChannelEntries(entries: ChannelEntry[]): {
  activatable: ActivatableEntry[];
  skipped: SkippedEntry[];
} {
  const activatable: ActivatableEntry[] = [];
  const skipped: SkippedEntry[] = [];

  for (const entry of entries) {
    const algorithm = typeof entry.digestAlgorithm === 'string' ? entry.digestAlgorithm : null;
    const digest = typeof entry.bundleDigest === 'string' ? entry.bundleDigest : null;

    if (!digest || !algorithm || algorithm === LEGACY_UNVERIFIED_ALGORITHM) {
      skipped.push({
        entry,
        code: 'ENTRY_NON_ACTIVATABLE',
        reason: `provider "${entry.providerType}" has no verified artifact identity (legacy-unverified / NULL digest) — not activatable`,
      });
      continue;
    }
    if (!KNOWN_DIGEST_ALGORITHMS.has(algorithm)) {
      skipped.push({
        entry,
        code: 'ENTRY_ALGORITHM_UNSUPPORTED',
        reason: `provider "${entry.providerType}" uses unsupported digestAlgorithm "${algorithm}" — isolated, not activated`,
      });
      continue;
    }
    if (!BUNDLE_DIGEST_RE.test(digest)) {
      skipped.push({
        entry,
        code: 'ENTRY_DIGEST_INVALID',
        reason: `provider "${entry.providerType}" has malformed bundleDigest "${digest}" — not activated`,
      });
      continue;
    }
    activatable.push({ ...entry, bundleDigest: digest, digestAlgorithm: algorithm });
  }

  return { activatable, skipped };
}
