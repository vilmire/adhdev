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
 *      walk commit history backwards and retry against older commits. The
 *      registry digest is content-addressed, so the commit whose tree
 *      reproduces it IS the commit that was published.
 *
 *      ★ Canonical recovery for legacy rows (no `sourceCommit`) MUST walk
 *      commits that touch the provider artifact path(s)
 *      (`{category}/{providerType}` — same layout the publisher digests),
 *      not the full-repo chronology. Unrelated pushes otherwise dilute the
 *      bounded walk: GitHub #13 measured tip 65 full-repo commits ahead of
 *      antigravity-cli@1.2.18 while only 17 commits touched
 *      `cli/antigravity-cli` — a full-repo walk of 20 never reached the
 *      published tree (`4e3d4b53…`) and verified later tip bytes
 *      (`52e0f928…`) instead. Generation and verification use the same
 *      `adhdev-provider-tree-sha256-v1` bytes; the failure was offering the
 *      wrong commit's tree. Path filtering restores the published bytes
 *      without relaxing digest equality.
 *
 * Backward compatibility
 * ----------------------
 * New registry rows carry sourceCommit, which runtime.ts fetches directly,
 * bypassing this discovery path. Legacy rows without it use the path-filtered
 * walk (with pagination up to {@link MAX_HISTORY_CANDIDATES}). Prefer
 * backfilling `sourceCommit` so installs are one immutable fetch.
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
 * Max commits offered for legacy pin-to-published recovery.
 *
 * GitHub returns at most 100 commits per page; we paginate until this bound
 * or an empty page. Digests that no candidate reproduces still fail closed.
 * Prefer registry `sourceCommit` over exhausting this walk.
 */
export const MAX_HISTORY_CANDIDATES = 100;

/**
 * Minimum path-history depth reserved for each artifact path when a multi-path
 * walk is requested. GitHub #13 measured antigravity-cli **17** path commits
 * behind tip; dividing {@link MAX_HISTORY_CANDIDATES} across a full stable
 * catalog (~19 rows) yielded only ~6 per path and excluded the published
 * commit (review R2-02). Runtime legacy sync walks one path per row; this
 * floor remains a safety net for any multi-path caller.
 */
export const MIN_PER_PATH_HISTORY = 32;

/** GitHub commits API page size (API maximum). */
const HISTORY_PAGE_SIZE = 100;

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

export interface ListCandidateCommitsOptions {
  /** Max SHAs to return (default {@link MAX_HISTORY_CANDIDATES}). */
  limit?: number;
  /**
   * Repo-relative artifact paths whose history should be walked
   * (e.g. `cli/antigravity-cli`). When non-empty, only commits that touch
   * at least one path are candidates — matching how digests are published.
   */
  paths?: readonly string[];
}

function extractShas(body: unknown, limit: number, into: string[], seen: Set<string>): void {
  if (!Array.isArray(body)) return;
  for (const entry of body) {
    if (into.length >= limit) return;
    const sha = (entry as { sha?: unknown } | null)?.sha;
    if (typeof sha !== 'string' || !SHA_RE.test(sha) || seen.has(sha)) continue;
    seen.add(sha);
    into.push(sha);
  }
}

/**
 * Fetch one path's commit history with a **constant** `per_page`
 * ({@link HISTORY_PAGE_SIZE}). Truncation to `limit` is local — shrinking
 * `per_page` on the last page would shift GitHub's page boundaries and
 * re-return earlier commits (review R1-03).
 */
async function listCommitsForPath(
  ref: GitHubArchiveRef,
  fetchJson: FetchJsonFn,
  revision: string,
  artifactPath: string | null,
  limit: number,
): Promise<string[]> {
  const shas: string[] = [];
  const seen = new Set<string>();
  let page = 1;
  while (shas.length < limit) {
    let url = `${GITHUB_API_ORIGIN}/repos/${ref.owner}/${ref.repo}/commits`
      + `?sha=${revision}&per_page=${HISTORY_PAGE_SIZE}&page=${page}`;
    if (artifactPath) url += `&path=${encodeURIComponent(artifactPath)}`;

    let body: unknown;
    try {
      body = await fetchJson(url);
    } catch {
      return [];
    }
    if (!Array.isArray(body) || body.length === 0) break;
    const before = shas.length;
    extractShas(body, limit, shas, seen);
    if (shas.length === before || body.length < HISTORY_PAGE_SIZE) break;
    page += 1;
  }
  return shas;
}

