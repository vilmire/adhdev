#!/usr/bin/env node
/**
 * Guarded OIDC Trusted Publishing helper for stable OSS releases (`oss/.github/workflows/ci.yml`).
 *
 * Enforces:
 *   1. Authorized tag & independently approved source binding (`R2`):
 *      - `GITHUB_REPOSITORY === 'vilmire/adhdev'`
 *      - `GITHUB_REF === 'refs/tags/v' + version` where `version` is strict stable `X.Y.Z` (never prerelease/-rc)
 *      - `git rev-parse HEAD === GITHUB_SHA`
 *      - Remote tag object resolution via GitHub API (`repos/vilmire/adhdev/git/ref/tags/v<X.Y.Z>` -> peeling annotated tag if needed)
 *        must resolve to `commit` SHA === `headSha`
 *      - `headSha` must be reachable on `refs/heads/main` (`repos/vilmire/adhdev/compare/main...<headSha>` has `ahead_by === 0`
 *        and `status` in `['identical', 'behind']`)
 *      - When `expectedTargetSha` is provided (`workflow_dispatch` `tag_sha`), `headSha === expectedTargetSha`
 *      - Active deployment environment verification (`R4`): `repos/vilmire/adhdev/environments/npm-stable` must have
 *        `can_admins_bypass === false` and required reviewer `User: vilmire` (`id: 5513793`)
 *      - Root `package.json` version === tag version
 *      - Every published package manifest (`mesh-shared`, `session-host-core`, `mcp-server`, `daemon-core`, `daemon-standalone`)
 *        has exact `name`, `version === tagVersion`, `private !== true`, and `repository.url === 'https://github.com/vilmire/adhdev.git'`
 *      - `@adhdev/ghostty-vt-node` has exact `name`, strict stable `X.Y.Z` version (`<= tagVersion`), and matching `repository.url`
 *        (matching `oss/scripts/version-bump.sh`'s intentional `GHOSTTY_CHANGED=0` version retention when ghostty paths are unchanged).
 *   2. Reviewed-byte idempotency, explicit `--tag=latest`, and post-publish readback (`R2`, `R3`, `R7`):
 *      - Packs each package with `npm pack --ignore-scripts --json --pack-destination <bundleDir>`
 *      - Computes SHA-256 and `sha512-...` `dist.integrity` from the exact packed `.tgz` bytes
 *      - Queries live npm registry `https://registry.npmjs.org/<pkg>/<version>` and `/latest`:
 *        * Only HTTP 404 is treated as unpublished; any other HTTP/network error fails closed
 *        * If `<version>` already exists on npm, its `dist.integrity` MUST equal the packed `.tgz` integrity AND `/latest`
 *          must already point to `<version>` with matching integrity (idempotent skip); otherwise fails closed (`registry_bytes_differ` / `channel_mismatch`)
 *      - Publishes the exact `.tgz` file with `npm publish <tarball> --access=public --ignore-scripts --tag=latest`
 *        using a sanitized OIDC environment (`NODE_AUTH_TOKEN`, `NPM_TOKEN`, `npm_config__authToken` stripped; `ACTIONS_ID_TOKEN_REQUEST_*` required)
 *      - Polls registry readback after each publish to verify `<pkg>@<version>` and `/latest` serve the exact `dist.integrity`.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXPECTED_REPO = 'vilmire/adhdev';
export const EXPECTED_REPO_URL = 'https://github.com/vilmire/adhdev.git';
export const EXPECTED_OWNER_LOGIN = 'vilmire';
export const EXPECTED_OWNER_ID = 5513793;
export const EXPECTED_STABLE_ENVIRONMENT = 'npm-stable';
export const REGISTRY = 'https://registry.npmjs.org';
export const STABLE_SEMVER_RE = /^\d+\.\d+\.\d+$/;
export const OSS_PUBLISH_PACKAGES = Object.freeze([
  { slug: 'mesh-shared', name: '@adhdev/mesh-shared', dir: 'packages/mesh-shared', allowRetainedStableVersion: false },
  { slug: 'session-host-core', name: '@adhdev/session-host-core', dir: 'packages/session-host-core', allowRetainedStableVersion: false },
  { slug: 'ghostty-vt-node', name: '@adhdev/ghostty-vt-node', dir: 'packages/ghostty-vt-node', allowRetainedStableVersion: true },
  { slug: 'mcp-server', name: '@adhdev/mcp-server', dir: 'packages/mcp-server', allowRetainedStableVersion: false },
  { slug: 'daemon-core', name: '@adhdev/daemon-core', dir: 'packages/daemon-core', allowRetainedStableVersion: false },
  { slug: 'daemon-standalone', name: '@adhdev/daemon-standalone', dir: 'packages/daemon-standalone', allowRetainedStableVersion: false },
].map(Object.freeze));

export function parseSemverTuple(version) {
  if (!STABLE_SEMVER_RE.test(String(version ?? ''))) return null;
  return String(version).split('.').map(Number);
}

export function compareSemverTuples(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function computeHashes(bytes) {
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    size: bytes.length,
  };
}

export function sanitizeOidcPublishEnv(env = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === 'NODE_AUTH_TOKEN' || key === 'NPM_TOKEN' || key.toLowerCase().startsWith('npm_config__authtoken')) {
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

export function assertOidcAmbientCredentials(env = process.env) {
  if (!env?.ACTIONS_ID_TOKEN_REQUEST_URL || !env?.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error('oidc_credentials_missing: OIDC Trusted Publishing requires GitHub Actions id-token: write credentials');
  }
}

export function defaultGhApiJson(endpoint) {
  const out = execFileSync('gh', ['api', endpoint], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

/**
 * Verifies that a tag ref in `repository` points to `headSha`, that `headSha`
 * equals the independently approved `expectedTargetSha` supplied by an owner
 * `workflow_dispatch` on protected `main`, and that `headSha` is reachable on
 * `refs/heads/main` (`compare/main...<headSha>` has `status === 'identical'` or
 * `status === 'behind'`, `ahead_by === 0`). Both historical and current-tip tags
 * without an independent `expectedTargetSha` approval are rejected (`R2`).
 */
