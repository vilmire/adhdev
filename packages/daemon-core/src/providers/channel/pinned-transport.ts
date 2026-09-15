/**
 * Pinned provider-transport resolution.
 *
 * The problem this exists to remove
 * ---------------------------------
 * The provider transport used to be a *moving* ref: the vendor default tarball
 * URL is `…/archive/refs/heads/main.tar.gz` (registry-resolver.ts). The channel
 * runtime downloads that one tarball and then verifies every entry's artifact
 * tree against the `bundleDigest` the REGISTRY published.
 *
 * Those two are pinned to different things. The digest is frozen at publish
 * time; the tarball always serves whatever `main` points at right now. So the
 * moment anyone pushes a provider edit to `main` WITHOUT republishing the
 * registry row, every fresh install recomputes a tree hash that no longer
 * matches the published digest and fails closed:
 *
 *   DIGEST_MISMATCH — tree digest mismatch for "<type>" … refusing activation
 *
 * i.e. a plain `git push` to the provider repo broke new installs, with the
 * breakage appearing in the daemon rather than anywhere near the push. That is
 * the coupling this module removes.
 *
 * What it does
 * ------------
 * Two independent pins, both of which preserve the fail-closed digest contract
 * (nothing here ever decides a tree is acceptable — `runtime.ts` still verifies
 * every tree against the registry digest, and this module only changes WHICH
 * bytes get offered for that verification):
 *
 *   1. Freeze-at-fetch. A moving-ref archive URL is resolved once per sync to
 *      the concrete commit SHA it currently denotes, and every download in that
 *      sync uses `…/archive/<sha>.tar.gz`. This alone removes the intra-sync
 *      race where `main` advances between two entries' downloads.
 *
 *   2. Pin-to-published. If the tip tree does not match the published digests,
 *      walk the repo's commit history backwards and retry against older
 *      commits. The registry digest is content-addressed, so the commit whose
 *      tree reproduces it IS the commit that was published — finding it is
 *      exactly "fetch the version this row was published from". This is what
 *      makes an unpublished push to `main` a no-op for installs instead of an
 *      outage.
 *
 * Backward compatibility
 * ----------------------
 * Existing registry rows carry no commit information and none is added here:
 * the pin is DERIVED from the digest the row already has. So previously
 * published rows — including every row live today — resolve correctly with no
 * migration and no republish.
 *
 * A URL this module does not recognize as a GitHub archive URL (a self-hoster
 * who repointed `providerTarballUrl`/`ADHDEV_PROVIDER_TARBALL_URL` at their own
 * mirror) is returned unchanged and the runtime behaves exactly as before. The
 * pinning is an enhancement on the vendor path, never a new requirement.
 */

/** Parsed GitHub archive URL: `https://github.com/<owner>/<repo>/archive/<ref>.tar.gz`. */
export interface GitHubArchiveRef {
  owner: string;
  repo: string;
  /** The ref as it appears in the URL, e.g. `refs/heads/main` or a 40-hex SHA. */
  ref: string;
  /** True when `ref` is already a concrete 40-hex commit SHA (nothing to pin). */
  pinned: boolean;
}

const SHA_RE = /^[0-9a-f]{40}$/;

/** GitHub REST API origin. Kept separate so a GHE host is simply not matched. */
const GITHUB_HOST = 'github.com';
const GITHUB_API_ORIGIN = 'https://api.github.com';

/**
 * How far back through the provider repo's history to look for the commit that
 * reproduces a published digest. Publishing lags pushes by hours-to-days, not
 * by hundreds of commits; a bounded walk keeps a genuinely-missing digest a
 * prompt typed failure instead of an unbounded crawl.
 */
export const MAX_HISTORY_CANDIDATES = 20;

/**
 * Parse a GitHub archive tarball URL. Returns null for anything else — a
 * self-hosted mirror, a file:// path, a non-archive URL — which the caller
 * treats as "not pinnable, use as-is".
 */
