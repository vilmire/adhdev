#!/usr/bin/env node
/**
 * Guarded OIDC Trusted Publishing helper for OSS preview RC releases (`oss/.github/workflows/publish-preview.yml`).
 *
 * Addresses R1, R3, R4, R5, R7:
 *   - Runs inside `vilmire/adhdev` (`oss`), where every OSS package's `repository.url`
 *     (`https://github.com/vilmire/adhdev.git`) matches the GitHub Actions OIDC publisher repository.
 *   - Enforces active protected environment verification (`R4`): `repos/vilmire/adhdev/environments/npm-preview`
 *     must have `can_admins_bypass === false`, required reviewer `User: vilmire` (`id: 5513793`), and custom branch policy `main`.
 *   - Temporarily pins the selected OSS preview packages (`@adhdev/ghostty-vt-node`, `@adhdev/mesh-shared`,
 *     `@adhdev/session-host-core`, `@adhdev/daemon-core`, plus `@adhdev/daemon-standalone` when selected)
 *     to `--preview-version X.Y.Z-rc.N` and pins their sibling `@adhdev/*` dependencies to `X.Y.Z-rc.N`.
 *   - Builds all OSS workspace dependencies with `ADHDEV_BUILD_CHANNEL=preview`, packs immutable `.tgz` archives
 *     with `--ignore-scripts` (`chmod 0o400`), and runs full frozen-tarball gates BEFORE the first upload (`R5`):
 *       1. Archive structure & member inventory validation (`npmArchiveFiles` USTAR/gzip parser, bin presence,
 *          no `file:`/`link:`/`workspace:` dependencies, exact sibling RC pin)
 *       2. Full archive member prescan (every filename, UTF-8/NUL-stripped/UTF-16LE/BE content, and decoded `.map`
 *          `sources`/`sourceRoot`/`sourcesContent` scanned for personal paths, hostnames, and secret patterns;
 *          plus exact SHA-256 verification against `--approved-cohort-json` when handed off from Root)
 *       3. Frozen tarball preview channel stamp verification (`assertFrozenOssPreviewStamps` inspects the packed `.tgz`
 *          members directly rather than mutable build folders)
 *       4. Isolated consumer install, bin probe, native addon load (`better-sqlite3`, `node-pty`, `@adhdev/ghostty-vt-node`),
 *          and standalone daemon boot smoke outside the workspace (`checkFrozenOssPreviewCohort`)
 *   - Verifies reviewed-byte idempotency (`dist.integrity` match on HTTP 200 vs 404), waits for registry availability
 *     WITH exact `dist.integrity` verification in dependency order, publishes/tags `next` via OIDC (`npm@11.21.0+`),
 *     and polls post-write registry readback (`verifyRegistryPublicationReadback`) to confirm both `dist.integrity`
 *     and `dist-tags.next === previewVersion` after every CLI exit (`R7`).
 */

import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { findLeaks } from '../packages/daemon-core/src/git/personal-paths.mjs';
import { probeDriverList } from './driver-list-probe.mjs';
import {
  EXPECTED_REPO,
  EXPECTED_REPO_URL,
  REGISTRY,
  computeHashes,
  sanitizeOidcPublishEnv,
  assertOidcAmbientCredentials,
  fetchRegistryVersionRecord,
  verifyProtectedEnvironmentGate,
  verifyRegistryPublicationReadback,
  defaultGhApiJson,
} from './publish-stable-npm.mjs';

export const PREVIEW_VERSION_RE = /^\d+\.\d+\.\d+-rc\.\d+$/;
export const EXPECTED_PREVIEW_ENVIRONMENT = 'npm-preview';
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

