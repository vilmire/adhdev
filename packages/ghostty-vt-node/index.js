const fs = require('node:fs');
const path = require('node:path');

const ADDON_FILE = 'ghostty_vt_node.node';
const { orderPrebuiltTriplets } = require('./binding-candidates.js');
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
//   3. same-`platform-arch` prebuilts ranked by manifest apiLevel (highest
//      first), exact ABI as tie-breaker (see binding-candidates.js).
// Not preferring the exact ABI is deliberate: stale API-level-1 binaries for
// ABI 115/127 once shadowed the current API-level-2 build. This is what makes a brand-new Node ABI (e.g. a future node26) work without
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

function readManifestApiLevel(name) {
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(PREBUILT_ROOT, name, 'manifest.json'), 'utf8'));
        return Number.isFinite(manifest.apiLevel) ? manifest.apiLevel : 0;
    } catch {
        return 0;
    }
}

// Selection rule (see binding-candidates.js): among same platform-arch
// prebuilts the highest manifest apiLevel wins, then the exact running ABI.
// Foreign-platform dirs are a last-resort test-isolation fallback (requiring a
// foreign-OS `.node` throws and is skipped; it matters only for suites that
// mock process.platform).
//
// A locally compiled build/ output is tried before the prebuilts, but only
// accepted if it reports apiLevel >= the best prebuilt manifest level — a stale
// build/ directory must not shadow a newer prebuilt. A rejected build is kept
// as the very last resort.
function loadBinding() {
    const abi = process.versions.modules;
    const explicitPrebuiltDir = process.env.ADHDEV_GHOSTTY_VT_PREBUILT_DIR
        ? path.resolve(process.env.ADHDEV_GHOSTTY_VT_PREBUILT_DIR)
        : null;
    const triplet = getTriplet();
    const ordered = orderPrebuiltTriplets({
        names: listAvailablePrebuiltTriplets(),
        platform: process.platform,
        arch: process.arch,
        abi,
        readApiLevel: readManifestApiLevel,
    });
    const prebuiltFile = (name) => path.join(PREBUILT_ROOT, name, ADDON_FILE);

    // { file, minApiLevel } — minApiLevel > 0 means "verify after load".
    const candidates = [
        explicitPrebuiltDir ? { file: path.join(explicitPrebuiltDir, triplet, ADDON_FILE) } : null,
        explicitPrebuiltDir ? { file: path.join(explicitPrebuiltDir, ADDON_FILE) } : null,
        { file: path.join(__dirname, 'build', 'Release', ADDON_FILE), minApiLevel: ordered.bestApiLevel },
        { file: path.join(__dirname, 'build', 'Debug', ADDON_FILE), minApiLevel: ordered.bestApiLevel },
        ...ordered.samePlatform.map((name) => ({ file: prebuiltFile(name) })),
        ...ordered.otherPlatform.map((name) => ({ file: prebuiltFile(name) })),
    ].filter(Boolean);

    const errors = [];
    const rejected = [];
    for (const candidate of candidates) {
        try {
            const loaded = require(candidate.file);
            if (candidate.minApiLevel) {
                const level = describeBinding(loaded).apiLevel;
                if (level < candidate.minApiLevel) {
                    errors.push(`${candidate.file}: apiLevel ${level} < best prebuilt ${candidate.minApiLevel}`);
                    rejected.push(loaded);
                    continue;
                }
            }
            return loaded;
        } catch (error) {
            errors.push(`${candidate.file}: ${error && error.message ? error.message : String(error)}`);
        }
    }
    if (rejected.length) return rejected[0];

    const available = listAvailablePrebuiltTriplets();
    throw new Error(
        `Unable to load @adhdev/ghostty-vt-node native binding for running triplet "${triplet}". ` +
            `Available prebuilt triplets: [${available.join(', ') || 'none'}]. ` +
            `Provide a prebuilt via ADHDEV_GHOSTTY_VT_PREBUILT_DIR or build it with ` +
            `"npm run build -w oss/packages/ghostty-vt-node". Attempts: ${errors.join(' | ')}`,
    );
}

// Surface added at API level 2. A binary built before it (an older prebuilt or
// a stale build/ output that shadows the prebuilt) still loads and still
// serves the legacy methods; it simply lacks these. Consumers feature-detect
// via `capabilities.viewport` (or `typeof handle.getViewport === 'function'`)
// and must treat the exact-read path as unavailable rather than falling back
// to formatter output.
const VIEWPORT_METHODS = ['getViewport', 'readRow', 'scrollViewport'];

function describeBinding(binding) {
    if (typeof binding.getBindingInfo === 'function') {
        const info = binding.getBindingInfo();
        return {
            apiLevel: info.apiLevel,
            sourceDigest: info.sourceDigest || null,
            ghosttyRevision: info.ghosttyRevision || null,
            napiVersion: info.napiVersion ?? null,
        };
    }
    return { apiLevel: 1, sourceDigest: null, ghosttyRevision: null, napiVersion: null };
}

function probeViewportSupport(binding, info) {
    if (info.apiLevel < 2 || typeof binding.createTerminal !== 'function') return false;
    let terminal;
    try {
        terminal = binding.createTerminal({ cols: 1, rows: 1, scrollback: 0 });
        return VIEWPORT_METHODS.every((name) => typeof terminal[name] === 'function');
    } catch {
        return false;
    } finally {
        try { terminal?.dispose(); } catch { /* best effort */ }
    }
}

const binding = loadBinding();
const bindingInfo = describeBinding(binding);
binding.bindingInfo = bindingInfo;
binding.capabilities = Object.freeze({ viewport: probeViewportSupport(binding, bindingInfo) });

module.exports = binding;