export function verifyApprovedTagTarget({
  repository,
  tagName,
  headSha,
  expectedTargetSha = '',
  ghApiJson = defaultGhApiJson,
}) {
  if (!headSha || !/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error(`invalid_head_sha: expected 40-char hex SHA, got ${headSha || '<unset>'}`);
  }
  if (!expectedTargetSha || !/^[0-9a-f]{40}$/.test(expectedTargetSha)) {
    throw new Error(
      `approved_target_sha_required: stable publication requires an independently approved 40-char hex target SHA from protected main workflow_dispatch (got ${expectedTargetSha || '<unset>'})`,
    );
  }
  if (expectedTargetSha !== headSha) {
    throw new Error(`approved_target_sha_mismatch: checkout HEAD (${headSha}) does not match independently approved target SHA (${expectedTargetSha})`);
  }
  const refData = ghApiJson(`repos/${repository}/git/ref/tags/${tagName}`);
  if (refData?.ref !== `refs/tags/${tagName}` || !refData?.object?.sha) {
    throw new Error(`tag_ref_not_found: refs/tags/${tagName} in ${repository}`);
  }
  let commitSha = refData.object.sha;
  if (refData.object.type === 'tag') {
    const tagObj = ghApiJson(`repos/${repository}/git/tags/${commitSha}`);
    if (tagObj?.object?.type !== 'commit' || !tagObj?.object?.sha) {
      throw new Error(`tag_object_not_commit: refs/tags/${tagName} in ${repository} does not peel to a commit`);
    }
    commitSha = tagObj.object.sha;
  } else if (refData.object.type !== 'commit') {
    throw new Error(`tag_object_invalid_type: refs/tags/${tagName} has object.type=${refData.object.type}`);
  }
  if (commitSha !== headSha) {
    throw new Error(`tag_commit_mismatch: remote refs/tags/${tagName} points to ${commitSha}, but checkout HEAD is ${headSha}`);
  }

  // Verify the tagged commit against the protected main branch tip.
  const compare = ghApiJson(`repos/${repository}/compare/main...${headSha}`);
  const status = compare?.status;
  const aheadBy = compare?.ahead_by;
  if ((status !== 'identical' && status !== 'behind') || aheadBy !== 0) {
    throw new Error(
      `unapproved_tag_commit_not_on_main: commit ${headSha} for tag ${tagName} is not reachable on ${repository} refs/heads/main (status=${status ?? '<unknown>'}, ahead_by=${aheadBy ?? '<unknown>'})`,
    );
  }
  return { tagName, commitSha };
}

/**
 * Verifies at runtime via GitHub API that the active deployment environment
 * enforces `can_admins_bypass === false`, enforces the exact allowed deployment
 * branch/tag policy pairs (with no missing `deployment_branch_policy`, no extra
 * wildcard policies, and no swapped type/name pairs), and requires owner review
 * (`User: vilmire`, id `5513793`) (`R4`).
 */