const SECRET_PATTERNS = [
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/,
  /\b(?:npm_[A-Za-z0-9]{36,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/,
  /\b(?:sk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{24,}|AIza[A-Za-z0-9_-]{35}|xox[baprs]-[A-Za-z0-9-]{24,})\b/,
  /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/,
  /(?:["']?[A-Za-z0-9_]*(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)[A-Za-z0-9_]*["']?\s*[:=]\s*["'])[A-Za-z0-9_+/=-]{24,}["']/i,
  /(?:^|[\s"'/:])(?:_authToken|_auth|aws_secret_access_key)\s*[:=]\s*["']?[A-Za-z0-9_+./=-]{24,}/im,
  /\bBearer\s+[A-Za-z0-9_.+/=-]{24,}/i,
];

const FATAL_BOOT_PATTERNS = [
  /\[DAEMON-CRASH\]/,
  /\b(?:uncaughtException|unhandledRejection)\b/,
  /Cannot assign to read only property|object is not extensible|Cannot redefine property/,
  /Cannot find module|ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM|ERR_PACKAGE_PATH_NOT_EXPORTED/,
  /^Fatal error:/m,
];

const safeArchivePath = (name) => /^package\//.test(name)
  && !/[\\\x00-\x1f\x7f]/.test(name)
  && name.split('/').every((part) => part && part !== '.' && part !== '..');
const headerString = (header, start, end) => header.subarray(start, end).toString('utf8').split('\0')[0];

export function parseNpmArchiveFiles(bytes, { onMetadata = () => {} } = {}) {
  const fail = () => { throw new Error('release_archive_invalid'); };
  const archive = gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 });
  const files = new Map();
  let extended = {};
  let ended = false;
  for (let offset = 0; offset < archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.length !== 512) fail();
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      if (offset + 512 > archive.length || !archive.subarray(offset).every((byte) => byte === 0) || Object.keys(extended).length) fail();
      ended = true;
      break;
    }
    onMetadata(header);
    const octal = (start, end) => {
      const value = headerString(header, start, end).trim();
      if (!/^[0-7]+$/.test(value)) fail();
      const number = Number.parseInt(value, 8);
      if (!Number.isSafeInteger(number)) fail();
      return number;
    };
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== octal(148, 156) || headerString(header, 257, 263) !== 'ustar') fail();
    const size = octal(124, 136);
    const type = String.fromCharCode(header[156]);
    if (offset + Math.ceil(size / 512) * 512 > archive.length) fail();
    const content = archive.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (type === 'x') {
      onMetadata(content);
      if (Object.keys(extended).length) fail();
      for (let cursor = 0; cursor < content.length;) {
        const space = content.indexOf(32, cursor);
        const lengthText = content.subarray(cursor, space).toString();
        if (space < cursor || !/^[1-9][0-9]*$/.test(lengthText)) fail();
        const length = Number(lengthText);
        const end = cursor + length;
        if (!Number.isSafeInteger(end) || end > content.length || end <= space + 1 || content[end - 1] !== 10) fail();
        const record = content.subarray(space + 1, end - 1).toString();
        const equals = record.indexOf('=');
        if (equals < 1) fail();
        const key = record.slice(0, equals);
        if (!['path', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname'].includes(key) || key in extended) fail();
        extended[key] = record.slice(equals + 1);
        cursor = end;
      }
      continue;
    }
    const prefix = headerString(header, 345, 500);
    const name = extended.path ?? `${prefix ? `${prefix}/` : ''}${headerString(header, 0, 100)}`;
    extended = {};
    if (!safeArchivePath(name) || files.has(name) || !['0', '\0'].includes(type) || headerString(header, 157, 257)) fail();
    files.set(name, content);
  }
  if (!ended || files.size === 0 || !files.has('package/package.json')) fail();
  return files;
}

export function scanOssPreviewArchiveText(text) {
  const input = text.replaceAll('personal-paths-allow: generic-word', '');
  if (findLeaks(input).length > 0 || SECRET_PATTERNS.some((pattern) => pattern.test(input))) {
    throw new Error('release_prescan_finding');
  }
}

export function prescanFrozenOssTarball(bytes, { customScanner = null } = {}) {
  const scanMember = (name, buf) => {
    if (customScanner) {
      customScanner.scan(name, buf);
      return;
    }
    scanOssPreviewArchiveText(name);
    scanOssPreviewArchiveText(buf.toString('utf8'));
    scanOssPreviewArchiveText(buf.toString('utf8').replaceAll('\0', ''));
    scanOssPreviewArchiveText(buf.toString('utf16le'));
    const swapped = Buffer.from(buf.subarray(0, buf.length - (buf.length % 2)));
    scanOssPreviewArchiveText(swapped.swap16().toString('utf16le'));
    if (name.endsWith('.map')) {
      let map;
      try { map = JSON.parse(buf.toString('utf8')); } catch { throw new Error('release_prescan_map_invalid'); }
      const visit = (value) => {
        if (typeof value === 'string') scanOssPreviewArchiveText(value);
        else if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') {
          Object.entries(value).forEach(([k, v]) => {
            scanOssPreviewArchiveText(k);
            visit(v);
          });
        }
      };
      visit(map);
      if (map.version !== 3 || (!Array.isArray(map.sources) && !Array.isArray(map.sections))) {
        throw new Error('release_prescan_map_invalid');
      }
    }
  };

  const members = parseNpmArchiveFiles(bytes, {
    onMetadata: (metaBytes) => scanMember('package/archive-metadata', metaBytes),
  });
  let files = 0;
  let maps = 0;
  for (const [name, content] of members) {
    scanMember(name, content);
    files += 1;
    if (name.endsWith('.map')) maps += 1;
  }
  return { members, files, maps };
}

export function assertFrozenOssPreviewStamps(packedRecords) {
  for (const record of packedRecords) {
    const members = parseNpmArchiveFiles(readFileSync(record.archivePath));
    if (record.slug === 'daemon-core' || record.slug === 'daemon-standalone') {
      const distBytes = members.get('package/dist/index.js');
      if (!distBytes) throw new Error(`release_frozen_dist_missing: ${record.name}`);
      const distText = distBytes.toString('utf8');
      if (distText.includes(EMPTY_BUILD_CHANNEL_STAMP) || !distText.includes(PREVIEW_BUILD_CHANNEL_STAMP)) {
        throw new Error(`release_frozen_preview_stamp_missing: ${record.name}`);
      }
    }
    if (record.slug === 'daemon-standalone') {
      const vendorBytes = members.get('package/vendor/mcp-server/index.js');
      if (!vendorBytes || vendorBytes.toString('utf8').includes(EMPTY_BUILD_CHANNEL_STAMP) || !vendorBytes.toString('utf8').includes(PREVIEW_BUILD_CHANNEL_STAMP)) {
        throw new Error(`release_frozen_vendor_preview_stamp_missing: ${record.name}`);
      }
    }
  }
}

const FULL_PREVIEW_COHORT_NAMES = [
  '@adhdev/ghostty-vt-node',
  '@adhdev/mesh-shared',
  '@adhdev/session-host-core',
  '@adhdev/daemon-core',
  'adhdev',
];

export function verifyApprovedCohortDigests(packedRecords, approvedCohort, { previewVersion = '', ossSha = '', rootSha = '' } = {}) {
  if (!approvedCohort || typeof approvedCohort !== 'object') {
    throw new Error('approved_cohort_manifest_required: OSS preview OIDC publish requires a pre-validated approved_cohort_json manifest from the full frozen cohort gate');
  }
  if (!approvedCohort.version || !/^\d+\.\d+\.\d+-rc\.\d+$/.test(String(approvedCohort.version))) {
    throw new Error(`approved_cohort_version_missing: approved cohort manifest must declare an exact X.Y.Z-rc.N version (got ${approvedCohort.version || '<unset>'})`);
  }
  if (previewVersion && approvedCohort.version !== previewVersion) {
    throw new Error(`approved_cohort_version_mismatch: approved cohort version (${approvedCohort.version}) != previewVersion (${previewVersion})`);
  }
  if (approvedCohort.channel !== 'preview' || approvedCohort.distTag !== 'next') {
    throw new Error(`approved_cohort_channel_mismatch: approved cohort manifest must declare channel="preview" and distTag="next" (got channel=${approvedCohort.channel || '<unset>'}, distTag=${approvedCohort.distTag || '<unset>'})`);
  }
  if (!approvedCohort.rootSha || !/^[0-9a-f]{40}$/.test(String(approvedCohort.rootSha))) {
    throw new Error(`approved_cohort_root_sha_missing: approved cohort manifest must declare 40-hex rootSha (got ${approvedCohort.rootSha || '<unset>'})`);
  }
  if (rootSha && approvedCohort.rootSha !== rootSha) {
    throw new Error(`approved_cohort_root_sha_mismatch: approved cohort rootSha (${approvedCohort.rootSha}) != rootSha (${rootSha})`);
  }
  if (!approvedCohort.ossSha || !/^[0-9a-f]{40}$/.test(String(approvedCohort.ossSha))) {
    throw new Error(`approved_cohort_oss_sha_missing: approved cohort manifest must declare 40-hex ossSha (got ${approvedCohort.ossSha || '<unset>'})`);
  }
  if (ossSha && approvedCohort.ossSha !== ossSha) {
    throw new Error(`approved_cohort_oss_sha_mismatch: approved cohort ossSha (${approvedCohort.ossSha}) != headSha (${ossSha})`);
  }
  const approvedMap = new Map();
  const list = Array.isArray(approvedCohort.artifacts) ? approvedCohort.artifacts
    : Array.isArray(approvedCohort.packages) ? approvedCohort.packages : [];
  for (const item of list) {
    if (
      !item?.name
      || !/^[0-9a-f]{64}$/.test(String(item?.sha256 ?? ''))
      || !/^sha512-[A-Za-z0-9+/=]+$/.test(String(item?.integrity ?? ''))
    ) {
      throw new Error(`approved_cohort_entry_invalid: every package in approved_cohort_json must declare name, 64-hex sha256, and sha512- integrity (got ${JSON.stringify(item)})`);
    }
    approvedMap.set(item.name, item);
  }
  if (approvedMap.size === 0) {
    throw new Error('approved_cohort_manifest_empty: approved_cohort_json contains no package digests');
  }
  for (const requiredPkg of FULL_PREVIEW_COHORT_NAMES) {
    if (!approvedMap.has(requiredPkg)) {
      throw new Error(`approved_cohort_incomplete: approved cohort manifest must bind the complete preview cohort including ${requiredPkg}`);
    }
  }
  for (const record of packedRecords) {
    const expected = approvedMap.get(record.name);
    if (!expected) {
      throw new Error(`approved_cohort_missing_package: ${record.name} is missing from approved cohort manifest`);
    }
    if (expected.sha256 !== record.sha256) {
      throw new Error(
        `approved_cohort_sha256_mismatch: ${record.name} packed sha256 (${record.sha256}) does not match approved cohort sha256 (${expected.sha256})`,
      );
    }
    if (expected.integrity !== record.integrity) {
      throw new Error(
        `approved_cohort_integrity_mismatch: ${record.name} packed integrity (${record.integrity}) does not match approved cohort integrity (${expected.integrity})`,
      );
    }
  }
}

async function allocateEphemeralPort() {
  return await new Promise((resolvePort, rejectPort) => {
    const srv = createNetServer();
    srv.once('error', rejectPort);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? rejectPort(err) : resolvePort(port)));
    });
  });
}

