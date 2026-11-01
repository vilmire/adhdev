'use strict';
// Pure candidate-ordering logic for the native binding loader (index.js).
// No native loading happens here so the selection rules are unit-testable with
// fake directory listings.
//
// Selection rule for prebuilt triplet directories of the host platform-arch:
//   1. highest manifest `apiLevel` first (a directory without a readable
//      manifest counts as level 0 — never preferred over a manifest-bearing
//      one, which is how a stale pre-API-2 binary loses to the current one even
//      when its Node ABI number matches the running Node exactly),
//   2. then the exact running ABI (`...-node<abi>`),
//   3. then the higher ABI number, then name, for determinism.
// Foreign platform/arch directories (test-isolation fallback) come last.

function parseAbi(name) {
    const match = /-node(\d+)$/.exec(name);
    return match ? Number(match[1]) : -1;
}

function orderPrebuiltTriplets({ names, platform, arch, abi, readApiLevel }) {
    const prefix = `${platform}-${arch}-`;
    const exact = `${platform}-${arch}-node${abi}`;
    const level = (name) => {
        const value = readApiLevel(name);
        return Number.isFinite(value) ? value : 0;
    };
    const rank = (list) =>
        list
            .map((name) => ({ name, level: level(name), exact: name === exact ? 1 : 0, abi: parseAbi(name) }))
            .sort((a, b) => b.level - a.level || b.exact - a.exact || b.abi - a.abi || a.name.localeCompare(b.name));
    const same = names.filter((name) => name.startsWith(prefix));
    const other = names.filter((name) => !name.startsWith(prefix));
    return {
        samePlatform: rank(same).map((entry) => entry.name),
        bestApiLevel: same.length ? Math.max(...same.map(level)) : 0,
        otherPlatform: other.slice().sort(),
    };
}

module.exports = { orderPrebuiltTriplets };