export function verifyProtectedEnvironmentGate({
  repository,
  environmentName,
  expectedBranchPolicyType = null,
  expectedBranchPolicyName = null,
  expectedBranchPolicies = null,
  ghApiJson = defaultGhApiJson,
}) {
  let envData;
  try {
    envData = ghApiJson(`repos/${repository}/environments/${environmentName}`);
  } catch (err) {
    throw new Error(`environment_verification_failed: could not query repos/${repository}/environments/${environmentName}: ${err?.message || err}`);
  }
  if (!envData || envData.name !== environmentName) {
    throw new Error(`environment_missing: ${repository} environment "${environmentName}" does not exist`);
  }
  if (envData.can_admins_bypass !== false) {
    throw new Error(`environment_admin_bypass_enabled: ${repository} environment "${environmentName}" must set can_admins_bypass=false`);
  }

  // Validate custom deployment branch/tag policy status and exact allowed type:name pairs BEFORE evaluating reviewer availability (R4).
  const requiredPairs = Array.isArray(expectedBranchPolicies) && expectedBranchPolicies.length > 0
    ? expectedBranchPolicies.map((p) => `${p.type}:${p.name}`)
    : (expectedBranchPolicyType && expectedBranchPolicyName)
      ? (() => {
        const types = Array.isArray(expectedBranchPolicyType) ? expectedBranchPolicyType : [expectedBranchPolicyType];
        const names = Array.isArray(expectedBranchPolicyName) ? expectedBranchPolicyName : [expectedBranchPolicyName];
        return names.map((n, idx) => `${types[idx] ?? types[0]}:${n}`);
      })()
      : null;

  if (requiredPairs && requiredPairs.length > 0) {
    if (!envData.deployment_branch_policy || envData.deployment_branch_policy.custom_branch_policies !== true) {
      throw new Error(
        `environment_branch_policy_disabled: ${repository} environment "${environmentName}" must enable custom_branch_policies`,
      );
    }
    const policy = ghApiJson(`repos/${repository}/environments/${environmentName}/deployment-branch-policies`);
    const policies = Array.isArray(policy?.branch_policies) ? policy.branch_policies : [];
    const allowedSet = new Set(requiredPairs);
    const actualKeys = policies.map((p) => `${p?.type ?? 'branch'}:${p?.name ?? ''}`);
    const hasExactAllowedSubset = actualKeys.length > 0
      && actualKeys.every((k) => allowedSet.has(k))
      && new Set(actualKeys).size === actualKeys.length;
    if (!hasExactAllowedSubset) {
      throw new Error(
        `environment_branch_policy_mismatch: ${repository} environment "${environmentName}" has policies [${actualKeys.join(', ')}], expected only subset of [${[...allowedSet].join(', ')}]`,
      );
    }
  }

  const rules = Array.isArray(envData.protection_rules) ? envData.protection_rules : [];
  const reviewerRules = rules.filter((r) => r?.type === 'required_reviewers');
  if (reviewerRules.length !== 1) {
    throw new Error(
      `environment_required_reviewers_missing: ${repository} environment "${environmentName}" has no active required_reviewers protection rule (note: private repositories on GitHub Free/Pro/Team do not support environment required_reviewers; an enforceable approval gate is required before OIDC publish)`,
    );
  }
  const reviewers = Array.isArray(reviewerRules[0].reviewers) ? reviewerRules[0].reviewers : [];
  const hasOwnerReviewer = reviewers.length === 1
    && reviewers[0]?.type === 'User'
    && (reviewers[0]?.reviewer?.login === EXPECTED_OWNER_LOGIN || reviewers[0]?.reviewer?.id === EXPECTED_OWNER_ID);
  if (!hasOwnerReviewer) {
    throw new Error(`environment_owner_reviewer_mismatch: ${repository} environment "${environmentName}" must require sole User reviewer ${EXPECTED_OWNER_LOGIN}`);
  }
  return envData;
}