async function bootSmokeStandaloneCli(standaloneCli, childEnv, { readyTimeoutMs = 45_000, holdMs = 3_000 } = {}) {
  const port = await allocateEphemeralPort();
  const proc = spawn(process.execPath, [standaloneCli, '--port', String(port), '--host', '127.0.0.1', '--no-open'], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
  proc.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });

  const checkFatal = () => {
    for (const re of FATAL_BOOT_PATTERNS) {
      if (re.test(output)) {
        throw new Error(`standalone_boot_smoke_fatal: matched ${re} in output:\n${output.slice(-1200)}`);
      }
    }
  };

  try {
    const deadline = Date.now() + readyTimeoutMs;
    let ready = false;
    while (Date.now() < deadline) {
      checkFatal();
      if (proc.exitCode !== null) {
        throw new Error(`standalone_boot_smoke_early_exit: exited with ${proc.exitCode}\n${output.slice(-1200)}`);
      }
      if (/ADHDev Standalone Server/.test(output)) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`);
          if (res.ok) {
            ready = true;
            break;
          }
        } catch {
          // wait for HTTP listener
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!ready) {
      throw new Error(`standalone_boot_smoke_timeout: standalone daemon did not become ready within ${readyTimeoutMs}ms\n${output.slice(-1200)}`);
    }
    await probeDriverList({
      baseUrl: `http://127.0.0.1:${port}`,
      label: 'standalone-preview-consumer',
    });
    await new Promise((r) => setTimeout(r, holdMs));
    checkFatal();
    if (proc.exitCode !== null) {
      throw new Error(`standalone_boot_smoke_died_during_hold: exited with ${proc.exitCode}`);
    }
  } finally {
    if (proc.exitCode === null) {
      proc.kill('SIGTERM');
      await new Promise((r) => {
        const timer = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
          r();
        }, 10_000);
        proc.once('exit', () => {
          clearTimeout(timer);
          r();
        });
      });
    }
  }
}