export function parseGitHubArchiveUrl(url: string): GitHubArchiveRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.hostname !== GITHUB_HOST) return null;

  // /<owner>/<repo>/archive/<ref…>.tar.gz — the ref itself may contain slashes
  // (`refs/heads/main`), so it is everything after `/archive/`.
  const match = /^\/([^/]+)\/([^/]+)\/archive\/(.+)\.tar\.gz$/.exec(parsed.pathname);
  if (!match) return null;
  const [, owner, repo, rawRef] = match;
  if (!owner || !repo || !rawRef) return null;

  const ref = decodeURIComponent(rawRef);
  return { owner, repo, ref, pinned: SHA_RE.test(ref) };
}

/** Build the archive URL for one concrete commit SHA. */
export function buildPinnedArchiveUrl(ref: GitHubArchiveRef, commitSha: string): string {
  return `https://${GITHUB_HOST}/${ref.owner}/${ref.repo}/archive/${commitSha}.tar.gz`;
}

/**
 * Strip `refs/heads/` etc. so the ref can be used as an API revision. GitHub's
 * commits API takes a branch name or SHA, not a fully-qualified ref.
 */
function toApiRevision(ref: string): string {
  return ref.replace(/^refs\/(heads|tags)\//, '');
}

/** Minimal injectable JSON fetch — same shape the channel runtime already uses. */
export type FetchJsonFn = (url: string) => Promise<unknown>;

/**
 * List candidate commit SHAs for the transport, newest first.
 *
 * The first element is the current tip of `ref`; the rest are its ancestors.
 * Returns an empty array if the history cannot be read — the caller then falls
 * back to the unpinned URL rather than failing the sync, because an
 * unreachable GitHub API must not be a harder failure than the pre-pin
 * behavior it replaces.
 */
export async function listCandidateCommits(
  ref: GitHubArchiveRef,
  fetchJson: FetchJsonFn,
  limit: number = MAX_HISTORY_CANDIDATES,
): Promise<string[]> {
  if (ref.pinned) return [ref.ref];
  const revision = encodeURIComponent(toApiRevision(ref.ref));
  const url = `${GITHUB_API_ORIGIN}/repos/${ref.owner}/${ref.repo}/commits`
    + `?sha=${revision}&per_page=${Math.max(1, Math.min(100, limit))}`;

  let body: unknown;
  try {
    body = await fetchJson(url);
  } catch {
    return [];
  }
  if (!Array.isArray(body)) return [];

  const shas: string[] = [];
  for (const entry of body) {
    const sha = (entry as { sha?: unknown } | null)?.sha;
    if (typeof sha === 'string' && SHA_RE.test(sha)) shas.push(sha);
    if (shas.length >= limit) break;
  }
  return shas;
}

/**
 * Resolve the ordered list of transport URLs to try for one sync.
 *
 * - Not a GitHub archive URL → `[url]` (unchanged behavior for self-hosters).
 * - Already a pinned SHA     → `[url]` (nothing to resolve).
 * - Moving ref               → tip-first list of commit-pinned URLs, falling
 *                              back to `[url]` when history is unreadable.
 *
 * The caller tries these in order and stops at the first whose extracted trees
 * satisfy the published digests. Order matters: the tip is tried first so the
 * common case (registry and `main` agree) costs exactly one download, and the
 * history walk is paid only when they have actually diverged.
 */
export async function resolveTransportCandidates(
  url: string,
  fetchJson: FetchJsonFn,
  limit: number = MAX_HISTORY_CANDIDATES,
): Promise<string[]> {
  const ref = parseGitHubArchiveUrl(url);
  if (!ref) return [url];
  if (ref.pinned) return [url];

  const commits = await listCandidateCommits(ref, fetchJson, limit);
  if (commits.length === 0) return [url];
  return commits.map((sha) => buildPinnedArchiveUrl(ref, sha));
}
