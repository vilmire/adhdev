import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');
const sourceRoot = path.resolve(packageDir, '..', 'session-host-daemon', 'dist');
const targetRoot = path.join(packageDir, 'vendor', 'session-host-daemon');

function copyRecursive(source, target) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyRecursive(path.join(source, entry), path.join(target, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

if (!fs.existsSync(sourceRoot)) {
  console.error(`session-host-daemon dist not found at ${sourceRoot}`);
  process.exit(1);
}

fs.rmSync(targetRoot, { recursive: true, force: true });
copyRecursive(sourceRoot, targetRoot);
console.log(`vendored session-host-daemon dist -> ${targetRoot}`);

// ── MCP Server ──
const mcpPackageDir = path.resolve(packageDir, '..', 'mcp-server');
const mcpSourceRoot = path.join(mcpPackageDir, 'dist');
const mcpTargetRoot = path.join(packageDir, 'vendor', 'mcp-server');

// BUILD-ORDER GUARD: this script only COPIES mcp-server/dist. It has no idea whether
// that dist matches mcp-server/src, so running it against a stale dist silently rewrites
// the committed vendor bundle backwards — dropping whatever symbols were added since the
// dist was last built — while still printing "vendored ... -> ..." as if it succeeded.
// That is a real regression we hit: a vendor copy reverted by ~270 lines, losing
// cleanup_worktree_nodes / slimTurnPresentation, with the source still containing both.
//
// Callers that build mcp-server first (check-vendor-drift.mjs, prepublishOnly, the
// vendor pre-commit hook) were always safe; a bare `npm run bundle:vendor` was not.
// Rather than depend on every caller remembering the order, make the order intrinsic:
// if dist is missing or older than any tracked source file, rebuild it here.
function newestMtimeMs(dir) {
  let newest = 0;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const { mtimeMs } = fs.statSync(full);
      if (mtimeMs > newest) newest = mtimeMs;
    }
  };
  walk(dir);
  return newest;
}

function mcpServerDistIsStale() {
  const srcDir = path.join(mcpPackageDir, 'src');
  if (!fs.existsSync(srcDir)) return false; // no source to compare against → nothing to assert
  if (!fs.existsSync(mcpSourceRoot)) return true; // never built
  try {
    return newestMtimeMs(srcDir) > newestMtimeMs(mcpSourceRoot);
  } catch {
    return true; // unreadable → rebuild rather than vendor something unverified
  }
}

if (fs.existsSync(path.join(mcpPackageDir, 'package.json')) && mcpServerDistIsStale()) {
  console.log('mcp-server dist is stale (or missing) — rebuilding before vendoring...');
  try {
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
      cwd: mcpPackageDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  } catch (err) {
    // Fail loudly. Copying a known-stale dist is exactly the silent regression this
    // guard exists to prevent, so refuse rather than vendor bytes we cannot trust.
    console.error(
      '\n✗ mcp-server dist is stale and rebuilding it failed.\n' +
      '  Vendoring the stale dist would silently revert vendor/mcp-server.\n' +
      '  Fix the mcp-server build, then re-run bundle:vendor.\n',
    );
    console.error(String(err?.message || err));
    process.exit(1);
  }
}

if (fs.existsSync(mcpSourceRoot)) {
  fs.rmSync(mcpTargetRoot, { recursive: true, force: true });
  copyRecursive(mcpSourceRoot, mcpTargetRoot);
  // Write a MINIMAL manifest — do NOT copy mcp-server's real package.json.
  //
  // ★It must not carry a `version` field. This directory is committed and a drift
  // gate diffs it against HEAD, so any field tracking the release version makes
  // every version bump dirty the vendored copy; version-bump.sh cannot commit that
  // before `npm run ci` runs the gate. That deadlock blocked the 1.0.42 release
  // twice via the bundle's embedded version string, and this file is the same trap
  // by a second path.
  //
  // Copying the real manifest was also simply wrong: it advertised `main` and
  // `bin` pointing at `dist/index.js`, which does not exist here — the vendored
  // entry is `index.js` beside it. Nothing reads this file (the sole consumer,
  // src/index.ts, resolves vendor/mcp-server/index.js directly); it exists so the
  // directory is a well-formed package. This mirrors the synthesized manifest the
  // daemon-cloud vendorer already writes.
  fs.writeFileSync(
    path.join(mcpTargetRoot, 'package.json'),
    JSON.stringify({
      name: '@adhdev/mcp-server',
      private: true,
      main: './index.js',
    }, null, 2),
  );
  console.log(`vendored mcp-server dist -> ${mcpTargetRoot}`);
} else {
  console.warn(`⚠ mcp-server dist not found at ${mcpSourceRoot}, skipping`);
}