export async function checkFrozenOssPreviewCohort({
  repoRoot,
  packedRecords,
  previewVersion,
  execNpm = (args, opts) => execFileSync('npm', args, opts),
  bootSmokeFn = bootSmokeStandaloneCli,
}) {
  // Verify frozen hashes have not mutated
  for (const record of packedRecords) {
    const current = computeHashes(readFileSync(record.archivePath));
    if (current.sha256 !== record.sha256 || current.integrity !== record.integrity) {
      throw new Error('release_frozen_hash_changed');
    }
  }

  const prefix = mkdtempSync(join(tmpdir(), 'adhdev-oss-frozen-consumer-'));
  const location = relative(realpathSync(repoRoot), realpathSync(prefix));
  if (!isAbsolute(location) && location !== '..' && !location.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    rmSync(prefix, { recursive: true, force: true });
    throw new Error('release_consumer_workspace_escape');
  }

  try {
    const dependencies = Object.fromEntries(packedRecords.map((r) => [r.name, `file:${r.archivePath}`]));
    const overrides = Object.fromEntries(packedRecords.map((r) => [r.name, `$${r.name}`]));
    writeFileSync(
      join(prefix, 'package.json'),
      JSON.stringify({ name: 'oss-preview-consumer-check', private: true, dependencies, overrides }, null, 2),
      'utf8',
    );
    execNpm(['install', '--omit=dev', '--no-audit', '--no-fund', '--workspaces=false'], {
      cwd: prefix,
      env: { ...process.env, npm_config_workspaces: 'false' },
    });

    const childEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('ADHDEV_')
        && !/^(?:NODE_OPTIONS|NODE_PATH|HOME|USERPROFILE|XDG_.*|CODEX_HOME|CLAUDE_CONFIG_DIR)$/.test(key)),
    );
    const home = join(prefix, 'probe-home');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    Object.assign(childEnv, {
      HOME: home,
      USERPROFILE: home,
      ADHDEV_CONFIG_DIR: join(home, 'config'),
      ADHDEV_SKIP_UPDATE_CHECK: '1',
    });

    const runNode = (args, options = {}) => execFileSync(process.execPath, args, {
      cwd: prefix,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      encoding: 'utf8',
      ...options,
    });

    let standaloneCli = null;
    for (const record of packedRecords) {
      const installed = join(prefix, 'node_modules', ...record.name.split('/'));
      if (!realpathSync(installed).startsWith(`${realpathSync(prefix)}/`)) {
        throw new Error('release_consumer_workspace_escape');
      }
      const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
      if (manifest.name !== record.name || manifest.version !== previewVersion) {
        throw new Error('release_consumer_cohort_changed');
      }
      if (record.slug === 'daemon-core') {
        // Verify native dependencies & ghostty-vt-node load from the isolated daemon-core install
        runNode([
          '-e',
          `const r=require('node:module').createRequire(process.argv[1]);const D=r('better-sqlite3');new D(':memory:').close();r('node-pty');r('@adhdev/ghostty-vt-node');r('@adhdev/mesh-shared');r('@adhdev/session-host-core');`,
          join(installed, 'package.json'),
        ]);
      }
      if (manifest.bin) {
        const bins = typeof manifest.bin === 'string' ? [manifest.bin] : [...new Set(Object.values(manifest.bin))];
        for (const binRel of bins) {
          const entry = join(installed, binRel);
          runNode(['-e', 'process.exit(0)', '--require', entry]);
        }
        if (record.slug === 'daemon-standalone') {
          const firstBin = typeof manifest.bin === 'string' ? manifest.bin : Object.values(manifest.bin)[0];
          standaloneCli = join(installed, firstBin);
        }
      }
    }

    if (standaloneCli && bootSmokeFn) {
      await bootSmokeFn(standaloneCli, childEnv);
    }

    for (const record of packedRecords) {
      const current = computeHashes(readFileSync(record.archivePath));
      if (current.sha256 !== record.sha256 || current.integrity !== record.integrity) {
        throw new Error('release_frozen_hash_changed');
      }
    }
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
}

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
  ghApiJson = null,
  verifyEnvironment = false,
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
  if (ghApiJson && verifyEnvironment) {
    verifyProtectedEnvironmentGate({
      repository: EXPECTED_REPO,
      environmentName: EXPECTED_PREVIEW_ENVIRONMENT,
      expectedBranchPolicyType: 'branch',
      expectedBranchPolicyName: 'main',
      ghApiJson,
    });
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
  approvedCohort = null,
  githubRepository = process.env.GITHUB_REPOSITORY,
  githubRef = process.env.GITHUB_REF,
  githubSha = process.env.GITHUB_SHA,
  env = process.env,
  fetchRecord = fetchRegistryVersionRecord,
  execNpm,
  stageBuild,
  customScanner = null,
  consumerGateFn = checkFrozenOssPreviewCohort,
  ghApiJson = defaultGhApiJson,
  verifyEnvironment = Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN),
  pollAttempts = 18,
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
    ghApiJson,
    verifyEnvironment,
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
      const { members } = prescanFrozenOssTarball(bytes, { customScanner });
      const manifest = JSON.parse(members.get('package/package.json').toString('utf8'));
      if (manifest.name !== pkg.name || manifest.version !== previewVersion || manifest.private === true) {
        throw new Error(`release_cohort_identity_invalid: ${pkg.name}`);
      }
      if (Array.isArray(packed.files)) {
        if (packed.files.length !== members.size
          || packed.files.some((f) => !members.has(`package/${f.path}`) || members.get(`package/${f.path}`).length !== f.size)) {
          throw new Error(`release_file_inventory_invalid: ${pkg.name}`);
        }
      }
      for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const [depName, spec] of Object.entries(manifest[field] ?? {})) {
          if (/^(?:file|link|workspace):/.test(spec) || (PREVIEW_PACKAGE_NAMES.has(depName) && spec !== previewVersion)) {
            throw new Error(`release_cohort_dependency_invalid: ${pkg.name} -> ${depName}@${spec}`);
          }
        }
      }
      const bins = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {});
      if (bins.some((b) => !members.has(`package/${b.replace(/^\.\//, '')}`))) {
        throw new Error(`release_cohort_bin_missing: ${pkg.name}`);
      }
      chmodSync(archivePath, 0o400);
      const hashes = computeHashes(bytes);
      packedRecords.push({
        ...pkg,
        version: previewVersion,
        filename: packed.filename,
        archivePath,
        ...hashes,
      });
    }

    // Gate 1: Verify frozen tarball preview stamps directly inside the packed archives (R5)
    assertFrozenOssPreviewStamps(packedRecords);

    // Gate 2: Verify exact SHA-256 / integrity match against approved cohort handoff (R5 — mandatory)
    verifyApprovedCohortDigests(packedRecords, approvedCohort, { previewVersion, ossSha: headSha });

    // Gate 3: Run isolated consumer install, native load, bin probes, and standalone boot smoke BEFORE any upload (R5)
    if (consumerGateFn) {
      await consumerGateFn({
        repoRoot,
        packedRecords,
        previewVersion,
        execNpm: runNpm,
      });
    }

    // Preflight all selected packages for byte-integrity collisions before the first upload.
    const plans = [];
    const byName = new Map(packedRecords.map((r) => [r.name, r]));
    for (const record of packedRecords) {
      const decision = await evaluatePreviewIdempotency(record, { fetchRecord });
      plans.push({ record, decision });
    }

    for (const { record, decision } of plans) {
      for (const prereq of record.prerequisites) {
        const expectedPrereqIntegrity = byName.get(prereq)?.integrity;
        await verifyRegistryPublicationReadback({
          packageName: prereq,
          version: previewVersion,
          expectedIntegrity: expectedPrereqIntegrity,
          expectedDistTag: 'next',
          fetchRecord,
          pollAttempts,
          pollDelayMs,
        });
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

      // Post-write readback gate (R7): CLI exit 0 is not proof; verify exact integrity AND dist-tag next on the registry
      await verifyRegistryPublicationReadback({
        packageName: record.name,
        version: record.version,
        expectedIntegrity: record.integrity,
        expectedDistTag: 'next',
        fetchRecord,
        pollAttempts,
        pollDelayMs,
      });
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
  let approvedCohortJson = process.env.APPROVED_COHORT_JSON || '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--preview-version') previewVersion = argv[++i] ?? '';
    else if (argv[i] === '--npm-package') npmPackage = argv[++i] ?? 'all';
    else if (argv[i] === '--bundle-dir') bundleDir = resolve(argv[++i] ?? '');
    else if (argv[i] === '--approved-cohort-json') approvedCohortJson = argv[++i] ?? '';
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (existsSync(bundleDir)) {
    throw new Error(`Bundle directory already exists: ${bundleDir}`);
  }
  const approvedCohort = approvedCohortJson ? JSON.parse(approvedCohortJson) : null;
  publishOssPreviewRelease({
    repoRoot: resolve(fileURLToPath(new URL('..', import.meta.url))),
    bundleDir,
    previewVersion,
    npmPackage,
    approvedCohort,
  }).catch((err) => {
    console.error(`❌ OSS preview OIDC publish failed: ${err?.message || err}`);
    process.exit(1);
  });
}
