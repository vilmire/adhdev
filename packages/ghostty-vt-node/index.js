const fs = require('node:fs');
const path = require('node:path');

const ADDON_FILE = 'ghostty_vt_node.node';
const PREBUILT_ROOT = path.join(__dirname, 'prebuilt');

function getTriplet() {
    return `${process.platform}-${process.arch}-node${process.versions.modules}`;
}

// The addon is a pure Node-API (N-API) binding (it exports
// `napi_register_module_v1`). N-API is ABI-stable across Node major versions, so
// a single compiled `.node` loads on every Node runtime that supports the N-API
// version it targets — regardless of `process.versions.modules`
// (NODE_MODULE_VERSION / "ABI"). The per-`nodeNNN` prebuilt directories are
// therefore an addressing convenience, not a hard ABI requirement: the binaries
// inside them are byte-identical per platform/arch.
//
// Consequently the loader resolves in three tiers:
//   1. an explicit override dir (ADHDEV_GHOSTTY_VT_PREBUILT_DIR),
//   2. a locally compiled build/ output,
//   3. an exact `platform-arch-nodeABI` prebuilt, and finally
//   4. ANY prebuilt for the same `platform-arch` (N-API portability fallback).
// Tier 4 is what makes a brand-new Node ABI (e.g. a future node26) work without
// shipping a new directory — the previous failure mode where node137 runtimes
// hit "binding unavailable" purely because no `node137` directory existed.

function listAvailablePrebuiltTriplets() {
    try {
        return fs
            .readdirSync(PREBUILT_ROOT, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .filter((name) => fs.existsSync(path.join(PREBUILT_ROOT, name, ADDON_FILE)))
            .sort();
    } catch {
        return [];
    }
}

function samePlatformArchTriplets(triplet) {
    // triplet === `${platform}-${arch}-node${abi}` → prefix is `${platform}-${arch}-`
    const prefix = `${process.platform}-${process.arch}-`;
    return listAvailablePrebuiltTriplets().filter(
        (name) => name.startsWith(prefix) && name !== triplet,
    );
}

// Last-resort: every other installed prebuilt, regardless of platform/arch.
// Requiring a foreign-OS `.node` throws a load error (ELF/PE mismatch,
// "invalid ELF header", "not a valid Win32 application"), which loadBinding()
// simply skips — so this tier is inert on a correctly-addressed runtime. Its
// sole purpose is test isolation: suites that mock `process.platform` (e.g.
// win32 PTY-write / submit driver coverage) corrupt getTriplet() into an
// address for which no loadable binary exists on the CI runner; walking the
// remaining triplets lets the real host binary (the one that actually loads)
// still resolve, instead of the whole ProviderCliAdapter construction throwing.
function otherInstalledTriplets(triplet, alreadyTried) {
    return listAvailablePrebuiltTriplets().filter(
        (name) => name !== triplet && !alreadyTried.has(name),
    );
}

function loadBinding() {
    const triplet = getTriplet();
    const explicitPrebuiltDir = process.env.ADHDEV_GHOSTTY_VT_PREBUILT_DIR
        ? path.resolve(process.env.ADHDEV_GHOSTTY_VT_PREBUILT_DIR)
        : null;

    const candidates = [
        // 1. explicit override
        explicitPrebuiltDir ? path.join(explicitPrebuiltDir, triplet, ADDON_FILE) : null,
        explicitPrebuiltDir ? path.join(explicitPrebuiltDir, ADDON_FILE) : null,
        // 2. locally compiled output
        path.join(__dirname, 'build', 'Release', ADDON_FILE),
        path.join(__dirname, 'build', 'Debug', ADDON_FILE),
        // 3. exact-ABI prebuilt
        path.join(PREBUILT_ROOT, triplet, ADDON_FILE),
        // 4. N-API portability fallback: any same platform-arch prebuilt
        ...samePlatformArchTriplets(triplet).map((name) =>
            path.join(PREBUILT_ROOT, name, ADDON_FILE),
        ),
        // 5. test-isolation fallback: any remaining installed triplet (see
        //    otherInstalledTriplets). Foreign-OS binaries throw on require and
        //    are skipped; the real host binary still resolves under a mocked
        //    process.platform.
        ...otherInstalledTriplets(
            triplet,
            new Set([triplet, ...samePlatformArchTriplets(triplet)]),
        ).map((name) => path.join(PREBUILT_ROOT, name, ADDON_FILE)),
    ].filter(Boolean);

    const errors = [];
    for (const candidate of candidates) {
        try {
            return require(candidate);
        } catch (error) {
            errors.push(`${candidate}: ${error && error.message ? error.message : String(error)}`);
        }
    }

    const available = listAvailablePrebuiltTriplets();
    throw new Error(
        `Unable to load @adhdev/ghostty-vt-node native binding for running triplet "${triplet}". ` +
            `Available prebuilt triplets: [${available.join(', ') || 'none'}]. ` +
            `Provide a prebuilt via ADHDEV_GHOSTTY_VT_PREBUILT_DIR or build it with ` +
            `"npm run build -w oss/packages/ghostty-vt-node". Attempts: ${errors.join(' | ')}`,
    );
}

module.exports = loadBinding();
