#!/usr/bin/env node
/**
 * Guarded OIDC Trusted Publishing helper for OSS preview RC releases (`oss/.github/workflows/publish-preview.yml`).
 *
 * Addresses R1, R3, R4:
 *   - Runs inside `vilmire/adhdev` (`oss`), where every OSS package's `repository.url`
 *     (`https://github.com/vilmire/adhdev.git`) matches the GitHub Actions OIDC publisher repository.
 *   - Temporarily pins the selected OSS preview packages (`@adhdev/ghostty-vt-node`, `@adhdev/mesh-shared`,
 *     `@adhdev/session-host-core`, `@adhdev/daemon-core`, plus `@adhdev/daemon-standalone` when selected)
 *     to `--preview-version X.Y.Z-rc.N` and pins their sibling `@adhdev/*` dependencies to `X.Y.Z-rc.N`.
 *   - Builds all OSS workspace dependencies with `ADHDEV_BUILD_CHANNEL=preview`, verifies preview channel stamps
 *     in `daemon-core` and `daemon-standalone` (including `vendor/mcp-server`), packs immutable `.tgz` archives
 *     with `--ignore-scripts`, verifies reviewed-byte idempotency (`dist.integrity` match on HTTP 200 vs 404),
 *     waits for registry availability in dependency order (`ghostty-vt-node`, `mesh-shared`, `session-host-core`
 *     before `daemon-core` and `daemon-standalone`), and publishes/tags `next` via OIDC (`npm@11.21.0+`).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPECTED_REPO,
  EXPECTED_REPO_URL,
  REGISTRY,
  computeHashes,
  sanitizeOidcPublishEnv,
  assertOidcAmbientCredentials,
  fetchRegistryVersionRecord,
} from './publish-stable-npm.mjs';

export const PREVIEW_VERSION_RE = /^\d+\.\d+\.\d+-rc\.\d+$/;
export const OSS_PREVIEW_COHORT = Object.freeze([
  { slug: 'ghostty-vt-node', name: '@adhdev/ghostty-vt-node', dir: 'packages/ghostty-vt-node', prerequisites: [] },
  { slug: 'mesh-shared', name: '@adhdev/mesh-shared', dir: 'packages/mesh-shared', prerequisites: [] },
  { slug: 'session-host-core', name: '@adhdev/session-host-core', dir: 'packages/session-host-core', prerequisites: [] },
  { slug: 'daemon-core', name: '@adhdev/daemon-core', dir: 'packages/daemon-core', prerequisites: ['@adhdev/ghostty-vt-node', '@adhdev/mesh-shared', '@adhdev/session-host-core'] },
  { slug: 'daemon-standalone', name: '@adhdev/daemon-standalone', dir: 'packages/daemon-standalone', prerequisites: ['@adhdev/ghostty-vt-node', '@adhdev/session-host-core', '@adhdev/daemon-core'] },
].map(Object.freeze));

const PREVIEW_PACKAGE_NAMES = new Set(OSS_PREVIEW_COHORT.map((p) => p.name));
const EMPTY_BUILD_CHANNEL_STAMP = 'true ? "" : void 0';
const PREVIEW_BUILD_CHANNEL_STAMP = 'true ? "preview" : void 0';

export function selectOssPreviewPackages(npmPackage = 'all') {
  if (npmPackage === 'all' || npmPackage === 'daemon-core') {
    return OSS_PREVIEW_COHORT.filter((p) => p.slug !== 'daemon-standalone');
  }
  if (npmPackage === 'standalone') {
    return [...OSS_PREVIEW_COHORT];
  }
  throw new Error(`invalid_oss_npm_package: expected all|daemon-core|standalone, got ${npmPackage}`);
}

export function verifyOssPreviewSourceAndManifests({
  repoRoot,
  githubRepository,
  githubRef,
  githubSha,
  headSha,
  previewVersion,
}) {
  if (githubRepository !== EXPECTED_REPO) {
    throw new Error(`unauthorized_repository: expected ${EXPECTED_REPO}, got ${githubRepository || '<unset>'}`);
  }
  if (githubRef !== 'refs/heads/main') {
    throw new Error(`unauthorized_ref: preview publish requires refs/heads/main, got ${githubRef || '<unset>'}`);
  }
  if (!githubSha || !/^[0-9a-f]{40}$/.test(githubSha) || headSha !== githubSha) {
    throw new Error(`source_sha_mismatch: checkout HEAD (${headSha}) does not match GITHUB_SHA (${githubSha})`);
  }
  if (!PREVIEW_VERSION_RE.test(String(previewVersion ?? ''))) {
    throw new Error(`invalid_preview_version: expected X.Y.Z-rc.N, got ${previewVersion || '<unset>'}`);
  }
  for (const entry of OSS_PREVIEW_COHORT) {
    const pkg = JSON.parse(readFileSync(join(repoRoot, entry.dir, 'package.json'), 'utf8'));
    if (pkg.name !== entry.name || pkg.private === true) {
      throw new Error(`manifest_identity_invalid: ${entry.dir}`);
    }
    const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    if (repoUrl !== EXPECTED_REPO_URL) {
      throw new Error(`repository_url_mismatch: ${entry.name} repository.url is "${repoUrl}", expected "${EXPECTED_REPO_URL}"`);
    }
  }
  return { previewVersion, sourceSha: headSha };
}

export async function withPinnedOssPreviewManifests(repoRoot, previewVersion, callback) {
  const backups = new Map();
  try {
    for (const entry of OSS_PREVIEW_COHORT) {
      const path = join(repoRoot, entry.dir, 'package.json');
      const raw = readFileSync(path, 'utf8');
      backups.set(path, raw);
      const pkg = JSON.parse(raw);
      pkg.version = previewVersion;
      for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        const deps = pkg[field];
        if (!deps) continue;
        for (const depName of Object.keys(deps)) {
          if (PREVIEW_PACKAGE_NAMES.has(depName)) {
            deps[depName] = previewVersion;
          }
        }
      }
      writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    }
    return await callback();
  } finally {
    for (const [path, raw] of backups.entries()) {
      writeFileSync(path, raw, 'utf8');
    }
  }
}

export function verifyOssPreviewStamps(repoRoot, includeStandalone) {
  const coreDist = readFileSync(join(repoRoot, 'packages/daemon-core/dist/index.js'), 'utf8');
  if (coreDist.includes(EMPTY_BUILD_CHANNEL_STAMP) || !coreDist.includes(PREVIEW_BUILD_CHANNEL_STAMP)) {
    throw new Error('preview_stamp_missing: packages/daemon-core/dist/index.js');
  }
  if (includeStandalone) {
    const standaloneDist = readFileSync(join(repoRoot, 'packages/daemon-standalone/dist/index.js'), 'utf8');
    const standaloneVendor = readFileSync(join(repoRoot, 'packages/daemon-standalone/vendor/mcp-server/index.js'), 'utf8');
    if (standaloneDist.includes(EMPTY_BUILD_CHANNEL_STAMP) || !standaloneDist.includes(PREVIEW_BUILD_CHANNEL_STAMP)) {
      throw new Error('preview_stamp_missing: packages/daemon-standalone/dist/index.js');
    }
    if (standaloneVendor.includes(EMPTY_BUILD_CHANNEL_STAMP) || !standaloneVendor.includes(PREVIEW_BUILD_CHANNEL_STAMP)) {
      throw new Error('preview_vendor_stamp_missing: packages/daemon-standalone/vendor/mcp-server/index.js');
    }
  }
}

export async function evaluatePreviewIdempotency(record, { fetchRecord = fetchRegistryVersionRecord } = {}) {
  const { name, version, integrity } = record;
  const existing = await fetchRecord(name, version);
  const nextTag = await fetchRecord(name, 'next');
  if (existing !== null) {
    const remoteIntegrity = existing?.dist?.integrity;
    if (remoteIntegrity !== integrity) {
      throw new Error(`registry_bytes_differ: ${name}@${version} already exists on npm with integrity ${remoteIntegrity || '<none>'}, which differs from reviewed local tarball integrity ${integrity}`);
    }
    if (nextTag && nextTag.version === version && nextTag?.dist?.integrity === integrity) {
      return { action: 'skip' };
    }
    return { action: 'dist-tag' };
  }
  return { action: 'publish' };
}

export async function publishOssPreviewRelease({
  repoRoot,
  bundleDir,
  previewVersion,
  npmPackage = 'all',
  githubRepository = process.env.GITHUB_REPOSITORY,
  githubRef = process.env.GITHUB_REF,
  githubSha = process.env.GITHUB_SHA,
  env = process.env,
  fetchRecord = fetchRegistryVersionRecord,
  execNpm,
  stageBuild,
  pollAttempts = 36,
  pollDelayMs = 10_000,
}) {
  assertOidcAmbientCredentials(env);
  const cleanEnv = sanitizeOidcPublishEnv(env);
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  verifyOssPreviewSourceAndManifests({
    repoRoot,
    githubRepository,
    githubRef,
    githubSha,
    headSha,
    previewVersion,
  });
  const selected = selectOssPreviewPackages(npmPackage);
  const includeStandalone = selected.some((p) => p.slug === 'daemon-standalone');
  const runNpm = execNpm ?? ((args, opts = {}) => execFileSync('npm', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
    env: { ...cleanEnv, ADHDEV_BUILD_CHANNEL: 'preview' },
  }));

  return await withPinnedOssPreviewManifests(repoRoot, previewVersion, async () => {
    if (stageBuild) {
      await stageBuild();
    } else {
      runNpm(['install'], { cwd: join(repoRoot, 'vendor/seqscribe') });
      runNpm(['run', 'build'], { cwd: join(repoRoot, 'vendor/seqscribe') });
      for (const ws of [
        'packages/session-host-core',
        'packages/session-host-daemon',
        'packages/terminal-mux-core',
        'packages/terminal-mux-control',
        'packages/terminal-render-web',
        'packages/terminal-mux-cli',
        'packages/mesh-shared',
        'packages/daemon-core',
        'packages/mcp-server',
      ]) {
        runNpm(['run', 'build', '-w', ws], { cwd: repoRoot });
      }
      // Vendor session-host-core into daemon-core (same contract as stable oss/ci.yml)
      const vendorTarget = join(repoRoot, 'packages/daemon-core/node_modules/@adhdev/session-host-core');
      execFileSync('rm', ['-rf', vendorTarget]);
      mkdirSync(vendorTarget, { recursive: true });
      execFileSync('cp', [join(repoRoot, 'packages/session-host-core/package.json'), join(vendorTarget, 'package.json')]);
      execFileSync('cp', ['-R', join(repoRoot, 'packages/session-host-core/dist'), join(vendorTarget, 'dist')]);

      if (includeStandalone) {
        runNpm(['run', 'build', '-w', 'packages/web-core'], { cwd: repoRoot });
        runNpm(['run', 'build', '-w', 'packages/web-standalone'], { cwd: repoRoot });
        runNpm(['run', 'bundle:web', '-w', 'packages/daemon-standalone'], { cwd: repoRoot });
        runNpm(['run', 'bundle:vendor', '-w', 'packages/daemon-standalone'], { cwd: repoRoot });
        runNpm(['run', 'build', '-w', 'packages/daemon-standalone'], { cwd: repoRoot });
      }
      verifyOssPreviewStamps(repoRoot, includeStandalone);
    }

    mkdirSync(bundleDir, { recursive: true, mode: 0o700 });
    const packedRecords = [];
    for (const pkg of selected) {
      const out = runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', bundleDir], {
        cwd: join(repoRoot, pkg.dir),
      });
      let packed;
      try { [packed] = JSON.parse(out); } catch { throw new Error(`pack_json_invalid: ${pkg.name}`); }
      if (!packed?.filename || basename(packed.filename) !== packed.filename || !packed.filename.endsWith('.tgz')) {
        throw new Error(`pack_filename_invalid: ${pkg.name}`);
      }
      const archivePath = join(bundleDir, packed.filename);
      const bytes = readFileSync(archivePath);
      const hashes = computeHashes(bytes);
      packedRecords.push({
        ...pkg,
        version: previewVersion,
        filename: packed.filename,
        archivePath,
        ...hashes,
      });
    }

    // Preflight all selected packages for byte-integrity collisions before the first upload.
    const plans = [];
    for (const record of packedRecords) {
      const decision = await evaluatePreviewIdempotency(record, { fetchRecord });
      plans.push({ record, decision });
    }

    for (const { record, decision } of plans) {
      for (const prereq of record.prerequisites) {
        let ready = false;
        for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
          const rec = await fetchRecord(prereq, previewVersion).catch(() => null);
          if (rec && rec.version === previewVersion) {
            ready = true;
            break;
          }
          if (attempt < pollAttempts && pollDelayMs > 0) {
            await new Promise((r) => setTimeout(r, pollDelayMs));
          }
        }
        if (!ready) {
          throw new Error(`prerequisite_not_resolvable: ${prereq}@${previewVersion} not resolvable before ${record.name}`);
        }
      }

      const currentHashes = computeHashes(readFileSync(record.archivePath));
      if (currentHashes.sha256 !== record.sha256 || currentHashes.integrity !== record.integrity) {
        throw new Error(`packed_tarball_mutated: ${record.name} changed before upload`);
      }

      if (decision.action === 'skip') {
        console.log(`⏭ ${record.name}@${record.version} already on npm next with matching integrity (${record.integrity}); skipping`);
      } else if (decision.action === 'dist-tag') {
        console.log(`🏷 ${record.name}@${record.version} bytes verified on npm; pointing dist-tag next via OIDC...`);
        runNpm(['dist-tag', 'add', `${record.name}@${record.version}`, 'next', `--registry=${REGISTRY}`], { cwd: bundleDir });
      } else {
        console.log(`📦 Publishing ${record.name}@${record.version} (${record.filename}, sha256=${record.sha256}) to next via OIDC...`);
        runNpm([
          'publish',
          record.archivePath,
          '--access=public',
          '--ignore-scripts',
          '--tag=next',
          `--registry=${REGISTRY}`,
        ], { cwd: bundleDir });
      }
    }

    const manifest = {
      previewVersion,
      sourceSha: headSha,
      repository: EXPECTED_REPO,
      registry: REGISTRY,
      distTag: 'next',
      packages: packedRecords.map(({ slug, name, version, filename, sha256, integrity, size }) => ({
        slug, name, version, filename, sha256, integrity, size,
      })),
    };
    writeFileSync(join(bundleDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return manifest;
  });
}

const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  const argv = process.argv.slice(2);
  let previewVersion = '';
  let npmPackage = 'all';
  let bundleDir = resolve(process.env.RUNNER_TEMP || '/tmp', 'oss-npm-preview-release');
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--preview-version') previewVersion = argv[++i] ?? '';
    else if (argv[i] === '--npm-package') npmPackage = argv[++i] ?? 'all';
    else if (argv[i] === '--bundle-dir') bundleDir = resolve(argv[++i] ?? '');
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (existsSync(bundleDir)) {
    throw new Error(`Bundle directory already exists: ${bundleDir}`);
  }
  publishOssPreviewRelease({ repoRoot: resolve(fileURLToPath(new URL('..', import.meta.url))), bundleDir, previewVersion, npmPackage }).catch((err) => {
    console.error(`❌ OSS preview OIDC publish failed: ${err?.message || err}`);
    process.exit(1);
  });
}