export function verifyStableTagAndManifests({
  repoRoot,
  githubRepository,
  githubRef,
  githubSha,
  headSha,
  expectedTag = '',
  expectedTargetSha = '',
  ghApiJson = null,
  verifyEnvironment = false,
}) {
  if (githubRepository !== EXPECTED_REPO) {
    throw new Error(`unauthorized_repository: expected ${EXPECTED_REPO}, got ${githubRepository || '<unset>'}`);
  }
  const effectiveRef = expectedTag
    ? (expectedTag.startsWith('refs/tags/') ? expectedTag : `refs/tags/${expectedTag}`)
    : githubRef;
  if (!effectiveRef || !effectiveRef.startsWith('refs/tags/v')) {
    throw new Error(`unauthorized_ref: stable publish requires refs/tags/v<X.Y.Z>, got ${effectiveRef || '<unset>'}`);
  }
  const tagVersion = effectiveRef.slice('refs/tags/v'.length);
  const tagTuple = parseSemverTuple(tagVersion);
  if (!tagTuple) {
    throw new Error(`non_stable_tag_version: stable publish refuses non-stable tag ${effectiveRef}`);
  }
  if (!githubSha || !/^[0-9a-f]{40}$/.test(githubSha) || headSha !== githubSha) {
    throw new Error(`source_sha_mismatch: checkout HEAD (${headSha}) does not match GITHUB_SHA (${githubSha})`);
  }
  if (ghApiJson) {
    verifyApprovedTagTarget({
      repository: EXPECTED_REPO,
      tagName: `v${tagVersion}`,
      headSha,
      expectedTargetSha,
      ghApiJson,
    });
    if (verifyEnvironment) {
      verifyProtectedEnvironmentGate({
        repository: EXPECTED_REPO,
        environmentName: EXPECTED_STABLE_ENVIRONMENT,
        expectedBranchPolicies: [
          { type: 'tag', name: 'v*' },
          { type: 'branch', name: 'main' },
        ],
        ghApiJson,
      });
    }
  } else {
    if (!expectedTargetSha || !/^[0-9a-f]{40}$/.test(expectedTargetSha)) {
      throw new Error(
        `approved_target_sha_required: stable publication requires an independently approved 40-char hex target SHA from protected main workflow_dispatch (got ${expectedTargetSha || '<unset>'})`,
      );
    }
    if (expectedTargetSha !== headSha) {
      throw new Error(`approved_target_sha_mismatch: checkout HEAD (${headSha}) does not match independently approved target SHA (${expectedTargetSha})`);
    }
  }

  const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  if (rootPkg.version !== tagVersion) {
    throw new Error(`tag_manifest_version_mismatch: tag v${tagVersion} != oss/package.json version ${rootPkg.version}`);
  }

  const verifiedPackages = [];
  for (const entry of OSS_PUBLISH_PACKAGES) {
    const pkgPath = join(repoRoot, entry.dir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (pkg.name !== entry.name) {
      throw new Error(`manifest_name_mismatch: ${entry.dir} declared ${pkg.name}, expected ${entry.name}`);
    }
    if (pkg.private === true) {
      throw new Error(`manifest_private: ${entry.name} is marked private`);
    }
    const pkgTuple = parseSemverTuple(pkg.version);
    if (!pkgTuple) {
      throw new Error(`non_stable_package_version: ${entry.name} version "${pkg.version}" is not a stable X.Y.Z release version`);
    }
    if (entry.allowRetainedStableVersion) {
      if (compareSemverTuples(pkgTuple, tagTuple) > 0) {
        throw new Error(`ghostty_version_ahead_of_tag: ${entry.name}@${pkg.version} exceeds tag v${tagVersion}`);
      }
    } else if (pkg.version !== tagVersion) {
      throw new Error(`package_version_mismatch: ${entry.name}@${pkg.version} does not match tag v${tagVersion}`);
    }
    const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    if (repoUrl !== EXPECTED_REPO_URL) {
      throw new Error(`repository_url_mismatch: ${entry.name} repository.url is "${repoUrl}", expected "${EXPECTED_REPO_URL}"`);
    }
    verifiedPackages.push({
      ...entry,
      version: pkg.version,
      retainedVersion: pkg.version !== tagVersion,
    });
  }
  return { tag: `v${tagVersion}`, tagVersion, sourceSha: headSha, packages: verifiedPackages };
}

export async function fetchRegistryVersionRecord(packageName, versionOrTag, { fetchImpl = fetch, registry = REGISTRY } = {}) {
  const encodedName = packageName.startsWith('@')
    ? `@${encodeURIComponent(packageName.slice(1).split('/')[0])}%2F${encodeURIComponent(packageName.split('/')[1])}`
    : encodeURIComponent(packageName);
  const url = `${registry}/${encodedName}/${encodeURIComponent(versionOrTag)}`;
  const res = await fetchImpl(url, {
    headers: { 'Cache-Control': 'no-cache', Accept: 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`registry_http_error: GET ${url} returned HTTP ${res.status}`);
  }
  return await res.json();
}

export async function evaluateStableIdempotency(record, { fetchRecord = fetchRegistryVersionRecord } = {}) {
  const { name, version, integrity, retainedVersion } = record;
  const existing = await fetchRecord(name, version);
  const latest = await fetchRecord(name, 'latest');
  if (existing !== null) {
    const remoteIntegrity = existing?.dist?.integrity;
    if (remoteIntegrity !== integrity) {
      throw new Error(`registry_bytes_differ: ${name}@${version} already exists on npm with integrity ${remoteIntegrity || '<none>'}, which differs from reviewed local tarball integrity ${integrity}`);
    }
    if (!retainedVersion) {
      if (!latest || latest.version !== version || latest?.dist?.integrity !== integrity) {
        throw new Error(`registry_channel_mismatch: ${name}@${version} exists with matching integrity, but dist-tag latest points to ${latest?.version || '<none>'}`);
      }
    }
    return { action: 'skip', reason: retainedVersion ? 'retained_version_verified' : 'already_published_and_latest_verified' };
  }
  if (retainedVersion) {
    throw new Error(`retained_version_unpublished: ${name}@${version} is retained from an earlier tag but is 404 on npm`);
  }
  if (latest !== null) {
    const latestTuple = parseSemverTuple(latest.version);
    const targetTuple = parseSemverTuple(version);
    if (!latestTuple || compareSemverTuples(latestTuple, targetTuple) >= 0) {
      throw new Error(`channel_regression_refused: refusing to move ${name}@latest from ${latest.version} to ${version}`);
    }
  }
  return { action: 'publish' };
}

export async function verifyRegistryPublicationReadback({
  packageName,
  version,
  expectedIntegrity,
  expectedDistTag = 'latest',
  fetchRecord = fetchRegistryVersionRecord,
  pollAttempts = 18,
  pollDelayMs = 10_000,
}) {
  let lastVersionRecord = null;
  let lastTagRecord = null;
  for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
    lastVersionRecord = await fetchRecord(packageName, version);
    lastTagRecord = await fetchRecord(packageName, expectedDistTag);
    if (lastVersionRecord !== null) {
      const remoteIntegrity = lastVersionRecord?.dist?.integrity;
      if (remoteIntegrity && remoteIntegrity !== expectedIntegrity) {
        throw new Error(
          `registry_readback_bytes_differ: ${packageName}@${version} on npm has integrity ${remoteIntegrity}, expected ${expectedIntegrity}`,
        );
      }
      if (
        remoteIntegrity === expectedIntegrity
        && lastTagRecord !== null
        && lastTagRecord.version === version
        && lastTagRecord?.dist?.integrity === expectedIntegrity
      ) {
        return { versionRecord: lastVersionRecord, tagRecord: lastTagRecord };
      }
    }
    if (attempt < pollAttempts && pollDelayMs > 0) {
      await new Promise((r) => setTimeout(r, pollDelayMs));
    }
  }
  const tagVer = lastTagRecord?.version ?? '<none>';
  const verIntegrity = lastVersionRecord?.dist?.integrity ?? '<missing>';
  throw new Error(
    `registry_readback_unverified: ${packageName}@${version} failed post-publish registry verification after ${pollAttempts} attempts (versionIntegrity=${verIntegrity}, ${expectedDistTag}=${tagVer})`,
  );
}

export function packStableTarballs({ repoRoot, bundleDir, packages, execNpm = (args, opts) => execFileSync('npm', args, opts) }) {
  mkdirSync(bundleDir, { recursive: true, mode: 0o700 });
  const records = [];
  for (const pkg of packages) {
    const cwd = join(repoRoot, pkg.dir);
    const out = execNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', bundleDir], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let packed;
    try { [packed] = JSON.parse(out); } catch { throw new Error(`pack_json_invalid: ${pkg.name}`); }
    if (!packed?.filename || basename(packed.filename) !== packed.filename || !packed.filename.endsWith('.tgz')) {
      throw new Error(`pack_filename_invalid: ${pkg.name}`);
    }
    const archivePath = join(bundleDir, packed.filename);
    const bytes = readFileSync(archivePath);
    const hashes = computeHashes(bytes);
    records.push({
      ...pkg,
      filename: packed.filename,
      archivePath,
      ...hashes,
    });
  }
  return records;
}

export async function publishStableOssRelease({
  repoRoot,
  bundleDir,
  githubRepository = process.env.GITHUB_REPOSITORY,
  githubRef = process.env.GITHUB_REF,
  githubSha = process.env.GITHUB_SHA,
  expectedTag = process.env.EXPECTED_TAG || '',
  expectedTargetSha = process.env.EXPECTED_TAG_SHA || '',
  env = process.env,
  fetchRecord = fetchRegistryVersionRecord,
  execNpm,
  ghApiJson = defaultGhApiJson,
  verifyEnvironment = Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN),
  pollAttempts = 18,
  pollDelayMs = 10_000,
}) {
  assertOidcAmbientCredentials(env);
  const cleanEnv = sanitizeOidcPublishEnv(env);
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const verified = verifyStableTagAndManifests({
    repoRoot,
    githubRepository,
    githubRef,
    githubSha,
    headSha,
    expectedTag,
    expectedTargetSha,
    ghApiJson,
    verifyEnvironment,
  });
  const runNpm = execNpm ?? ((args, opts = {}) => execFileSync('npm', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
    env: cleanEnv,
  }));
  const packedRecords = packStableTarballs({
    repoRoot,
    bundleDir,
    packages: verified.packages,
    execNpm: runNpm,
  });

  // Preflight all 6 packages against the registry before the first irreversible write.
  const plans = [];
  for (const record of packedRecords) {
    const decision = await evaluateStableIdempotency(record, { fetchRecord });
    plans.push({ record, decision });
  }

  const manifest = {
    tag: verified.tag,
    tagVersion: verified.tagVersion,
    sourceSha: verified.sourceSha,
    repository: EXPECTED_REPO,
    registry: REGISTRY,
    distTag: 'latest',
    packages: packedRecords.map(({ slug, name, version, retainedVersion, filename, sha256, integrity, size }) => ({
      slug, name, version, retainedVersion, filename, sha256, integrity, size,
    })),
  };
  writeFileSync(join(bundleDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  for (const { record, decision } of plans) {
    const currentHashes = computeHashes(readFileSync(record.archivePath));
    if (currentHashes.sha256 !== record.sha256 || currentHashes.integrity !== record.integrity) {
      throw new Error(`packed_tarball_mutated: ${record.name} changed before upload`);
    }
    if (decision.action === 'skip') {
      console.log(`⏭ ${record.name}@${record.version} already on npm with matching integrity (${record.integrity}); skipping`);
      continue;
    }
    console.log(`📦 Publishing ${record.name}@${record.version} (${record.filename}, sha256=${record.sha256}) to latest via OIDC...`);
    runNpm([
      'publish',
      record.archivePath,
      '--access=public',
      '--ignore-scripts',
      '--tag=latest',
      `--registry=${REGISTRY}`,
    ], { cwd: bundleDir });
    await verifyRegistryPublicationReadback({
      packageName: record.name,
      version: record.version,
      expectedIntegrity: record.integrity,
      expectedDistTag: 'latest',
      fetchRecord,
      pollAttempts,
      pollDelayMs,
    });
    console.log(`✓ Published and verified ${record.name}@${record.version} on latest (${record.integrity})`);
  }
  return manifest;
}

const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const args = process.argv.slice(2);
  if (args.includes('--verify-only')) {
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const verified = verifyStableTagAndManifests({
      repoRoot,
      githubRepository: process.env.GITHUB_REPOSITORY,
      githubRef: process.env.GITHUB_REF,
      githubSha: process.env.GITHUB_SHA,
      headSha,
      expectedTag: process.env.EXPECTED_TAG || '',
      expectedTargetSha: process.env.EXPECTED_TAG_SHA || '',
      ghApiJson: defaultGhApiJson,
      verifyEnvironment: true,
    });
    console.log(`✓ Pre-OIDC stable release gate verified ${verified.tag} at ${verified.sourceSha}`);
  } else {
    const bundleDir = args[0] ? resolve(args[0]) : resolve(process.env.RUNNER_TEMP || '/tmp', 'oss-npm-stable-release');
    if (existsSync(bundleDir)) {
      throw new Error(`Bundle directory already exists: ${bundleDir}`);
    }
    publishStableOssRelease({ repoRoot, bundleDir }).catch((err) => {
      console.error(`❌ Stable OSS OIDC publish failed: ${err?.message || err}`);
      process.exit(1);
    });
  }
}