/**
 * List candidate commit SHAs for the transport, newest first.
 *
 * When `paths` is provided, each artifact path is queried independently and
 * the results are **round-robin merged** tip-first (deduped). Concatenating
 * one path's full history before the next would bury a later provider's
 * published tip behind an older provider's deep history (review R1-02).
 * Returns an empty array if history cannot be read — the caller falls back
 * to the unpinned URL.
 */
export async function listCandidateCommits(
  ref: GitHubArchiveRef,
  fetchJson: FetchJsonFn,
  limitOrOptions: number | ListCandidateCommitsOptions = MAX_HISTORY_CANDIDATES,
): Promise<string[]> {
  if (ref.pinned) return [ref.ref];

  const options: ListCandidateCommitsOptions =
    typeof limitOrOptions === 'number' ? { limit: limitOrOptions } : (limitOrOptions ?? {});
  const limit = Math.max(1, options.limit ?? MAX_HISTORY_CANDIDATES);
  const paths = (options.paths ?? []).map((p) => p.trim()).filter((p) => p.length > 0);
  const pathQueries: Array<string | null> = paths.length > 0 ? paths : [null];
  const revision = encodeURIComponent(toApiRevision(ref.ref));

  // Each path keeps at least MIN_PER_PATH_HISTORY so a full-catalog multi-path
  // request cannot truncate below the documented #13 publication depth.
  const perPathLimit = Math.max(
    MIN_PER_PATH_HISTORY,
    Math.ceil(limit / pathQueries.length),
  );
  // Merge budget must be able to include that floor from every path (R2-02).
  const mergeLimit = Math.max(limit, Math.min(
    MAX_HISTORY_CANDIDATES * Math.max(1, pathQueries.length),
    pathQueries.length * perPathLimit,
  ));
  const perPath: string[][] = [];
  for (const artifactPath of pathQueries) {
    let list = await listCommitsForPath(ref, fetchJson, revision, artifactPath, perPathLimit);
    // Path guess may miss when the on-disk dirname ≠ manifest type (e.g.
    // `cli/kimi-cli` vs type `kimi`). Empty path history used to collapse to
    // tip-only and lose the published revision — fall back to a bounded
    // full-repo walk instead (review R3-01).
    if (list.length === 0 && artifactPath !== null) {
      list = await listCommitsForPath(ref, fetchJson, revision, null, Math.max(limit, perPathLimit));
    }
    // Lone-path still empty (fetch error) → caller falls back to unpinned URL.
    if (pathQueries.length === 1 && list.length === 0) return [];
    perPath.push(list);
  }

  const merged: string[] = [];
  const seen = new Set<string>();
  let index = 0;
  let progressed = true;
  while (merged.length < mergeLimit && progressed) {
    progressed = false;
    for (const list of perPath) {
      if (index >= list.length) continue;
      const sha = list[index];
      progressed = true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      merged.push(sha);
      if (merged.length >= mergeLimit) break;
    }
    index += 1;
  }
  return merged;
}

/**
 * Resolve the ordered list of transport URLs to try for one sync.
 *
 * - Not a GitHub archive URL → `[url]` (unchanged behavior for self-hosters).
 * - Already a pinned SHA     → `[url]` (nothing to resolve).
 * - Moving ref               → tip-first list of commit-pinned URLs, falling
 *                              back to `[url]` when history is unreadable.
 *
 * Pass `paths` (provider artifact dirs) so legacy recovery walks only commits
 * that can change the published digests — see module header ★.
 */
export async function resolveTransportCandidates(
  url: string,
  fetchJson: FetchJsonFn,
  limitOrOptions: number | ListCandidateCommitsOptions = MAX_HISTORY_CANDIDATES,
): Promise<string[]> {
  const ref = parseGitHubArchiveUrl(url);
  if (!ref) return [url];
  if (ref.pinned) return [url];

  const commits = await listCandidateCommits(ref, fetchJson, limitOrOptions);
  if (commits.length === 0) return [url];
  return commits.map((sha) => buildPinnedArchiveUrl(ref, sha));
}
